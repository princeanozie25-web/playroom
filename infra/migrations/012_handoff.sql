-- 012_handoff: a task can be handed over, and `submitted` becomes reachable (S1.3).
--
-- Additive. One relaxed CHECK.
--
-- ── WHY A NEW STATE ARRIVES ONE COMMIT AFTER THE OTHERS ────────────────────────────────
--
-- Migration 011 excluded `submitted` and said why: it would have existed for the microseconds
-- between inserting a row and selecting a route, observed by nobody. That was true, and it
-- stops being true here.
--
-- A HANDED-OVER TASK IS RECEIVED AND NOT STARTED, and there is no other state that says so:
--
--   * `working` would be a lie. A handoff does not trigger a turn — an agent cannot ask for
--     work (no tool-call channel) and a handoff is not a summon, so nothing is in progress.
--     A chip reading `working` with nothing running is the room implying activity it does not
--     have, which is the one thing the surface may not do.
--   * `input-required` is the wrong sentence. That state means the tagging human has to change
--     something before the work can proceed (§6.2's failed constraint). Here nothing is wrong;
--     the work is simply waiting to be asked for.
--   * leaving the state alone would carry `done` across the handoff, so a task Claude finished
--     would arrive at Sol already complete.
--
-- So `submitted` — A2A's own name for received-and-not-started — arrives WITH the path that
-- makes it reachable, which is the same discipline that kept the summon-depth cap out of the
-- codebase until an agent-initiated summon could exist to be capped.
--
-- NO `mandate_hash` COLUMN, deliberately. The `task.handoff` event carries the mandate the
-- receiving member will act under (Bible §21.3 requires the reference to travel with the task)
-- and the chip reads it from there. Nothing in the validation path reads it, and a column
-- nothing reads is a field that goes stale without anyone noticing.

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_state_known;
ALTER TABLE tasks ADD CONSTRAINT tasks_state_known
  CHECK (state IN ('submitted', 'working', 'input-required', 'held', 'done'));
