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

Changes ship under a `feat/mandate` prefix (Bible §9.5).
