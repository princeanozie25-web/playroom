-- 023 — AN ORDER CAN CLAIM A PERSON'S ATTENTION (S-LOOP, SLOOP-3).
--
-- When a standing order STOPS on its own — its cycle limit reached, its expiry passed, the daily
-- spending ceiling hit, its attendance dial run down, or a turn erroring — the person who owns it
-- must be told, out loud, through the same record every other claim on their attention travels: an
-- interrupt (S1.4). The interrupt is DECISION urgency, addressed to the humans of the order's
-- creator-principal, and it costs the loop's own agent member from its `interrupts_per_day` budget —
-- the recurring work is the agent's, so the claim it makes on a person is the agent's to fund.
--
-- The only thing standing in the way was the CHECK: `about_kind` admitted 'task', 'decision' and
-- 'message', the three targets that existed when S1.4 was built. An order is a fourth. This widens
-- the constraint to name it, and nothing else — the wire already carries `about_kind` as a free
-- string (protocol.ts), and the uniqueness index on (room, about_kind, about_id, addressed_to) is
-- unchanged, so an order's about_id must be distinct per stop for each stop to re-raise.

ALTER TABLE interrupts DROP CONSTRAINT interrupts_about_known;
ALTER TABLE interrupts
  ADD CONSTRAINT interrupts_about_known
  CHECK (about_kind IN ('task', 'decision', 'message', 'order'));
