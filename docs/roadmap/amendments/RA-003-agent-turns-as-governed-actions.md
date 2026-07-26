# RA-003 — Roadmap amendment: agent turns as governed actions

**Amends:** Bible §21.3 (P1 — Room MVP) · **Status:** Logged, not scheduled · **Raised by:** S0.4

## The gap

`room.post` sat in `claude-main`'s mandate scope from mandate v0 until S0.4 and **was
never evaluated**. Nothing dispatched it. S0.4 deleted it, because an entry inside an
authority document that nothing enforces reads as a granted power and the next person to
look will trust it — the same failure shape as `mandate_label`.

Deleting it closes the lie. It does not close the question, which is: **an agent posting
to a room genuinely is a governed action.** It is the action postage is debited against
(Bible §18: "postage debits every agent-initiated message"), the action interrupt budgets
bound (§12.1), and the action a compromised agent would use to flood a room. Today it
traverses nothing.

## Proposed slice — S1.8, agent turns through the evaluator

Route `triggerAgentTurn` through `evaluate()` with an action type such as `room.post`,
so an agent's turn is authorised the way its other actions are. Then:

- postage and interrupt limits have somewhere to live (the `breaches_limits` branch of
  Bible §9.2, currently absent for want of usage counters);
- a member whose mandate is expired or absent stops speaking, which is the correct
  fail-closed behaviour;
- `room.post` returns to scope, this time meaning something.

## Why it was not done in S0.4

Sequencing, not disagreement. A mandate that fails to load, or a scope entry that does not
match what the evaluator receives, would silence **every** agent in the room — and
fail-closed silence with no explanation is precisely the RT-001 shape: a refusal
indistinguishable from nothing happening. Doing that days before the P0 film trades a
real filming risk for an architectural tidiness that P1 can deliver calmly.

It also needs the pieces P1 brings anyway: humans have no mandate until S1.1, so
"every actor's every action is evaluated" cannot be the rule yet without blocking human
messages (see M-3's note on why chat is not a governed action).

**Precondition:** S1.1 (principals and members). **Blocks:** nothing in P0.
