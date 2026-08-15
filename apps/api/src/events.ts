import type { Pool, PoolClient } from 'pg';
import { ServerEvent, type AgentMessage } from '@playroom/shared';

export interface RoomRow {
  id: string;
  title: string;
  created_at: string;
  /**
   * THE ROOM'S OWNER (S1.7) — the member who created it, or null for a room that predates the column
   * (migration 026). The one member who may set the room's briefing. Nullable, and a NULL owner is
   * un-briefable rather than owned-by-the-next-asker.
   */
  created_by: string | null;
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
    // `created_by` is the creator, stored so the room has an OWNER (S1.7) — the one member who may set
    // its briefing. On a repeated POST of an existing id the ON CONFLICT DO NOTHING keeps the original
    // owner, so ownership never silently changes hands on a re-create.
    const inserted = await client.query<RoomRow>(
      `INSERT INTO rooms (id, title, created_by) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING
       RETURNING id, title, created_at, created_by`,
      [id, title, creator],
    );
    await client.query(
      // EVERY MEMBER EXCEPT A GUEST'S. The blanket enrolment is unchanged for the members that
      // have always been here; what is excluded is any member acting for a principal flagged
      // `guest` in migration 017.
      //
      // Because the alternative is an open door with a lock painted on it. A guest slot is
      // redeemed by a stranger with a room code, and the code's entire job is to enrol them —
      // if creation enrolled them anyway, they would be a member of every room created after
      // they redeemed, and the code would be decoration. So a guest gets in exactly one way:
      // a redemption that writes the row deliberately.
      //
      // Narrowing this for EVERYONE is the right eventual design and a bigger change than this
      // slice should make: `seed-room.ts` and the film's room both rely on the agents being
      // enrolled by creation, and take 13 is the asset.
      `INSERT INTO room_members (room_id, member_id)
       SELECT $1, m.id
         FROM members AS m
         JOIN principals AS p ON p.id = m.principal_id
        WHERE p.guest = false
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
      (
        await client.query<RoomRow>(
          'SELECT id, title, created_at, created_by FROM rooms WHERE id = $1',
          [id],
        )
      ).rows[0];
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
    'SELECT id, title, created_at, created_by FROM rooms WHERE id = $1',
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

/** History page size — the default a client gets, and the ceiling it cannot exceed (S16b, item 6). */
export const HISTORY_PAGE_DEFAULT = 60;
export const HISTORY_PAGE_MAX = 200;

/**
 * A bounded page of history — the `limit` events with the HIGHEST seq below `before`, oldest-first.
 *
 * The READ SIDE of what the socket already does for the live tail (S16b): the client loads a recent
 * window on open and pages OLDER history on demand, instead of replaying the whole room. This is one
 * page of that — the events just before a cursor, in the same shape the transcript already renders, so
 * a paged-in message is indistinguishable from one that streamed in.
 *
 * `ORDER BY seq DESC LIMIT` takes the page closest to the cursor; the reverse hands it back oldest-first
 * so the caller can prepend it in reading order.
 */
export async function eventsBefore(
  pool: Pool,
  roomId: string,
  before: number,
  limit: number,
): Promise<ServerEvent[]> {
  const { rows } = await pool.query<EventRow>(
    `SELECT ${EVENT_COLS} FROM events
     WHERE room_id = $1 AND seq < $2
     ORDER BY seq DESC
     LIMIT $3`,
    [roomId, before, limit],
  );
  return rows.reverse().map(rowToServerEvent);
}

/** Whether any event precedes `seq` in this room — so a page can tell the client there is more. */
export async function hasEventsBefore(pool: Pool, roomId: string, seq: number): Promise<boolean> {
  const { rows } = await pool.query<{ e: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM events WHERE room_id = $1 AND seq < $2) AS e',
    [roomId, seq],
  );
  return rows[0].e;
}

/**
 * The recent window's FLOOR: the seq the rolling summary covers up to, or 0 when the room has no
 * summary (it is short — the whole room IS the window).
 *
 * This is the ONE number that keeps the client window and the agent's context window the same span
 * (S16b, item 15): assembly reads the messages AFTER this floor (summary.ts), and the client loads the
 * events AFTER this floor. Same floor, same recent span — the client shows exactly what the summary
 * folded up to, never a different one.
 */
export async function roomWindowFloor(pool: Pool, roomId: string): Promise<number> {
  const summary = await latestRoomSummary(pool, roomId);
  return summary?.covers_through_seq ?? 0;
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
  return messagesAfterSeq(pool, roomId, 0, limit);
}

/**
 * The room's messages with `seq > afterSeq`, oldest-first, at most `limit` of them.
 *
 * `recentMessages` is this with `afterSeq = 0`. The generalisation exists for S1.6's assembly: the
 * recent window is the messages AFTER the rolling summary's coverage point, so the summary and the
 * window meet exactly — no gap (a message is in one or the other) and no overlap (never both). The
 * `LIMIT` is a backstop against maintenance falling behind; under steady state the tail is already
 * short and the limit does not bite.
 *
 * Agent turn events stay excluded — the same `event_type = 'message'` filter as before, so common
 * ground is the conversation, not the agents' own event stream (PM7).
 */
export async function messagesAfterSeq(
  pool: Pool,
  roomId: string,
  afterSeq: number,
  limit: number,
): Promise<AgentMessage[]> {
  const { rows } = await pool.query<{ actor_id: string; payload: { body: string } }>(
    `SELECT actor_id, payload FROM events
     WHERE room_id = $1 AND event_type = 'message' AND seq > $2
     ORDER BY seq DESC
     LIMIT $3`,
    [roomId, afterSeq, limit],
  );
  return rows.reverse().map((r) => ({ author: r.actor_id, body: r.payload.body }));
}

/**
 * The recent SUCCESSFUL agent turns in the room — the loop's cycle context (S-LOOP).
 *
 * Agent turn text is excluded from the message window (PM7 / activation barrier 1), which is correct
 * for human-mediated chat: the human re-introduces content on the next message. An unattended loop
 * removes that mediation, so a member reviewing the previous member's draft would otherwise see
 * nothing. This reads the last few completed turns' text so the next summoned member arrives knowing
 * the prior work — as COMMON GROUND (shared, nobody's private), NEVER as a `message` event, so barrier
 * 1 (which keys on event_type) is untouched: this changes what an agent READS, never what triggers a
 * summon, and every action the reader takes is still governed exactly as before.
 */
export async function recentCompletedTurns(
  pool: Pool,
  roomId: string,
  limit: number,
): Promise<AgentMessage[]> {
  const { rows } = await pool.query<{ actor_id: string; payload: { text: string } }>(
    `SELECT actor_id, payload FROM events
     WHERE room_id = $1 AND event_type = 'agent.turn.completed' AND success = true
       AND coalesce(payload ->> 'text', '') <> ''
     ORDER BY seq DESC
     LIMIT $2`,
    [roomId, limit],
  );
  return rows.reverse().map((r) => ({ author: r.actor_id, body: r.payload.text }));
}

/** How many room messages sit after `afterSeq`. The tail length the summariser watches. */
export async function countMessagesAfter(
  pool: Pool,
  roomId: string,
  afterSeq: number,
): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM events
     WHERE room_id = $1 AND event_type = 'message' AND seq > $2`,
    [roomId, afterSeq],
  );
  return Number(rows[0].n);
}

