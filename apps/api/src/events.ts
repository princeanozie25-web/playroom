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
}

// Append an agent turn event (started/delta/completed). Telemetry columns are set
// on completed; null otherwise. Returns the wire event, ready to fan out.
export async function appendAgentEvent(
  pool: Pool,
  roomId: string,
  actorId: string,
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
  };
  const { rows } = await pool.query<EventRow>(
    `INSERT INTO events
       (room_id, actor_id, event_type, payload,
        adapter_id, tokens_in, tokens_out, cost_usd, latency_ms, prompt_hash, success, error_class)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${EVENT_COLS}`,
    [
      roomId,
      actorId,
      eventType,
      JSON.stringify(payload),
      t.adapter_id ?? null,
      t.tokens_in,
      t.tokens_out,
      t.cost_usd,
      t.latency_ms,
      t.prompt_hash,
      t.success,
      t.error_class,
    ],
  );
  return rowToServerEvent(rows[0]);
}
