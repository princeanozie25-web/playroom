# RA-007 — Roadmap amendment: establish standing before evaluating the request

**Amends:** Bible §9.2, the evaluation order · **Status:** Adopted, applied in S11c-1 · **Raised by:** S11b-N1

## The bug

Bible §9.2 orders the evaluator's branches: 1 signature/expiry, 2 scope, 3 replay,
4 protected actions, 5 counterparties, 6 limits.

With `counterparties` at 5 and `protected_actions` at 4, a protected action requested for a
member **who is not in the room** returns `CO_SIGN`. The system asks a human to sign for an
absent member.

It is fail-closed — nothing executes without that signature — so nothing is exceeded and no
authority is granted. But it asks the wrong question, and it asks it on the DECISION card,
which is the surface carrying the most credibility in the entire product. A card reading
"Needs a signature from Prince" for a member who was never in the room is a card inviting a
human to resolve a situation that should already have been refused.

Found by writing the test for S1.1b's new `counterparties` branch, asserting the roster check
would win, and being wrong.

## The principle — this is what to inherit, not the swapped line

> **Establish standing before evaluating the request.**
>
> Expiry, signature, scope and roster all answer _may this member act here at all_.
> Protection and limits answer _what does this particular action need_.
>
> **Never ask a human to approve something that should have been refused outright.**

This is not a new rule. It is the rule that already put **scope ahead of protected actions**,
which is why a protected action absent from scope is `BLOCK / OUT_OF_SCOPE` and not
`CO_SIGN` — a distinction the mandate table has asserted since mandate v0 (case 11). The
`counterparties` branch was simply written into the wrong half of the sequence.

Stated as a principle rather than a corrected line number because S2.1 rewrites this
evaluator's internals — adding signature verification, replay protection and the limits
branch. A reordered list would be re-derived; the reason will not be.

## The amended order

| #   | branch                         | question it answers                         |
| --- | ------------------------------ | ------------------------------------------- |
| 1   | signature / expiry             | **standing** — is this mandate valid at all |
| 2   | scope                          | **standing** — is this action granted       |
| 3   | counterparties (`roster_only`) | **standing** — may this member act here     |
| 4   | replay (S2.1)                  | request integrity                           |
| 5   | protected actions              | **the request** — what does it need         |
| 6   | limits (S2.7)                  | **the request** — can it be afforded        |

Replay sits between the two halves deliberately: a replayed request has standing but is not a
genuine request, and refusing it before asking a human to sign is the same instinct as this
amendment.

## What it changes in practice

For the two mandates that exist today, one case changes: a `pr.merge` requested for a member
outside the room returns `BLOCK / ROSTER_VIOLATION` where it previously returned
`CO_SIGN / PROTECTED_ACTION`. Nothing that previously reached a human stops reaching them
when the member is actually in the room, which is every case the film exercises.

**Precondition:** rooms have a roster (S1.1b). **Binds:** S2.1's rewrite of the evaluator.