/** One folded message, carrying its seq so the summary knows how far it now reaches. */
export interface MessageForFold {
  seq: number;
  author: string;
  body: string;
}

/**
 * The oldest `limit` messages after `afterSeq`, in order — the batch a maintenance run folds into
 * the summary. Ordered ASC (oldest first) because that is both the order they are summarised in and
 * the order whose LAST element gives the new `covers_through_seq`.
 */
export async function messageBatchAfter(
  pool: Pool,
  roomId: string,
  afterSeq: number,
  limit: number,
): Promise<MessageForFold[]> {
  const { rows } = await pool.query<{ seq: string; actor_id: string; payload: { body: string } }>(
    `SELECT seq, actor_id, payload FROM events
     WHERE room_id = $1 AND event_type = 'message' AND seq > $2
     ORDER BY seq ASC
     LIMIT $3`,
    [roomId, afterSeq, limit],
  );
  return rows.map((r) => ({ seq: Number(r.seq), author: r.actor_id, body: r.payload.body }));
}

/** The current rolling summary of a room, or null if it has none yet (a short room). */
export interface RoomSummary {
  covers_through_seq: number;
  covers_message_count: number;
  text: string;
}

/** The newest `room.summary` event for a room — the current summary. Null when there is none. */
export async function latestRoomSummary(pool: Pool, roomId: string): Promise<RoomSummary | null> {
  const { rows } = await pool.query<{ payload: RoomSummary }>(
    `SELECT payload FROM events
     WHERE room_id = $1 AND event_type = 'room.summary'
     ORDER BY seq DESC
     LIMIT 1`,
    [roomId],
  );
  const p = rows[0]?.payload;
  return p
    ? {
        covers_through_seq: Number(p.covers_through_seq),
        covers_message_count: Number(p.covers_message_count),
        text: p.text,
      }
    : null;
}

