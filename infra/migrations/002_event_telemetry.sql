-- 002_event_telemetry: additive §17 telemetry columns on events. Never rewrites
-- 001 — only adds. All new columns are nullable except `success` (defaults true),
-- so existing rows and non-agent events are untouched. IF NOT EXISTS keeps it
-- idempotent alongside the runner's schema_migrations bookkeeping.

ALTER TABLE events ADD COLUMN IF NOT EXISTS adapter_id  TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS tokens_in   INTEGER;
ALTER TABLE events ADD COLUMN IF NOT EXISTS tokens_out  INTEGER;
ALTER TABLE events ADD COLUMN IF NOT EXISTS cost_usd    NUMERIC(10, 5);
ALTER TABLE events ADD COLUMN IF NOT EXISTS latency_ms  INTEGER;
ALTER TABLE events ADD COLUMN IF NOT EXISTS prompt_hash TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS success     BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE events ADD COLUMN IF NOT EXISTS error_class TEXT;
