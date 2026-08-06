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

## `claude-code` — the connected member (SCC-2), and the line the JSON still cannot carry

`claude-code.json` now grants authority over its REQUESTS, not its work — Prince's ruling (SCC-2),
transcribed, not a value a slice chose: `scope` grants `pr.open` / `pr.review` / `pr.comment` outright,
and `pr.merge` / `deploy` under co-signature by `principal:prince`; `interrupts_per_day: 6`. Each
protected action is in BOTH `scope` and `protected_actions` on purpose — `evaluate` checks scope before
protection (RA-007), so a protected action absent from scope would BLOCK as out-of-scope rather than
co-sign. The scope was empty until SCC-2 for a reason that has now been answered: an agent's consequential
ASK can travel the command layer the evaluator sees — in-process (S2.1a) and from a laptop through the
authenticated door (S2.1b) — so a mandate that governs those asks is finally enforceable rather than
decorative.

**What is STILL bridged, and this is the line that matters: its WORK.** claude-code invokes a coding
agent whose side effects are real — files written, commands run, commits made — in a scratch workspace,
OUTSIDE the fabric. The mandate governs its **participation and its requests** (it authenticates as a
member, reads and speaks, asks before a protected action and waits, and — since SCC-3 — raises a bare
hand when it needs a human but has nothing to ask for, priced by the same `interrupts_per_day` budget as
any other claim on a person's attention); it does NOT govern its **workspace work**, because that work
does not travel the command layer. Nothing stops it running `pr.merge` in its
own shell and narrating it afterwards — the fabric refuses that only when it is ASKED through the door.
That residual is RT-005 (`docs/security/red-team-log.md`), and SCC-2 does not close it. The one sentence
every surface rendering this member must honour, per ADR-004: **participation and requests governed;
work bridged.** A posted closeout is a message, not a receipt.

Changes ship under a `feat/mandate` prefix (Bible §9.5).
