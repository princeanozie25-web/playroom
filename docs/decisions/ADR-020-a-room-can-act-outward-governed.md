# ADR-020 — A room can act outward, governed (the write executor)

**Status:** accepted
**Date:** 2026-08-20
**Slice:** the governed outbound-write executor — 5a of the "bring a room into GitHub, email, and other agents" roadmap line

## Context

Everything shipped so far lets a room DECIDE and RECORD, never ACT: `requestAction` reaches a verdict, a
human co-signs, and — for anything but an internal summon — the approval fires nothing. signDecision's own
comment names the gap: an approved `pr.merge` hits a branch that says _"No executor exists yet, so nothing was
performed (S2.6)."_ Grokbot is the sharpest example: it drafts a reply, gets it co-signed, and its `posted`
field is a literal `false` because _"there is simply no write seam here."_ The landing line "bring a room into
GitHub, email, and other agents" needs the room to be able to actually SEND — under the same governance.

The x-read seam was built read-only on purpose, and said why: posting back is _"a governed WRITE that must
travel the Execution Gate … it does not belong on the source that also holds the read credential."_ So the
write path is a separate seam with its own credential, and it runs only after a human co-signed the exact
content — never on the fabric's initiative (RT-005).

## Decision

Add a **second `pending_action` kind** and the executor that fires it — the discriminated union the code
already anticipated (_"a discriminated union is how a second executable kind lands"_).

- **`@playroom/write`** — a new provider-neutral, credential-holding package (mirror of `@playroom/x-read`):
  a `WriteBackend` interface (`perform(WriteRequest) → WriteReceipt`), a **`MockWriteBackend`** that performs
  nothing real (records the write, returns a synthetic `mock://…` ref, idempotent by key), and
  `createWriteBackend(env)` which DEFAULTS TO THE MOCK — so a deployment that has not deliberately wired a
  credentialed writer sends nothing real, and selecting an unbuilt real backend throws at construction.

- **`pending_action` is now a union** — `summon.initiate | write.perform`. A `write.perform` action carries the
  medium (== the co-signed action, e.g. `x.reply`), the target, the **exact co-signed body**, and its
  `body_hash`. It reaches a decision the same trusted, in-process way inspections do (ADR-019):
  `requestActionCommand` gained an optional `pendingAction`, passed only by server-side code, never the wire.

- **`fireWrite`** runs from signDecision step 8, on an APPROVED `write.perform` decision — beside `fireSummon`,
  not re-evaluating (the co-signature is the authorisation). It performs through `deps.writeBackend` and records
  a **`write.performed` event** (medium, target, backend, ref or a coded failure). Two guards: it re-hashes the
  body and REFUSES to send if it no longer matches `body_hash` (content edited between co-sign and fire is
  never posted), and it never throws into the sign flow — a backend failure is recorded, not unwound, because
  the approval already happened.

## Consequences

- **The "no executor" branch now has a sibling.** An approved write is performed and receipted; the room's
  record of it is the `write.performed` event, the executor's analogue of `summon`. Firing is at-most-once
  (the resolution's single-use index, migration 020) and idempotent in the backend besides.
- **Nothing real is sent without deliberate configuration.** The Mock is the default and the only implemented
  backend; every test runs against it, so the whole co-sign → perform path is exercised with zero risk of a
  real post. The full pipeline is now expressible end-to-end: inbound screen (ADR-017) → propose with egress
  scan (ADR-018) → CO_SIGN with the findings bound (ADR-019) → human APPROVES → `fireWrite` performs → receipt.
- **RT-005 holds.** The fabric still executes nothing on its own; a human's approval is the only thing that
  reaches `fireWrite`, and it performs exactly the co-signed, hash-verified content.

## Honest limits

- **No producer yet — this is the machinery.** Nothing constructs a `write.perform` decision in this slice;
  `requestActionCommand` merely CAN carry one. Grokbot attaching it to its co-signed reply (so an approved
  reply actually mock-posts, closing the `posted: false` gap) is the next slice (5b).
- **Only the Mock backend exists.** Real posters — an X writer, a GitHub commenter, an email sender — are each
  a distinct credential holder and a separately-reviewed slice, gated behind `WRITE_BACKEND` and their own key.
  The factory names them and fails loudly until they are built; the first real one needs an explicit go and a
  live credential, because it is the first slice that can cause a real external effect.
- **The co-signed body rides in the decision payload.** For a reply/comment that is short and is exactly what
  gets published (and was egress-screened), that is fine and auditable; a large payload would want storage by
  reference instead. Bounded today by the mediums in view.
- **It informs on egress, it does not re-gate at fire.** The content was egress-screened before co-sign and the
  human approved the exact body; `fireWrite` sends what was signed (after the hash check), rather than
  re-scanning and second-guessing the human. A fire-time egress re-scan is a possible belt-and-braces later.
