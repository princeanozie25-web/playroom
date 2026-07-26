import type { Pool } from 'pg';
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

// Create a room, or return the existing one if the id is already taken (so a
// stable slug like `demo-room` is safe to POST repeatedly).
export async function createRoom(pool: Pool, id: string, title: string): Promise<RoomRow> {
  const inserted = await pool.query<RoomRow>(
    `INSERT INTO rooms (id, title) VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING
     RETURNING id, title, created_at`,
    [id, title],
  );
  if (inserted.rows[0]) return inserted.rows[0];
  const existing = await pool.query<RoomRow>(
    'SELECT id, title, created_at FROM rooms WHERE id = $1',
    [id],
  );
  return existing.rows[0];
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

// The context handed to an agent: the last N chat messages of the room, oldest
// first. Agent turn events are excluded — the agent sees the conversation, not
// its own event stream (PM7 cap; no summaries or principal stores yet).
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
    `INSERT INTO events (room_id, actor_id, event_type, client_msg_id, payload)
     VALUES ($1, $2, 'message', $3, $4)
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
    `INSERT INTO events (room_id, actor_id, event_type, payload)
     VALUES ($1, $2, 'decision', $3)
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
 * Append the durable record that a member was asked to take a turn.
 *
 * `root_is_human` is decided by the CALLER, at write time, and frozen. Members are not
 * in the database until S1.1, so there is nothing for SQL to resolve a root against —
 * and once written, the judgement reflects the roster as it stood, which is the correct
 * semantics for an append-only log even after the roster changes.
 */
export async function appendSummon(
  pool: Pool,
  roomId: string,
  payload: {
    summon_id: string;
    member: string;
    requested_by: string;
    root_actor: string;
    root_is_human: boolean;
    depth: number;
    cause_seq: number;
  },
): Promise<ServerEvent> {
  const { rows } = await pool.query<EventRow>(
    `INSERT INTO events (room_id, actor_id, event_type, payload, summon_id, root_is_human)
     VALUES ($1, $2, 'summon', $3, $4, $5)
     RETURNING ${EVENT_COLS}`,
    [
      roomId,
      payload.requested_by,
      JSON.stringify(payload),
      payload.summon_id,
      payload.root_is_human,
    ],
  );
  return rowToServerEvent(rows[0]);
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
       (room_id, actor_id, event_type, payload, summon_id,
        adapter_id, tokens_in, tokens_out, cost_usd, latency_ms, prompt_hash, success, error_class, timings)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
    ],
  );
  return rowToServerEvent(rows[0]);
}
