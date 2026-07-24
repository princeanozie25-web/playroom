import type { Pool } from 'pg';
import type { ServerEvent } from '@playroom/shared';

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
  payload: { body: string };
}

const EVENT_COLS = 'seq, room_id, ts, actor_id, event_type, payload';

function toServerEvent(row: EventRow): ServerEvent {
  return {
    type: 'event',
    seq: Number(row.seq),
    room_id: row.room_id,
    ts: row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
    actor_id: row.actor_id,
    event_type: 'message',
    payload: { body: row.payload.body },
  };
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
  return rows.map(toServerEvent);
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
  if (inserted.rows[0]) return toServerEvent(inserted.rows[0]);
  const existing = await pool.query<EventRow>(
    `SELECT ${EVENT_COLS} FROM events WHERE room_id = $1 AND client_msg_id = $2`,
    [roomId, clientMsgId],
  );
  return toServerEvent(existing.rows[0]);
}
