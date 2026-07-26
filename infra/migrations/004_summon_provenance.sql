-- 004_summon_provenance: every agent turn traces to a human summon (S0.5a).
--
-- Additive only. Nothing dropped, nothing rewritten, existing rows untouched: both
-- columns are nullable and every row written before this migration keeps NULL, which
-- the zero query counts as unresolved — correct, because those turns predate the
-- invariant and should not be silently blessed by it.
--
-- WHY COLUMNS AND NOT payload JSONB. §19 makes the unprompted-message count a nightly
-- contract. `payload->>'summon_id'` across every agent.turn row is a query that works
-- right up until it is the only thing that matters, and it cannot be indexed usefully
-- without an expression index nobody will remember exists.

-- Set on `summon` rows AND on the agent.turn.* rows that answer them. The join key.
ALTER TABLE events ADD COLUMN IF NOT EXISTS summon_id TEXT;

-- Set on `summon` rows only. Recorded at WRITE TIME, never derived later: members do
-- not exist in the database until S1.1, so "was this root a human" cannot be resolved
-- by SQL lookup. It is a judgement made against the roster at the moment of the summon
-- and frozen — which is the right semantics for an append-only log, and is why the
-- column is here rather than computed in the query.
ALTER TABLE events ADD COLUMN IF NOT EXISTS root_is_human BOOLEAN;

-- The zero query joins turns to their summon on this. Partial: only rows carrying a
-- summon_id are ever probed, which keeps the index small in a log dominated by deltas.
CREATE INDEX IF NOT EXISTS events_summon_id_idx ON events (summon_id) WHERE summon_id IS NOT NULL;
