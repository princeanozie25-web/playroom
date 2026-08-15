-- ═══ S-TASK — AN ORDER SAYS WHAT IT IS FOR ═══════════════════════════════════════════
--
-- SL2-N5: the loop ran and did not do the work it was pointed at. The order summoned with a
-- generic intent ("standing order — prince authorised claude-main to recur"), the room's briefing
-- framed without asking, and the first live cycle spent a paid turn replying that it could not see
-- a specific request. Every part of the loop was correct and the loop was not useful.
--
-- The missing object is a TASK ON THE ORDER. The briefing says HOW WORK IS DONE HERE; the task says
-- WHAT THIS ORDER IS FOR. They are different objects and collapsing them is how an agent ends up
-- writing its own objective.
--
-- ── WHY NOT REUSE THE BRIEFING RECORD ────────────────────────────────────────────────
--
-- It would look economical: both are pinned text delivered every cycle, both owner-authored, both
-- refused to agents. But a briefing is ROOM-scoped and a task is ORDER-scoped. One room may hold
-- several orders with different objectives and exactly one briefing — a review loop and a triage
-- loop sharing "prefer small reversible changes" while asking for entirely different work. Folding
-- them together would make the second order impossible to express, and would make the briefing
-- mutable in practice (you would edit it to redirect one loop, changing what every other member
-- and every other order in the room reads).
--
-- ── WHY IT IS WIRING, AND THEREFORE NULLABLE HERE AND REQUIRED IN THE COMMAND ────────
--
-- UI3-1 ruled an order's WIRING immutable and enforced it BY ABSENCE: `updateOrderCommand` has no
-- parameter for trigger, action or members, so there is no guard to get wrong. A task determines
-- what an order CAUSES, so it belongs on that side of the line: changing the task means creating a
-- new order. An editable task would be a channel for redirecting a running loop, and a loop that
-- can be redirected while running is a loop whose authority is negotiable.
--
-- So the column is NULLABLE, and that is not a softening:
--   * NEW orders must carry one — refused at CREATION, in the command, where the human is (the same
--     discipline as S1.7's oversize refusal: fail where a person can fix it, not where the loop is).
--   * ORDERS THAT PREDATE THIS MIGRATION have NULL and there is nothing to backfill them with. An
--     objective cannot be inferred from a trigger and an action member, and inventing one would be
--     writing a human's intent for them. They REFUSE TO FIRE, out loud, and pause (runOrders.ts) —
--     never fire with an empty objective, and never silently skip.
-- A NOT NULL column would have forced exactly that invention, which is why it is not one.
--
-- The CHECK allows NULL (legacy) but never blank: a task of spaces is an absent task wearing a
-- string, and the command refuses it separately so the human gets the reason rather than a
-- constraint violation.

ALTER TABLE standing_orders ADD COLUMN IF NOT EXISTS task TEXT;

ALTER TABLE standing_orders DROP CONSTRAINT IF EXISTS standing_orders_task_not_blank;
ALTER TABLE standing_orders
  ADD CONSTRAINT standing_orders_task_not_blank
  CHECK (task IS NULL OR btrim(task) <> '');
