# ADR-012: The Execution Gate decides; a Local Node executes

## Context

Invariant #7 — "local access must be mediated through a trusted node rather than an unrestricted
shell" — is the one invariant the repository openly does not hold
(`docs/audits/2026-08-fable-contract-map.md`, row 7). `claude-code`'s _participation_ is governed
(it authenticates as a member, asks before a protected action, waits for a co-signature), but its
_work_ — files written, commands run, commits made in a scratch workspace — happens OUTSIDE the
fabric. RT-005 is the disclosure: the fabric DECIDES a governed action and executes NOTHING; the
`No executor exists yet` branch (`signDecision.ts`) and the `nothing else happens` ALLOW path
(`requestAction.ts`) are where "decide but do not act" lives.

C1 (the Execution Gate) is the slice that begins to close #7. It raised one load-bearing question:
**when a host file/git/shell operation is proposed, does the fabric run it, or only rule on it?**

## Decision

**The gate DECIDES; it never executes. A Local Node (C2) executes.** Prince's ruling, 19 Aug 2026.

A host operation is an `ActionRequest` whose `type` is in a fixed host namespace (`fs.*`, `git.*`,
`shell.*`) and whose `resource` — inert for every abstract action until now — is matched against a
**resource-scoped host policy** carried in the member's mandate (`host_scope` and `host_protected`,
each a list of `{action, resource-glob}`). It rides the existing `executeCommand → requestAction →
evaluate` gateway; `evaluate` stays pure. The verdict is ALLOW / CO_SIGN / BLOCK. **Nothing runs.**
RT-005 is preserved on purpose: a compliant Local Node (C2) is what executes an op — only on this
ALLOW, and only while it holds a revocable lease. Until C2, #7 moves from FALSE to
_mediated-by-contract_; it becomes _unbypassably_ true when a node that cannot skip the gate lands.

Two sub-rulings, both enforced in `evaluate`:

- **Confinement for `fs.*`/`git.*`.** A granted type whose resource matches no allowed pattern is
  BLOCK (`RESOURCE_OUT_OF_SCOPE`) — a write stays in the workspace, a push stays on its granted
  refs. A `host_protected` match (e.g. `main`) is CO_SIGN and outranks an allow match.
- **`shell.*` is allowlist + co-sign the rest.** A command matching an allowlist pattern is ALLOW;
  a command under a granted `shell.*` type but off the allowlist is CO_SIGN
  (`SHELL_NOT_ALLOWLISTED`), so a human approves the exact command. Never a raw shell; never a
  silent block. A member with no `shell.*` grant at all is BLOCK (`OUT_OF_SCOPE`) — co-sign-the-rest
  needs a grant to be the rest _of_.

### Options rejected, and their costs

**Gate that also executes a constrained op set in-fabric.** Would flip #7 end-to-end now, but puts
host execution inside (or bundled with) the API process, deliberately weakens the "no external side
effect anywhere" guarantee before a lease/revocation exists, and pulls C2's sandbox work forward
into C1. Rejected: decision and execution are different trust surfaces, and the API is the wrong
place for a shell. The roadmap already separates them (C1 gate, C2 node), and this keeps that line.

**`shell.exec` blocked entirely in v1.** Smallest surface, but a coding worker that can read and
write but never run a test or a formatter is not the worker the product is for, and "block" teaches
nothing — allowlist + co-sign lets routine commands flow and escalates the rest to a human, which is
what a gate is for.

**A resource pattern DSL (Cedar-style) instead of globs.** More expressive, much larger, and it
imports a policy language before there is a second policy to justify one. Globs (`**` any, `*` within
a segment) cover confinement and allowlisting; the DSL is a reconsideration trigger, not a v1.

## Consequences

**Easier.** Host authority is now expressible and testable: the resource participates in the
verdict, the whole fabric (signed mandates §0, expiry, roster, co-sign) applies to a host op
unchanged, and C2 has a gate to call. Optional mandate fields mean not one shipped signature
changed.

**Harder.** The gate is only half of #7. It is inert until a Local Node calls it and refuses to run
anything it did not ALLOW — so the invariant is not closed until C2, and a reader who sees "Execution
Gate: shipped" must also read "enforced by C2, pending." The honest label is _mediated-by-contract_.

**Foreclosed.** Nothing. In-fabric execution and a policy DSL both remain available at their stated
costs.

**Deferred, by design.** Production `claude-code.json` carries no host policy yet: adding it changes
the signed document, which needs the custodial signing key (`scripts/sign-mandates.ts`,
`PLAYROOM_MANDATE_SIGNING_KEY`) that lives nowhere in the tree. The exact block to add is recorded in
`mandates/README.md`; Prince re-signs to activate it, the same way any authority change ships.

## Reconsideration trigger

**The Local Node (C2).** The moment a node executes an op on the gate's verdict and holds a lease,
the gate stops being advisory: its ALLOW becomes a real side effect, "mediated-by-contract" becomes
"mediated", and a bare `shell.exec` allowlist that seemed cautious may need history-aware conditions
(C3's facts object — "only after tests pass"). Whoever builds C2 should re-read this ADR before
wiring an executor to an ALLOW.

## Status

Accepted — 19 Aug 2026.
