import type { Pool, PoolClient } from 'pg';
import { ServerEvent, type AgentMessage } from '@playroom/shared';

export interface RoomRow {
  id: string;
  title: string;
  created_at: string;
}

interface EventRow {
  seq: string; // BIGSERIAL arrives as a string
  room_id: string;
  ts: Date;
  actor_id: string;
  event_type: string;
  payload: unknown;
}

const EVENT_COLS = 'seq, room_id, ts, actor_id, event_type, payload';

/**
 * Resolves `actor_member_id` from the actor id, IN THE INSERT ITSELF.
 *
 * A subquery rather than a value the caller passes, so the column can never disagree with
 * `actor_id` — there is no code path that could set one without the other, and no call site
 * has to remember. It yields NULL when the actor is not a member, which is the honest answer
 * for `system` (the room speaking) and for any string a caller invented.
 *
 * `$N` is the same parameter the row's `actor_id` uses; each call site passes its own index.
 */
const ACTOR_MEMBER = (n: number) => `(SELECT id FROM members WHERE id = $${n})`;

// Build a wire event from a DB row. The stored JSONB payload is the wire payload,
// so we validate the whole thing against the ServerEvent union (never cast).
function rowToServerEvent(row: EventRow): ServerEvent {
  return ServerEvent.parse({
    type: 'event',
    seq: Number(row.seq),
    room_id: row.room_id,
    ts: row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
    actor_id: row.actor_id,
    event_type: row.event_type,
    payload: row.payload,
  });
}

/**
 * Create a room, or return the existing one if the id is already taken (so a stable slug like
 * `demo-room` is safe to POST repeatedly).
 *
 * ── CREATION AND ENROLMENT ARE ONE ACT (S1.3c) ──
 *
 * In a transaction, and this is the first one in the codebase. Two writes that must both happen:
 * a room with no members is UNREACHABLE through the front door S1.3b built — the handshake
 * refuses everyone, the roster read refuses everyone, and the room can never be opened by anybody
 * including the person who just made it. Before this, a failure between the two statements left
 * exactly that: a room nobody could enter and nobody could delete through the product.
 *
 * The creator is enrolled EXPLICITLY rather than as a consequence of being in `members`. That
 * matters the day rooms stop enrolling everyone: the line that keeps a creator out of their own
 * room would otherwise be a deletion nobody notices, and the failure would be a room that opens
 * for the whole roster except its author.
 *
 * A NEW ROOM STILL GETS EVERY CURRENT MEMBER. Not a policy choice — it is what already happens,
 * written down (S1.1b). Narrowing it needs a way to express exceptions, which is invites, which
 * needs an authenticated inviter; that arrived in S1.2 and the invite surface has not. What is
 * new here is only that the creator's own row is guaranteed rather than incidental.
 */
