# ADR-011: "Worker" is a product-surface word; code says `member`

## Context

The Fable report freezes `Worker` as **a persistent AI identity that performs work; not synonymous
with a model.**

AUDIT-FABLE found no collision of the word — `worker` appears nowhere in `apps/` or `packages/`
source except one hit meaning a browser service worker. It found something else, and recorded it as
COLLISION by collapse: the report's single term would merge **five concepts this repository keeps
apart**, each with its own record and its own enforcement.

| Concept     | What it answers             | Where it is real                                    |
| ----------- | --------------------------- | --------------------------------------------------- |
| `member`    | who is acting               | `members` table (007), `MemberRecord`               |
| `principal` | whose authority they act on | `principals` table, `members.principal_id` NOT NULL |
| `adapter`   | which provider and model    | `adapters.yaml` — the only file naming a provider   |
| `route`     | how they are reached        | `routes` table (009), `selectRoute`                 |
| `mandate`   | what they may do            | `mandates/*.json`, evaluated by `evaluate()`        |

The separation is load-bearing, and there is a standing proof of it in the tree: **`claude-audit`
runs `claude-main`'s exact provider and model, and is a different member, because a standing order's
stop-interrupts are charged to its action member and the loop needed its own six.** One word for all
five cannot express "same model, different budget", which is the distinction that made that member
worth minting.

## Decision

**`Worker` is a product-surface word only, mapping to `member` in code.** Prince's ruling,
16 Aug 2026, in his words:

> A product-surface word only, mapping to `member` in code. This is the mandate precedent inverted —
> _mandate_ lives in code and documents and is never printed in the product UI; _Worker_ may live in
> the product UI and never appear in code. The five separated concepts (`member`, `principal`,
> `adapter`, `route`, `mandate`) stay separated where the separation is load-bearing, and
> `claude-audit` is the standing proof: claude-main's exact model, a different member, its own
> interrupt budget — a distinction "Worker" cannot express.

### Options rejected, and their costs

**Freeze it as a contract.** Five repo concepts would each need a stated relationship to a sixth term
that names none of them exactly. Every one of those relationships is a place for the collapse to
happen later — and the collapse is the thing being avoided, not the word.

**Do not freeze it at all; say `member` everywhere including the product.** Honest, and it gives up a
word that is genuinely better in a UI. "Member" is precise and slightly wrong to a person who has
never read the schema: it suggests a peer, not something that performs work for them.

## Consequences

**Easier.** The product can say "Worker" where that reads better, and the schema keeps five words for
five things. Neither vocabulary has to bend for the other.

**Harder.** Two vocabularies must stay mapped, and the mapping lives only here. A spec author writing
"Worker" has to know it means `member` and not "member plus its adapter plus its mandate".

**Foreclosed.** `Worker` as an identifier in source. That is what makes this ADR enforceable rather
than remembered, and it is asserted mechanically — `tests/evidence.test.ts` fails if `worker` appears
as an identifier in `apps/` or `packages/` source, with the browser service worker excepted by name.

## Reconsideration trigger

**`Worker` appearing anywhere in source.** It should never happen, which is why it is a test rather
than a note — the trigger fires in CI, in front of whoever wrote it, before the collapse has a second
occurrence to argue from.

## Status

Accepted — 16 Aug 2026.
