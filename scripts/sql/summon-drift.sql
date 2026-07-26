-- THE DRIFT QUERY (Bible §19: "unprompted-message count, which must remain exactly zero")
--
-- TWO NUMBERS, BOTH OF WHICH MUST BE ZERO. One is not enough, and finding that out cost a
-- bug: S0.5a's replayed frame produced two agent turns from one human action while the
-- single-number version read zero the whole time, because both turns were honestly
-- human-rooted. A count of unrooted turns measures ROOTEDNESS and reports it as SILENCE.
--
--   unrooted_turns      a turn that does not trace to a human-rooted summon
--   multi_turn_summons  a summon that more than one turn cites
--
-- Run it against any Playroom database:
--   psql "$DATABASE_URL" -f scripts/sql/summon-drift.sql
-- or from the harness:
--   pnpm tsx scripts/check-summon-drift.ts [--test] [--plan]
--
-- ONE COPY ON DISK. The test, this script and any manual psql run all read this file;
-- nothing inlines a second copy. Two copies drift, and the first time they disagreed the
-- passing one would be believed.
--
-- It is committed as SQL rather than living only inside a test because a passing unit test
-- and a clean production log are DIFFERENT CLAIMS: the tests prove the code cannot write
-- drift, the query proves none is there. Both are wanted, and only the second would catch
-- a row written by a migration, a backfill, or a hand-run INSERT.
--
-- WHAT COUNTS AS UNROOTED, deliberately including the awkward cases:
--   * a turn with no summon_id at all — including every turn written before migration
--     004, which is why they are not retroactively blessed;
--   * a turn whose summon_id matches no summon row;
--   * a turn whose summon is not human-rooted.
-- `root_is_human IS NOT TRUE` rather than `= false`, so a NULL — a summon written by some
-- future path that forgot to decide — counts as unrooted rather than passing.
--
-- `turn_rows_examined` and `summons_examined` are reported so a zero cannot be mistaken
-- for an empty table. The first run of the single-number version returned a clean zero
-- over a log with no agent turns in it at all, which proves the query parses and nothing
-- else. A vacuous pass now says so on its face.
--
-- COST, as MEASURED and not predicted. EXPLAIN ANALYZE against the live database on
-- 2026-07-26, 45 events / 35 turn rows / 3 summons — planning 0.261 ms, execution 0.357 ms:
--
--   Result
--     CTE turn_rows
--       -> Seq Scan on events            rows=35   Filter: event_type ~~ 'agent.turn.%'
--     CTE unrooted
--       -> Nested Loop Left Join         rows=0    Rows Removed by Join Filter: 70
--            -> CTE Scan on turn_rows    rows=35
--            -> Seq Scan on events       rows=3    Filter: event_type = 'summon'  (loops=35)
--     CTE per_summon
--       -> GroupAggregate over a quicksort of turn_rows   rows=3
--     InitPlan 4..10  — CTE scans of the two materialised CTEs, one per output column
--
-- Read that honestly: at this size the planner sequentially scans a 45-row table and
-- NESTED-LOOPS the summon side 35 times, which is free here and is not a plan that
-- survives growth. It says the query is correct, not that it is scalable. Re-measure
-- rather than trusting these numbers — the earlier single-number version's comment claimed
-- an index scan and a hash join, and EXPLAIN ANALYZE flatly contradicted it.
--
-- The cost driver as the log grows is finding the agent.turn.% rows at all:
-- `event_type LIKE 'agent.turn.%'` has no index, and events_summon_id_idx (004) cannot
-- serve it — that index is partial on `summon_id IS NOT NULL`, and half the point here is
-- to find rows where it IS NULL. Expect a full scan of `events`, a table dominated by
-- deltas. FINDING S05a-N2, not fixed here. TRIGGER: S2.9, when the nightly job meets
-- pilot volume instead of thirty-nine rows — the fix (an index on event_type, or a
-- materialised rollup) should be chosen against real cardinality, not guessed at now.
--
-- No recursive walk in either number: provenance is DENORMALISED onto the summon row
-- (root_actor, root_is_human), so resolving a turn to its root is a single hop however
-- deep a later slice allows a chain to go.

WITH turn_rows AS (
  SELECT seq, summon_id, payload ->> 'turn_id' AS turn_id
  FROM events
  WHERE event_type LIKE 'agent.turn.%'
),
summon_rows AS (
  SELECT summon_id, root_is_human
  FROM events
  WHERE event_type = 'summon'
),
-- Every turn row that fails to resolve, tagged with WHICH way it failed so a non-zero
-- total says something actionable instead of just being non-zero.
unrooted AS (
  SELECT
    (t.summon_id IS NULL) AS no_ref,
    (t.summon_id IS NOT NULL AND s.summon_id IS NULL) AS dangling,
    (s.summon_id IS NOT NULL AND s.root_is_human IS NOT TRUE) AS not_human
  FROM turn_rows AS t
  LEFT JOIN summon_rows AS s ON s.summon_id = t.summon_id
  WHERE t.summon_id IS NULL
     OR s.summon_id IS NULL
     OR s.root_is_human IS NOT TRUE
),
-- DISTINCT turn_id, not row count: one turn is a started row plus many deltas plus a
-- completed row, all citing the same summon. Counting rows would report every ordinary
-- turn as drift.
per_summon AS (
  SELECT summon_id, count(DISTINCT turn_id) AS turns
  FROM turn_rows
  WHERE summon_id IS NOT NULL
  GROUP BY summon_id
)
SELECT
  (SELECT count(*) FROM unrooted)::int AS unrooted_turns,
  (SELECT count(*) FROM unrooted WHERE no_ref)::int AS no_summon_ref,
  (SELECT count(*) FROM unrooted WHERE dangling)::int AS dangling_ref,
  (SELECT count(*) FROM unrooted WHERE not_human)::int AS not_human_rooted,
  (SELECT count(*) FROM per_summon WHERE turns > 1)::int AS multi_turn_summons,
  (SELECT count(*) FROM turn_rows)::int AS turn_rows_examined,
  (SELECT count(*) FROM per_summon)::int AS summons_examined;
