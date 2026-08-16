# ADR-009: "Door" names two boundaries, distinguished by adjective

## Context

The Fable consolidated report of 13 Aug 2026 proposes freezing `Door` as **an admission boundary
through which a human or Worker requests scoped membership in a Room**.

AUDIT-FABLE established that this repository already uses the word, for something else:

- `apps/api/src/server.ts:742` — `'action door: credential refused'`
- `apps/api/src/interrupts.ts:37` — "the bare hand SCC2-N1 said the door could not raise"
- `apps/api/src/room-codes.ts:15`, `:169` — "the front door", meaning the authenticated handshake

The repo's door admits an **external caller to the API** under a credential. The report's door admits
a **member to a Room**. The map records this as COLLISION, and separately records `Room` as PARTIAL
with the gap named: room creation blanket-enrols every non-guest member, and the only scoped
admission that exists is a guest room code. **The report's door does not exist here at all.**

No symbol is named `door`. Every occurrence is prose or a comment.

## Decision

**Keep both, distinguished by adjective.** Prince's ruling, 16 Aug 2026, recorded in his words:

> Keep both, distinguished by adjective. "The API door" admits an external caller to the API under a
> credential. "A room door" would admit a member to a Room, and does not exist yet — the map has Room
> as PARTIAL with no admission control. They are the same _kind_ of boundary at different scopes,
> which is why the ambiguity is tolerable. The repo's usage is prose and comments only, inside S2.1b
> and SCC-3 commits that explain themselves with the word; rewriting them costs more clarity than it
> buys. **When room admission is built, the adjective becomes load-bearing rather than decorative.**

### Options rejected, and their costs

**Rename the repo's usage.** Cheap in mechanics — prose only, no symbol — and expensive in meaning:
S2.1b and SCC-3 are commits whose reasoning is carried in that word, and a rename leaves those
commit messages describing a vocabulary the tree no longer uses. The repository would read correctly
and its history would not.

**Rename the report's usage.** The report is an input document, not code. Editing an input to agree
with the thing it was written to examine destroys its value as an independent reading.

## Consequences

**Easier.** Nothing moves. The word keeps working in both documents, and a reader who meets "door"
in a commit message from S2.1b finds the tree still using it that way.

**Harder.** Two meanings live in one word, and every future brief that says "door" without an
adjective inherits the ambiguity. That cost is accepted deliberately, and it is small only while one
of the two boundaries does not exist.

**Foreclosed.** Nothing. Both options above remain available at their stated costs.

## Reconsideration trigger

**Room admission being built.** The moment a member can request scoped membership in a Room, both
doors exist at once, the adjective stops being decorative, and a bare "door" in any brief, comment or
UI string becomes a defect rather than a shorthand. Whoever builds it should re-read this ADR before
naming anything.

## Status

Accepted — 16 Aug 2026.
