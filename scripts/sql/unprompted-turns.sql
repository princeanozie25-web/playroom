-- THE ZERO QUERY (Bible §19: "unprompted-message count, which must remain exactly zero")
--
-- Counts agent turns that do NOT resolve to a human-rooted summon. It must return 0.
--
-- Run it against any Playroom database:
--   psql "$DATABASE_URL" -f scripts/sql/unprompted-turns.sql
-- or from the harness:
--   pnpm tsx scripts/check-unprompted.ts
--
-- This is the query a nightly job reads from. It is committed as SQL rather than living
-- only inside a test because a passing unit test and a clean production log are different
-- claims: the test proves the code cannot write an orphan, the query proves no orphan is
-- there. Both are wanted.
--
-- COST, as MEASURED rather than predicted. On a 39-row log (31 turn rows, 3 summons) the
-- planner picks two sequential scans and a nested loop, 0.2ms total — correct at that size
-- and no evidence at all about behaviour at scale. Recorded honestly because the first
-- draft of this comment claimed "one index scan per side plus a hash join", which EXPLAIN
-- ANALYZE flatly contradicted.
--
-- What will actually drive the cost as the log grows is the LEFT side: every agent.turn.%
-- row has to be found, and `event_type LIKE 'agent.turn.%'` has no index to find them
-- with. events_summon_id_idx (004) cannot help there either — it is partial on
-- `summon_id IS NOT NULL`, and half the point of this query is to find rows where that is
-- NULL. So expect a full scan of `events`, a table dominated by deltas.
--
-- Not fixed here, and named rather than left to be discovered: S05a-N2. The fix when it
-- matters is an index on event_type (or a nightly rollup), decided against real volume
-- instead of guessed at now.
--
-- What the shape does buy: no recursive walk. Provenance is DENORMALISED onto the summon
-- row (root_actor, root_is_human) rather than chained, so resolving a turn to its root is
-- a single hop regardless of how deep S0.5b later allows a chain to go. Depth is carried
-- on the summon for the same reason.
--
-- WHAT COUNTS AS UNRESOLVED, deliberately including the awkward cases:
--   * a turn with no summon_id at all — including every turn written before migration
--     004, which is why they are not retroactively blessed;
--   * a turn whose summon_id matches no summon row;
--   * a turn whose summon is not human-rooted.
-- `root_is_human IS NOT TRUE` rather than `= false`, so a NULL — a summon written by
-- some future path that forgot to decide — counts as unresolved rather than passing.

-- Counts are cast to int: `count(*)` is bigint, which the node driver hands back as a
-- STRING to avoid precision loss. A caller comparing that to 0 gets `'0' !== 0` and
-- reports a clean log as a failure — or, worse, `'5'` as truthy-but-passing.
SELECT
  count(*)::int AS unprompted_turns,
  count(*) FILTER (WHERE t.summon_id IS NULL)::int AS no_summon_ref,
  count(*) FILTER (WHERE t.summon_id IS NOT NULL AND s.summon_id IS NULL)::int AS dangling_ref,
  count(*) FILTER (WHERE s.summon_id IS NOT NULL AND s.root_is_human IS NOT TRUE)::int AS not_human_rooted
FROM events AS t
LEFT JOIN events AS s
  ON s.event_type = 'summon'
 AND s.summon_id = t.summon_id
WHERE t.event_type LIKE 'agent.turn.%'
  AND (
    t.summon_id IS NULL
    OR s.summon_id IS NULL
    OR s.root_is_human IS NOT TRUE
  );
