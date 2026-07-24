-- 001_rooms_events: the room + append-only event log.
-- Column names are a strict subset of the §17 telemetry shape; later columns
-- arrive additively (never a rename, never a drop).

CREATE TABLE IF NOT EXISTS rooms (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  seq           BIGSERIAL PRIMARY KEY,
  room_id       TEXT NOT NULL REFERENCES rooms (id),
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id      TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  client_msg_id TEXT,
  payload       JSONB NOT NULL,
  -- Idempotency key for sends. NULLs are distinct in Postgres, so events with
  -- no client_msg_id are never collapsed; duplicate sends carrying the same id are.
  UNIQUE (room_id, client_msg_id)
);

-- Replay/tail ordering within a room: WHERE room_id = $1 AND seq > $2 ORDER BY seq.
CREATE INDEX IF NOT EXISTS events_room_seq_idx ON events (room_id, seq);
