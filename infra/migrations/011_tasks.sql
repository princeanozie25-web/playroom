-- 011_tasks: work becomes a record with a state (S1.3).
--
-- Additive only. One table, one column on `events`.
--
-- Until now the room had messages, summons, turns and decisions — every one of them an
-- INSTANT. Nothing carried the state of work over time, so `input-required` was a state the
-- Bible named (§6.2's failure rule, §11's chip line, §14's route-unavailable row) and the code
-- had nowhere to put. S1.1c implemented the half that could exist without it — the room names
-- the failed constraint — and said so.
--
-- ── THE STATES, AND WHY THESE FOUR ────────────────────────────────────────────────────
--
-- A2A-shaped, and every one of them REACHABLE today. A state nothing can enter is a claim
-- about a lifecycle rather than a lifecycle:
--
--   working         a route was selected and a turn was triggered
--   input-required  §6.2: no route satisfied the constraints, and the room said which one.
--                   The tagging human has to change something; nothing retries by itself.
--   held            §14: the turn failed for an operational reason (provider outage, 429,
--                   an adapter that cannot be constructed). The work is not finished and
--                   not refused — it is stopped, and the record survives the process.
--   done            the turn completed successfully.
--
-- `submitted` is deliberately absent. It would exist for the microseconds between creating
-- the row and selecting a route, observed by nobody, and it would put an event in the log that
-- no reader could ever act on. The task is created in the state it starts in.
--
-- NOTHING RESUMES A `held` TASK. §14 says "resumes on recovery" and that recovery path does
-- not exist: there is no retry budget, no scheduler, and no keep-alive (S05c-N1). The state is
-- honest about where the work stopped; it does not imply anything picks it up. Building the
-- resumer before the outage detection it depends on is the pattern this codebase has now
-- avoided five times.
--
-- ── THE LOG IS THE SOURCE OF TRUTH; THIS TABLE IS A PROJECTION ─────────────────────────
--
-- Every state change appends an event (`task.created`, `task.state`, `task.handoff`) and then
-- updates the row. The row exists so the room can render a chip and a handoff can be validated
-- without folding the log on every request — it is an index, not the record. `tasks.test.ts`
-- rebuilds each task's state by folding its events in `seq` order and asserts it equals the
-- row, so the two cannot drift silently. If they ever disagree, THE LOG WINS.

CREATE TABLE IF NOT EXISTS tasks (
  id                 TEXT PRIMARY KEY,
  -- ON DELETE CASCADE on the room, matching `room_members` (008). A task is work IN a room and
  -- cannot outlive it; the alternative is a task whose room_id points at nothing, which is a row
  -- no query can interpret. Written after nine test files failed their teardown on this exact
  -- foreign key — the constraint was right and its delete rule was missing.
  room_id            TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  -- WHO IS RESPONSIBLE NOW. Moves on handoff; the log keeps every previous holder.
  assignee_member_id TEXT NOT NULL REFERENCES members (id),
  state              TEXT NOT NULL,
  -- THE WORK, as an action type, when the task names a governed one — NULL when it does not.
  --
  -- A task created by tagging a member in chat names no governed action: answering a question
  -- in a room is not a commitment-bearing act and no mandate scope covers it. NULL says that,
  -- where a placeholder like 'chat.reply' would invent a scope nobody grants and make every
  -- mandate check against it either vacuous or wrong.
  --
  -- A handoff SETS it, because a handoff must say what is being handed over — that is what
  -- makes the receiving member's mandate check meaningful rather than decorative.
  action             TEXT,
  -- The sentence that created the work, stored whole. Duplicated from the message event on
  -- purpose: a task that cannot say what it is for is a row with a state and no subject, and
  -- reconstructing it from a cause_seq join is work every reader would have to repeat.
  intent             TEXT NOT NULL,
  created_by         TEXT NOT NULL REFERENCES members (id),
  -- THE ORIGIN, and the idempotency key. Same natural key migration 005 gave the summon:
  -- one cause may create one task per member. A replayed frame resolves to the task that
  -- already exists rather than creating a second one — the S0.5a bug, which was found by a
  -- property test after the same mistake had already been made once.
  origin_cause_seq   BIGINT NOT NULL,
  origin_member      TEXT NOT NULL REFERENCES members (id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tasks_state_known CHECK (state IN ('working', 'input-required', 'held', 'done'))
);

-- The idempotency gate, at the database. An `if` in application code cannot survive two
-- frames in flight at once (summon-provenance's concurrent-replay case is the proof).
CREATE UNIQUE INDEX IF NOT EXISTS tasks_origin_uniq
  ON tasks (room_id, origin_cause_seq, origin_member);

CREATE INDEX IF NOT EXISTS tasks_room_idx ON tasks (room_id);
CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON tasks (assignee_member_id);

-- ── events.task_id ────────────────────────────────────────────────────────────────────
--
-- A COLUMN, like `summon_id`, not a payload field — because the question it answers is a
-- query: "everything that ever happened to this task", in one indexed read, including the
-- turns that did the work. §19's `events` table is deliberately wide for exactly this reason.
--
-- Nullable, and it must be: a chat message, a system notice and a decision belong to no task.
ALTER TABLE events ADD COLUMN IF NOT EXISTS task_id TEXT REFERENCES tasks (id);

CREATE INDEX IF NOT EXISTS events_task_idx ON events (task_id) WHERE task_id IS NOT NULL;
