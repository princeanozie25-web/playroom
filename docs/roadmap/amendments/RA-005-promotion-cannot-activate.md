# RA-005 — Roadmap amendment: promoted content cannot activate a summon

**Amends:** Bible §21.2, the S1.7 exit criterion · **Status:** **Accepted; satisfied for §7.2
promotion in S1.5, still binding on S1.7's import** · **Raised by:** RT-004 (S0.5b)

## Landed in S1.5 — earlier than expected, and by a mechanism this amendment did not predict

S1.5 built §7.2 promotion: moving an item from a principal's private store into a room. That is
content promotion, so this amendment's criterion applied at that commit rather than at S1.7.

**It is satisfied for that path, and by construction rather than by a rule.** A promotion is a
`context.promoted` event. Barrier 1 of the activation boundary is an allowlist — `memberAuthoredText`
returns text for `message` and `null` for everything else — so a promoted `@sol` resolves to
`NOT_ROOM_CONTENT` and summons nobody. **Nothing in `agent.ts` changed to achieve this.** The barrier
was built as an allowlist in S0.5b precisely so that a later event type would be inert until somebody
deliberately admitted it, and that is what happened.

Asserted in `apps/api/test/promotions.test.ts`: a private note containing a resolvable token for
another principal's agent is promoted verbatim, run through the real `summonRuling`, and summons
nobody — alongside the contrast case that the same words inside a `message` still do activate.

**What this amendment got wrong, stated plainly:** it assumed promoted spans would arrive inside
member-authored messages, and therefore that closing the gap would require span provenance inside
`MessageEvent`. It did not, because promotion did not have to be a message. The reasoning above —
that a rule scoped to `@` tokens would be re-litigated at the next activating token — is unaffected
and is why the event type carries the whole payload rather than a rendered sentence.

**Still binding, unchanged, on S1.7.** S1.7 imports wholesale foreign transcripts, and if any of that
arrives as message text then span provenance is unavoidable and the must-fail test
(`quoted content in a MESSAGE activates`) fails as designed. The pin stays and so does its trigger.
S1.5 did not close RT-004's accepted gap and does not claim to: pasting quoted text into an ordinary
message still activates.

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