/**
 * Append a rolling-summary event, authored by the room itself (`system`).
 *
 * RETURNS NULL if a summary already covers this exact point — migration 019's unique index refused
 * the insert because another maintenance run (a restart mid-fold, a second instance) got there
 * first. Null is not an error: the fold this call was doing is already done, and re-publishing it
 * would put a second summary for one coverage point into a log that is read as a history.
 *
 * The cost lives in BOTH the `cost_usd` column (so the ceiling and the room meter can sum it with
 * one indexed query) and the payload (so the meter can read it off the wire, as a completed turn's
 * cost is). The summariser is a model call and its cost is never hidden (S1.6 item 8).
 */
export async function appendRoomSummary(
  pool: Pool,
  roomId: string,
  payload: {
    summary_id: string;
    covers_through_seq: number;
    covers_message_count: number;
    text: string;
    tokens_in: number | null;
    tokens_out: number | null;
    cost_usd: number | null;
    prompt_hash: string | null;
  },
): Promise<ServerEvent | null> {
  const { rows } = await pool.query<EventRow>(
    // actor_member_id is NULL, not ACTOR_MEMBER(...): the author is `system`, the room speaking,
    // which is exactly the row migration 010's CHECK allows without a member (`actor_id = 'system'`).
    `INSERT INTO events
       (room_id, actor_id, actor_member_id, event_type, payload,
        adapter_id, tokens_in, tokens_out, cost_usd, prompt_hash, success)
     VALUES ($1, 'system', NULL, 'room.summary', $2,
             NULL, $3, $4, $5, $6, true)
     ON CONFLICT (room_id, (payload ->> 'covers_through_seq'))
       WHERE event_type = 'room.summary'
       DO NOTHING
     RETURNING ${EVENT_COLS}`,
    [
      roomId,
      JSON.stringify(payload),
      payload.tokens_in,
      payload.tokens_out,
      payload.cost_usd,
      payload.prompt_hash,
    ],
  );
  return rows[0] ? rowToServerEvent(rows[0]) : null;
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

/**
 * The executable action a PENDING (CO_SIGN) decision holds, so an approval can fire it (S2.2). Present
 * only for an action with an internal executor — a summon (S1.8). See DecisionEvent.pending_action.
 */
export interface PendingSummonAction {
  kind: 'summon.initiate';
  member: string;
  cause_seq: number;
  intent: string;
  root_actor: string;
  root_is_human: boolean;
  depth: number;
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
  /** S2.2: the executable action a CO_SIGN holds. Absent for a ruling with no executor (pr.merge). */
  pending_action?: PendingSummonAction;
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

// ── THE CO-SIGNATURE, COMPLETED (S2.2) ─────────────────────────────────────────────────
//
// A `decision.resolved` event answers a CO_SIGN decision: a human APPROVED or DENIED it. Single-use is
// the database's job, not this function's — migration 020's partial unique index refuses a second
// resolution for one decision_id, so a racing double-approve makes the loser's INSERT throw here
// rather than firing an approved action twice. The signing command catches that as "already resolved".
export interface DecisionResolvedPayload {
  decision_id: string;
  resolution: 'APPROVED' | 'DENIED';
  signed_by: string; // the human member who signed
  signer_principal: string; // the required_signer principal they signed as
}

export async function appendDecisionResolved(
  pool: Pool,
  roomId: string,
  actorId: string,
  payload: DecisionResolvedPayload,
): Promise<ServerEvent> {
  const { rows } = await pool.query<EventRow>(
    `INSERT INTO events (room_id, actor_id, actor_member_id, event_type, payload)
     VALUES ($1, $2, ${ACTOR_MEMBER(2)}, 'decision.resolved', $3)
     RETURNING ${EVENT_COLS}`,
    [roomId, actorId, JSON.stringify(payload)],
  );
  return rowToServerEvent(rows[0]);
}

/** The CO_SIGN decision event with this id, or null. Its payload carries the pending action to fire. */
export async function decisionEventById(
  pool: Pool,
  roomId: string,
  decisionId: string,
): Promise<ServerEvent | null> {
  const { rows } = await pool.query<EventRow>(
    `SELECT ${EVENT_COLS} FROM events
      WHERE room_id = $1 AND event_type = 'decision' AND payload ->> 'decision_id' = $2
      LIMIT 1`,
    [roomId, decisionId],
  );
  return rows[0] ? rowToServerEvent(rows[0]) : null;
}

/** The resolution of this decision, or null if it is still unresolved (PENDING or EXPIRED). */
export async function decisionResolutionEvent(
  pool: Pool,
  roomId: string,
  decisionId: string,
): Promise<ServerEvent | null> {
  const { rows } = await pool.query<EventRow>(
    `SELECT ${EVENT_COLS} FROM events
      WHERE room_id = $1 AND event_type = 'decision.resolved' AND payload ->> 'decision_id' = $2
      LIMIT 1`,
    [roomId, decisionId],
  );
  return rows[0] ? rowToServerEvent(rows[0]) : null;
}

// ── STANDING-ORDER EVENTS (S-LOOP) ──────────────────────────────────────────────────────
//
// The log is the source of truth; the standing_orders row is a projection (migration 021). Every
// transition appends one of these and then updates the row (see orders.ts), so the chip renders from
// the log and the two cannot drift. `actor_id` is the creating/acting human, or 'system' for an
// automatic transition (attendance, budget, error, limit) — nothing changes an order silently.

export interface OrderCreatedPayload {
  order_id: string;
  creator: string;
  trigger_event_type: string;
  trigger_member: string;
  action_member: string;
  max_cycles: number | null;
  max_unattended_cycles: number;
  expires_at: string | null;
  /** What the order is for (S-TASK). Required at creation; the wire type allows its absence only so
   *  rows written before S-TASK still parse. */
  task: string;
}

export async function appendOrderCreated(
  pool: Pool,
  roomId: string,
  actorId: string,
  payload: OrderCreatedPayload,
): Promise<ServerEvent> {
  const { rows } = await pool.query<EventRow>(
    `INSERT INTO events (room_id, actor_id, actor_member_id, event_type, payload)
     VALUES ($1, $2, ${ACTOR_MEMBER(2)}, 'order.created', $3)
     RETURNING ${EVENT_COLS}`,
    [roomId, actorId, JSON.stringify(payload)],
  );
  return rowToServerEvent(rows[0]);
}

export interface OrderStatusPayload {
  order_id: string;
  status: string; // ACTIVE | PAUSED | REVOKED | EXPIRED | LIMIT_REACHED
  reason: string;
  actor: string; // the human who acted, or 'system'
}

export async function appendOrderStatus(
  pool: Pool,
  roomId: string,
  actorId: string,
  payload: OrderStatusPayload,
): Promise<ServerEvent> {
  const { rows } = await pool.query<EventRow>(
    `INSERT INTO events (room_id, actor_id, actor_member_id, event_type, payload)
     VALUES ($1, $2, ${ACTOR_MEMBER(2)}, 'order.status', $3)
     RETURNING ${EVENT_COLS}`,
    [roomId, actorId, JSON.stringify(payload)],
  );
  return rowToServerEvent(rows[0]);
}

export interface OrderTerms {
  max_cycles: number | null;
  max_unattended_cycles: number;
  expires_at: string | null;
}

export interface OrderUpdatedPayload {
  order_id: string;
  before: OrderTerms;
  after: OrderTerms;
  actor: string; // the creator — only a human creator may edit
}

/** An order's editable terms changed (S-UI3), carrying before + after so the log reads the change. */
export async function appendOrderUpdated(
  pool: Pool,
  roomId: string,
  actorId: string,
  payload: OrderUpdatedPayload,
): Promise<ServerEvent> {
  const { rows } = await pool.query<EventRow>(
    `INSERT INTO events (room_id, actor_id, actor_member_id, event_type, payload)
     VALUES ($1, $2, ${ACTOR_MEMBER(2)}, 'order.updated', $3)
     RETURNING ${EVENT_COLS}`,
    [roomId, actorId, JSON.stringify(payload)],
  );
  return rowToServerEvent(rows[0]);
}

export interface OrderCycledPayload {
  order_id: string;
  cycle: number;
  trigger_seq: number;
  member: string;
}

/**
 * Append the record that an order fired a cycle. Written by 'system' (the runner). At most one per
 * (order, trigger_seq) — migration 022's unique index refuses a duplicate, the backstop under the
 * atomic fire guard (orders.tryOpenCycle). Returns null on that conflict, so a racing replay is a
 * no-op rather than a second cycle.
 */
export async function appendOrderCycled(
  pool: Pool,
  roomId: string,
  actorId: string,
  payload: OrderCycledPayload,
): Promise<ServerEvent | null> {
  const { rows } = await pool.query<EventRow>(
    `INSERT INTO events (room_id, actor_id, actor_member_id, event_type, payload)
     VALUES ($1, $2, ${ACTOR_MEMBER(2)}, 'order.cycled', $3)
     ON CONFLICT DO NOTHING
     RETURNING ${EVENT_COLS}`,
    [roomId, actorId, JSON.stringify(payload)],
  );
  return rows[0] ? rowToServerEvent(rows[0]) : null;
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
    /** The standing order that fired this summon (S-LOOP), if one did. Human-rooted regardless. */
    order_id?: string;
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

/**
 * The room-visible half of a briefing set/replace (S1.7). Takes a CLIENT, not the pool, for the same
 * reason `appendPromotionEvent` does: the record and the copy are one transaction (briefings.ts), so
 * the event's content is derived from the row that recorded it, inside the same transaction.
 */
export async function appendBriefingSet(
  client: PoolClient,
  roomId: string,
  actorId: string,
  payload: {
    briefing_id: string;
    content: string;
    content_hash: string;
    purpose: string;
    set_by: string;
    replaces_hash: string | null;
  },
): Promise<ServerEvent> {
  const { rows } = await client.query<EventRow>(
    `INSERT INTO events (room_id, actor_id, actor_member_id, event_type, payload)
     VALUES ($1, $2, ${ACTOR_MEMBER(2)}, 'briefing.set', $3)
     RETURNING ${EVENT_COLS}`,
    [roomId, actorId, JSON.stringify(payload)],
  );
  return rowToServerEvent(rows[0]);
}

/** The room-visible half of a briefing clear (S1.7). In the transaction with the record, as the set is. */
export async function appendBriefingCleared(
  client: PoolClient,
  roomId: string,
  actorId: string,
  payload: { briefing_id: string; content_hash: string; cleared_by: string },
): Promise<ServerEvent> {
  const { rows } = await client.query<EventRow>(
    `INSERT INTO events (room_id, actor_id, actor_member_id, event_type, payload)
     VALUES ($1, $2, ${ACTOR_MEMBER(2)}, 'briefing.cleared', $3)
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