export async function createRoom(
  pool: Pool,
  id: string,
  title: string,
  creator: string,
): Promise<RoomRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query<RoomRow>(
      `INSERT INTO rooms (id, title) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING
       RETURNING id, title, created_at`,
      [id, title],
    );
    await client.query(
      `INSERT INTO room_members (room_id, member_id)
       SELECT $1, m.id FROM members AS m
       ON CONFLICT DO NOTHING`,
      [id],
    );
    // THE CREATOR, NAMED. Redundant while every member is enrolled above, and it is the one row
    // whose absence would make the room unopenable by the person who asked for it.
    await client.query(
      `INSERT INTO room_members (room_id, member_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [id, creator],
    );
    const row =
      inserted.rows[0] ??
      (await client.query<RoomRow>('SELECT id, title, created_at FROM rooms WHERE id = $1', [id]))
        .rows[0];
    await client.query('COMMIT');
    return row;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getRoom(pool: Pool, id: string): Promise<RoomRow | null> {
  const { rows } = await pool.query<RoomRow>(
    'SELECT id, title, created_at FROM rooms WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

export async function lastSeq(pool: Pool, roomId: string): Promise<number> {
  const { rows } = await pool.query<{ last: string }>(
    'SELECT COALESCE(MAX(seq), 0)::bigint AS last FROM events WHERE room_id = $1',
    [roomId],
  );
  return Number(rows[0].last);
}

// Replay: every event in the room past `afterSeq`, in order (messages and agent
// turn events alike, so a streamed turn reassembles on resume).
export async function eventsAfter(
  pool: Pool,
  roomId: string,
  afterSeq: number,
): Promise<ServerEvent[]> {
  const { rows } = await pool.query<EventRow>(
    `SELECT ${EVENT_COLS} FROM events
     WHERE room_id = $1 AND seq > $2
     ORDER BY seq ASC`,
    [roomId, afterSeq],
  );
  return rows.map(rowToServerEvent);
}

// THE ROOM'S COMMON GROUND: the last N chat messages, oldest first. Agent turn events are
// excluded — the agent sees the conversation, not its own event stream (PM7 cap).
//
// This used to be described as "the context handed to an agent", and until S1.5 that was true
// because it was the whole window. It is now ONE PART of §7.1's assembly — the shared part, the
// one that is nobody's private context — and `assembly.ts` is what decides what a turn sees.
// Correcting the comment rather than leaving it: a function whose doc claims a wider role than it
// has is how the next reader concludes there is only one place context comes from.
export async function recentMessages(
  pool: Pool,
  roomId: string,
  limit: number,
): Promise<AgentMessage[]> {
  const { rows } = await pool.query<{ actor_id: string; payload: { body: string } }>(
    `SELECT actor_id, payload FROM events
     WHERE room_id = $1 AND event_type = 'message'
     ORDER BY seq DESC
     LIMIT $2`,
    [roomId, limit],
  );
  return rows.reverse().map((r) => ({ author: r.actor_id, body: r.payload.body }));
}

// The send path's persistence step. Idempotent on (room_id, client_msg_id): a
// duplicate send resolves to the row already committed, returning the same seq.
export async function appendMessage(
  pool: Pool,
  roomId: string,
  actorId: string,
  clientMsgId: string,
  body: string,
): Promise<ServerEvent> {
  const inserted = await pool.query<EventRow>(
    `INSERT INTO events (room_id, actor_id, actor_member_id, event_type, client_msg_id, payload)
     VALUES ($1, $2, ${ACTOR_MEMBER(2)}, 'message', $3, $4)
     ON CONFLICT (room_id, client_msg_id) DO NOTHING
     RETURNING ${EVENT_COLS}`,
    [roomId, actorId, clientMsgId, JSON.stringify({ body })],
  );
  if (inserted.rows[0]) return rowToServerEvent(inserted.rows[0]);
  const existing = await pool.query<EventRow>(
    `SELECT ${EVENT_COLS} FROM events WHERE room_id = $1 AND client_msg_id = $2`,
    [roomId, clientMsgId],
  );
  return rowToServerEvent(existing.rows[0]);
}

// The decision payload, as the fabric produced it. Structurally this can only be
// built from a Verdict (see commands/requestAction.ts) — there is no other constructor
// and no default, so a decision row cannot exist without an evaluation behind it.
export interface DecisionPayload {
  decision_id: string;
  subject: string;
  requested_by: string;
  subject_basis: string;
  principal: string;
  action: string;
  resource: string;
  arguments_hash: string;
  decision: string;
  reason_code: string;
  required_signer: string | null;
  effective_mandate_hash: string | null;
  policy_version: string | null;
}

// Append a decision event. No migration was needed: `payload` is JSONB and
// `event_type` is TEXT, so Bible §9.3's shape lands in the existing log unchanged.
// (Bible §19 also specifies a dedicated `decisions` table — that is S2.1's signed
// authority record, with nonce and consumed_at for replay. This is the room's event
// log, which is what the card reads.)
export async function appendDecision(
  pool: Pool,
  roomId: string,
  actorId: string,
  payload: DecisionPayload,
): Promise<ServerEvent> {
  const { rows } = await pool.query<EventRow>(
    `INSERT INTO events (room_id, actor_id, actor_member_id, event_type, payload)
     VALUES ($1, $2, ${ACTOR_MEMBER(2)}, 'decision', $3)
     RETURNING ${EVENT_COLS}`,
    [roomId, actorId, JSON.stringify(payload)],
  );
  return rowToServerEvent(rows[0]);
}

/**
 * A reference to the summon an agent turn answers.
 *
 * THIS TYPE IS THE ENFORCEMENT. `appendAgentEvent` takes one as a required positional
 * argument, so an agent turn cannot be appended without a summon — a caller that omits
 * it fails to compile rather than writing an orphan row and discovering it in a nightly
 * query. Same discipline as `appendDecision` taking a Verdict: make the invariant a
 * signature, not a convention.
 */
export interface SummonRef {
  summon_id: string;
}

/**
 * A reference to the task an event belongs to (S1.3).
 *
 * Same shape and same reason as `SummonRef`: passed as its own required argument so that
 * "every summon and every turn belongs to a task" is a signature rather than a convention.
 * `events.task_id` is a column, not a payload field, because the question it answers is a
 * query — everything that ever happened to this task, in one indexed read.
 */
export interface TaskRef {
  task_id: string;
}

/**
 * Append the durable record that a member was asked to take a turn.
 *
 * `root_is_human` is decided by the CALLER, at write time, and frozen. Members are not
 * in the database until S1.1, so there is nothing for SQL to resolve a root against —
 * and once written, the judgement reflects the roster as it stood, which is the correct
 * semantics for an append-only log even after the roster changes.
 *
 * RETURNS NULL if this cause has already summoned this member (migration 005's unique
 * index). Null is not an error and not a silent drop: it means the summon exists, so
 * the turn it authorises has already been triggered and must not be triggered again.
 * The caller is expected to branch on it — which is why the return type says so instead
 * of pretending a row came back.
 */
export async function appendSummon(
  pool: Pool,
  roomId: string,
  // THE TASK THIS SUMMON IS WORK ON. Required, same discipline as SummonRef on a turn: a
  // summon exists to authorise work, and work is a task as of S1.3, so a summon that belongs
  // to no task cannot be written rather than being written and going unnoticed.
  task: TaskRef,
  payload: {
    summon_id: string;
    member: string;
    requested_by: string;
    root_actor: string;
    root_is_human: boolean;
    depth: number;
    cause_seq: number;
  },
): Promise<ServerEvent | null> {
  const { rows } = await pool.query<EventRow>(
    `INSERT INTO events
       (room_id, actor_id, actor_member_id, event_type, payload, summon_id, root_is_human, task_id)
     VALUES ($1, $2, ${ACTOR_MEMBER(2)}, 'summon', $3, $4, $5, $6)
     ON CONFLICT (room_id, (payload ->> 'cause_seq'), (payload ->> 'member'))
       WHERE event_type = 'summon'
       DO NOTHING
     RETURNING ${EVENT_COLS}`,
    [
      roomId,
      payload.requested_by,
      JSON.stringify(payload),
      payload.summon_id,
      payload.root_is_human,
      task.task_id,
    ],
  );
  // Deliberately NOT re-fetching and returning the existing row. The only caller needs
  // to know whether it won the insert, and handing back a summon that some earlier frame
  // raised would invite it to trigger a turn against someone else's authorisation.
  return rows[0] ? rowToServerEvent(rows[0]) : null;
}

/**
 * Record which route a member's turn will run on, and why — Bible §6.2.
 *
 * Written from `selectRoute`'s result at the summon construction site, so a route selection
 * cannot exist without a selection having happened. Same discipline as `appendDecision` taking
 * a Verdict.
 */
export async function appendRouteSelected(
  pool: Pool,
  roomId: string,
  task: TaskRef,
  payload: {
    summon_id: string;
    member: string;
    route_id: string;
    route_type: string;
    reason: string;
  },
): Promise<ServerEvent> {
  const { rows } = await pool.query<EventRow>(
    `INSERT INTO events
       (room_id, actor_id, actor_member_id, event_type, payload, summon_id, task_id)
     VALUES ($1, $2, ${ACTOR_MEMBER(2)}, 'route.selected', $3, $4, $5)
     RETURNING ${EVENT_COLS}`,
    [roomId, payload.member, JSON.stringify(payload), payload.summon_id, task.task_id],
  );
  return rowToServerEvent(rows[0]);
}

/**
 * Append a task event — `task.created`, `task.state`, `task.handoff`.
 *
 * The task id goes in the COLUMN as well as the payload. The payload is what a client renders;
 * the column is what makes "everything that happened to this task" one indexed query, including
 * the summon and the turns, which carry it too.
 *
 * `eventType` is a parameter rather than three near-identical functions: every one of these
 * writes exactly the same row shape, and the discrimination that matters happens in the zod
 * union at the wire, which `rowToServerEvent` validates against. A caller inventing
 * `task.whatever` fails there, loudly, on the write.
 */
export async function appendTaskEvent(
  pool: Pool,
  roomId: string,
  actorId: string,
  taskId: string,
  eventType: 'task.created' | 'task.state' | 'task.handoff',
  payload: unknown,
): Promise<ServerEvent> {
  const { rows } = await pool.query<EventRow>(
    `INSERT INTO events (room_id, actor_id, actor_member_id, event_type, payload, task_id)
     VALUES ($1, $2, ${ACTOR_MEMBER(2)}, $3, $4, $5)
     RETURNING ${EVENT_COLS}`,
    [roomId, actorId, eventType, JSON.stringify(payload), taskId],
  );
  return rowToServerEvent(rows[0]);
}

/**
 * Append an interrupt event — `interrupt.raised`, `interrupt.downgraded`.
 *
 * No `interrupt_id` COLUMN, unlike `task_id`. The question a task column answers is "everything
 * that ever happened to this task", including its turns and its summon — rows written by other
 * paths. An interrupt history is only its own two event types, so a payload filter answers it
 * without widening the table for one reader.
 */
export async function appendInterruptEvent(
  pool: Pool,
  roomId: string,
  actorId: string,
  eventType: 'interrupt.raised' | 'interrupt.downgraded',
  payload: unknown,
): Promise<ServerEvent> {
  const { rows } = await pool.query<EventRow>(
    `INSERT INTO events (room_id, actor_id, actor_member_id, event_type, payload)
     VALUES ($1, $2, ${ACTOR_MEMBER(2)}, $3, $4)
     RETURNING ${EVENT_COLS}`,
    [roomId, actorId, eventType, JSON.stringify(payload)],
  );
  return rowToServerEvent(rows[0]);
}

/**
 * The room-visible half of a promotion. Takes a CLIENT, not the pool, deliberately: the record and
 * the copy are one transaction (see promotions.ts), so this has to be able to run inside it.
 */
export async function appendPromotionEvent(
  client: PoolClient,
  roomId: string,
  actorId: string,
  payload: unknown,
): Promise<ServerEvent> {
  const { rows } = await client.query<EventRow>(
    `INSERT INTO events (room_id, actor_id, actor_member_id, event_type, payload)
     VALUES ($1, $2, ${ACTOR_MEMBER(2)}, 'context.promoted', $3)
     RETURNING ${EVENT_COLS}`,
    [roomId, actorId, JSON.stringify(payload)],
  );
  return rowToServerEvent(rows[0]);
}

/** Every event written about one interrupt, in order. */
export async function eventsForInterrupt(pool: Pool, interruptId: string): Promise<ServerEvent[]> {
  const { rows } = await pool.query<EventRow>(
    `SELECT ${EVENT_COLS} FROM events
      WHERE event_type IN ('interrupt.raised', 'interrupt.downgraded')
        AND payload ->> 'interrupt_id' = $1
      ORDER BY seq`,
    [interruptId],
  );
  return rows.map(rowToServerEvent);
}

/** Every event ever written against a task, in order. The history the row is a projection of. */
export async function eventsForTask(pool: Pool, taskId: string): Promise<ServerEvent[]> {
  const { rows } = await pool.query<EventRow>(
    `SELECT ${EVENT_COLS} FROM events WHERE task_id = $1 ORDER BY seq`,
    [taskId],
  );
  return rows.map(rowToServerEvent);
}

// §17 telemetry written on an agent.turn.completed row.
export interface AgentTelemetry {
  adapter_id: string;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  prompt_hash: string | null;
  success: boolean;
  error_class: string | null;
  timings: Record<string, number | null> | null; // §7 first-token spans (S0.3c), observation-only
}

// Append an agent turn event (started/delta/completed). Telemetry columns are set
// on completed; null otherwise. Returns the wire event, ready to fan out.
export async function appendAgentEvent(
  pool: Pool,
  roomId: string,
  actorId: string,
  // REQUIRED, and positioned before the payload so it cannot be quietly forgotten at a
  // call site that passes telemetry. Every agent turn traces to a human summon; this
  // argument is where that stops being a claim.
  summon: SummonRef,
  // The task the turn is work on. Required for the same reason `summon` is — a turn that
  // belongs to no task would be work with no record of what it was for.
  task: TaskRef,
  eventType: string,
  payload: unknown,
  telemetry?: AgentTelemetry,
): Promise<ServerEvent> {
  const t: AgentTelemetry = telemetry ?? {
    adapter_id: null as unknown as string,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    prompt_hash: null,
    success: true,
    error_class: null,
    timings: null,
  };
  const { rows } = await pool.query<EventRow>(
    `INSERT INTO events
       (room_id, actor_id, actor_member_id, event_type, payload, summon_id, task_id,
        adapter_id, tokens_in, tokens_out, cost_usd, latency_ms, prompt_hash, success, error_class, timings)
     VALUES ($1, $2, ${ACTOR_MEMBER(2)}, $3, $4, $5, $15, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING ${EVENT_COLS}`,
    [
      roomId,
      actorId,
      eventType,
      JSON.stringify(payload),
      summon.summon_id,
      t.adapter_id ?? null,
      t.tokens_in,
      t.tokens_out,
      t.cost_usd,
      t.latency_ms,
      t.prompt_hash,
      t.success,
      t.error_class,
      t.timings ? JSON.stringify(t.timings) : null,
      task.task_id,
    ],
  );
  return rowToServerEvent(rows[0]);
}
