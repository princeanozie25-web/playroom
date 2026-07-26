# RA-005 — Roadmap amendment: promoted content cannot activate a summon

**Amends:** Bible §21.2, the S1.7 exit criterion · **Status:** Logged, not scheduled · **Raised by:** RT-004 (S0.5b)

## The gap

S1.7's binary exit reads:

> A real prior conversation becomes a joinable room in under a minute, and nothing
> unselected appears in it.

That is a guarantee about **content**: what ends up in the room. RT-004 needs a guarantee
about **behaviour**: what the content is allowed to _do_ once it is there. They are
different claims, and only the first is written down.

S1.7 imports foreign conversation **wholesale** — a Claude or ChatGPT export, written
outside Playroom, by parties who were never in the room, containing arbitrary text. Today a
summon token in a member's message activates, and the activation boundary cannot tell a
member's own words from a span they pasted, because `MessageEvent.payload` is one flat
string with no representation of which spans came from where.

So a promoted transcript containing `@sol, take review` summons Sol. The member who
promoted it selected that content — the §21.2 criterion is satisfied, "nothing unselected
appeared" — and an agent belonging to a different principal took a turn because of text
neither of them wrote. **Promotion becomes an injection amplifier that ships with a green
suite**, because the suite is checking the only thing the criterion asks about.

RT-004's two barriers do not cover this. Barrier 1 refuses model-generated text; barrier 2
refuses agent-authored messages. A promoted span arrives inside a **member-authored**
message, from a human who is genuinely a member, so both barriers correctly let it through.
Closing it needs span provenance, which is exactly what S1.7 builds and nothing before it
has.

## The amendment

**S1.7's exit criterion gains a second sentence:**

> A real prior conversation becomes a joinable room in under a minute, and nothing
> unselected appears in it. **Imported and promoted spans are inert: no summon token,
> mandate reference or action request inside promoted content can activate anything — a
> promoted `@member` renders as text and summons nobody.**

"Inert" is deliberately broader than summons. Promotion is the first surface that carries
text from outside the trust boundary into a room, and a rule scoped to `@` tokens would be
re-litigated the moment the next activating token exists.

## What it gives the test that already exists

S0.5b pinned the current behaviour as a **must-fail** test —
`quoted content activates — the hole, recorded` in `apps/api/test/summon-boundary.test.ts`.
It asserts that quoted content _does_ activate, so that the day span provenance lands the
test breaks and forces the decision.

Without this amendment that test breaks against nothing: whoever hits it has a failing
assertion, no specification, and every incentive to update the expectation and move on.
With it, the failing test points at a written criterion. **The test is the alarm; this is
what the alarm is for.**

## Why this is not simply "fix it in S1.7"

Because the criterion is what gets checked. S1.7's exit will be assessed against §21.2 by
whoever builds it, and a requirement that lives only in a red-team log entry from a slice
five months earlier is a requirement that will be met by accident or not at all.

**Precondition:** none — the criterion can be amended now and is cheaper to satisfy while
S1.7's data model is still unwritten. **Blocks:** nothing in P0.
