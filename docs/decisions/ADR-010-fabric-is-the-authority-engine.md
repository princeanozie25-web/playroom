# ADR-010: "Fabric" is the authority engine, and the repo does not move

## Context

The Fable report places `Fabric` beside authority, as **the information-flow boundary — which context
is visible in a Room, which private memory stays private, what may be promoted, what a Worker carries
between Rooms.**

In this repository `Fabric` is the authority engine and knows nothing about visibility.
`packages/fabric/src/index.ts` exports exactly two modules: `mandate.js` (the `Mandate` schema and
its loader) and `evaluate.js` (`evaluate()` and `Verdict`). AUDIT-FABLE recorded this as the sharpest
of the three collisions for one reason the other two do not share: **`@playroom/fabric` is a package
name.** It is an import path in more than twenty files, a workspace directory, and a dependency entry
— a symbol, not prose.

The report's meaning is implemented nowhere. The repo's information-flow boundary exists, but under
different names: `assembly.ts`'s declared parts and their `ownership`, and the `own-store` /
common-ground split the assembly asserts.

## Decision

**The repo's meaning stands; the report adopts it.** Prince's ruling, 16 Aug 2026, in his words:

> The repo's meaning stands, the report adopts it. `@playroom/fabric` is the authority engine — it
> exports `evaluate` and `Mandate` and knows nothing about visibility. It is a package name in 20+
> imports, against a report implemented nowhere. ADR-006 priced a rename of this size once and refused
> it at lower cost than it would carry now. The report's information-flow layer needs a different
> word; the repo does not move.

### A correction on the citation, recorded rather than smoothed over

The ruling stands as given. Its reference to ADR-006 is not quite what ADR-006 says, and an ADR that
cites another ADR inaccurately is the exact failure this ADR exists to prevent, so the accurate
version is recorded here.

ADR-006 did **not** price a rename and refuse it. It found `permit` in two places, called the rename
**cheap**, and _performed_ it:

> The rename is cheap now — the audit found `permit` in two places, neither of them a `permits/`
> directory, because that directory was never created.

What ADR-006 does establish — and what actually supports this ruling — is the principle in its
closing section: it landed the rename **earlier than scheduled**, "because the fabric package acquires
its first real surface area in the same slice and **renaming after that is more expensive than
renaming before it**."

So the argument is not "a rename of this size was refused before". It is ADR-006's own rule, applied
to its own package: rename cost grows with surface area, `permit` was renamed at two occurrences
precisely to avoid paying more later, and `fabric` now carries the surface area ADR-006 was
anticipating. The conclusion is unchanged; the reasoning is the repo's, accurately cited.

### Options rejected, and their costs

**Adopt the report's meaning.** Renames a workspace package and every import of it, in a tree where
ADR-006's own principle says that cost is now at its highest. It would also leave `evaluate` living
in a package named for information flow, which is worse than the collision.

**Split — `@playroom/fabric` keeps authority, a future visibility layer takes another name.** This is
not rejected so much as _already true_: the visibility layer exists as `assembly.ts`, unnamed as a
layer. The cost is that the report's architecture diagram no longer matches the tree, which the ruling
accepts by having the report move instead.

## Consequences

**Easier.** No import moves. `evaluate` stays where every caller expects it, and the package name
keeps meaning what its contents do.

**Harder.** Anyone reading the Fable report without the contract map beside them will reach for the
report's meaning, because the report reads like architecture and this ADR does not. That is the whole
reason this file exists.

**Foreclosed.** Using "Fabric" for information flow anywhere in this repository — in code, comments,
briefs or UI. The information-flow boundary needs its own word, and it is not this one.

## Reconsideration trigger

**The report being implemented under its own vocabulary.** If a Harbor/Fabric/Worker stack is ever
built here as the report describes, two things named Fabric would exist in one tree and this ruling
would be re-opened at a cost higher than today's. Nothing else triggers it: the report merely being
read, cited or extended does not.

## Status

Accepted — 16 Aug 2026.
