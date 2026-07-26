-- 006_one_turn_per_summon: THE SECOND DRIFT NUMBER, enforced (S0.5b).
--
-- Additive only: one partial unique index. No columns, no rewrites.
--
-- WHY A SECOND NUMBER EXISTS AT ALL. S0.5a's replay bug produced two agent turns from
-- one human action WHILE THE ZERO QUERY READ ZERO, because both turns were honestly
-- human-rooted. §19's "unprompted messages must be exactly zero" therefore needs two
-- measurements, not one:
--
--   1. turns that do not trace to a human root       — 004/005, verified
--   2. more than one turn citing a single summon     — this
--
-- With only the first, the number measures ROOTEDNESS and reports it as SILENCE. A room
-- can be perfectly rooted and still be talking twice as much as it was asked to.
--
-- 005 stopped a duplicate SUMMON. Nothing stopped two TURNS citing one summon: a retry,
-- a double-fired trigger, or two processes racing the same summon_id would each start a
-- turn and each be legitimately rooted.
--
-- WHY `agent.turn.started` IS THE KEY. Exactly one started row exists per turn, written
-- before any provider call, so it is the cheapest possible place to lose the race — the
-- loser has spent no tokens. Uniqueness on `completed` would refuse a turn only after
-- paying for it, and uniqueness across all agent.turn.% rows would forbid the deltas.
--
-- NULLs are distinct in a unique index, so every pre-004 turn row (summon_id NULL)
-- coexists with every other. Nothing is retroactively blessed and nothing is refused.
--
-- The loser of this race must NOT then write a completed row: that row would itself be
-- the second turn appearing in the log, defeating the guarantee it is reporting. See the
-- duplicate-turn branch in runAgentTurn, which returns without writing anything.

CREATE UNIQUE INDEX IF NOT EXISTS events_one_turn_per_summon_uniq
  ON events (summon_id)
  WHERE event_type = 'agent.turn.started';
