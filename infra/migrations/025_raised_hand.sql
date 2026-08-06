-- 025 — A CONNECTED MEMBER CAN RAISE A BARE HAND (SCC-3, SCC3-1).
--
-- SCC-2 gave claude-code a way to ASK for a protected action and wait (a decision). It found the
-- loop's honest gap (SCC2-N1): the ONLY route to a person's attention ran through requesting
-- something consequential. A member that is blocked on a design question and needs a human had, until
-- now, exactly one way to be noticed — ask for a merge. That is a perverse incentive, and this closes
-- it: a member may raise a standalone interrupt — a BLOCKER ("I'm blocked, need input") or an FYI
-- ("heads up") — that is ABOUT nothing but itself.
--
-- ── WHY A FIFTH KIND, AND NOT 'message' ───────────────────────────────────────────────
--
-- A raised hand is NOT a decision (it mints no decision event and cannot be resolved by a signature),
-- and it is NOT about a task, an order, or a pre-existing message. It is self-contained: its `summary`
-- IS its content. Reusing 'message' would have meant routing the reason through postMessage to earn an
-- about_id — and postMessage resets every standing order's attendance dial (S-LOOP), so an agent's
-- raised hand would have masked the ABSENCE of a human's attention, which is the opposite of what a
-- raised hand means. A dedicated kind keeps the raised hand exactly one fact: `interrupt.raised`, no
-- side effects. The same reasoning migration 023 used to admit 'order'.
--
-- The wire already carries `about_kind` as a free string (protocol.ts), and the uniqueness index on
-- (room, about_kind, about_id, addressed_to) is unchanged — a hand's about_id is derived from the
-- caller's client_msg_id, so a retried raise dedups (one claim) and a fresh raise does not.

ALTER TABLE interrupts DROP CONSTRAINT interrupts_about_known;
ALTER TABLE interrupts
  ADD CONSTRAINT interrupts_about_known
  CHECK (about_kind IN ('task', 'decision', 'message', 'order', 'hand'));
