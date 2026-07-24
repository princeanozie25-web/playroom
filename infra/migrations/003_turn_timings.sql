-- 003_turn_timings: per-turn latency spans (S0.3c). Additive and observation-only
-- — written on agent.turn.completed rows to measure §7 first-token latency. It
-- changes no event shape, no ordering, and no write in the turn path.

ALTER TABLE events ADD COLUMN IF NOT EXISTS timings JSONB;
