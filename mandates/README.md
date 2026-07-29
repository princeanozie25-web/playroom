# mandates/

Mandate documents, one per member, versioned in git exactly like prompts (Bible §9.5).
Every evaluation logs the hash of the document it decided under, so a behavioural change
is answered with a diff and a revert rather than archaeology.

Shape: Bible §9.1. **`sig` is omitted, not stubbed.** Mandates are unsigned in v0 and a
placeholder `ed25519:` string would make a document look verified — omit, never stub.
S2.1 adds signing and the `sig_valid()` branch together.

Also omitted, and for the same reason: `room` (mandates are per-member, not per-room,
until S1.1 has rooms with membership) and `route_constraints` (route selection does not
exist until S1.1).

`scope` and `protected_actions` are drawn from the **command layer** — the action surface
`executeCommand` already dispatches on — not from a wishlist. `pr.merge` is listed as
protected because it is beat 5 of the demo; **nothing executes it, and nothing needs to.**
The refusal happens before any executor exists, which is the architecture working.

## `claude-code` — the bridged member (S-CC), and the disclosure the JSON cannot carry

`claude-code.json` grants **nothing**: `scope: []`, no protected actions, no `summon.initiate`, and
`interrupts_per_day: 0` (a cap of zero, not an omission — an absent limit would read as _unlimited_).
That emptiness is deliberate and load-bearing. This member's adapter invokes a coding agent whose
side effects are **real** — files written, commands run, commits made — in a scratch workspace,
**outside the fabric**. Its mandate governs its **participation** (it is summoned, briefed, budgeted,
depth-capped, attributed); it does **not** govern its **work**, because its work does not travel the
command layer the evaluator sees. An empty scope is the honest shape of that: the fabric grants it
nothing, because the fabric is not what its work answers to — yet.

**The disclosure lives here, not in the mandate, because the mandate schema is `.strict()`** — an
extra `note` field is a parse error, and rightly so. So it is written where it can be read: this
paragraph, and in full (with the compensating controls and the named residual) in the red-team
ledger's RT-005 retirement (`docs/security/red-team-log.md`). The one sentence every surface that
renders this member must honour, per ADR-004: **participation governed; work bridged.** Nothing may
imply its work is governed until tool-call mapping brings that work inside the fabric.

Changes ship under a `feat/mandate` prefix (Bible §9.5).
