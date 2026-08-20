# ADR-016 — Verify a receipt without trusting us

**Status:** accepted
**Date:** 2026-08-19
**Slice:** independent receipt verification (roadmap: "Verify any receipt yourself, without trusting us"; builds on A3, the tamper-evident audit chain)

## Context

A3 gave the room a tamper-evident audit chain: every commitment (a co-signed `decision` and its
`decision.resolved`) is folded into an append-only `audit_chain`, each row linked to the last by a
hash, the newest `entry_hash` anchored externally so even a wholesale rewrite is detectable (Bible
§17). The landing page makes a bigger promise than A3 shipped, though — **"Verify any receipt
yourself, without trusting us."** What existed was `get_receipt` / `receiptForDecision`: the server
answering "here is your receipt, and I checked it — `verified: true`." A server vouching for its own
record is a _claim_, not a proof. The verifying party had to trust the very system the receipt is
supposed to hold to account.

## Decision

Ship the proof, not the claim: a **detached receipt** plus an **open, portable verifier**.

- **`@playroom/receipt`** — a new package holding the OPEN algorithm (`bodyHash`, `entryHash`,
  `GENESIS`, over fabric's `canonicalise`) and `verifyDetachedReceipt`. `apps/api/src/audit.ts` now
  imports these primitives instead of keeping private copies, so the chain and the verifier share
  **one** hashing algorithm by construction — they cannot drift into disagreeing about what "the
  body" is. Runtime deps: `@playroom/fabric` and `node:crypto`, nothing else.

- **The detached receipt** (`detachedReceiptForDecision`, exposed at
  `GET /rooms/:id/decisions/:decisionId/receipt`) carries everything a third party needs to verify
  offline: the **raw source payload** (so its `body_hash` is re-derived, never trusted), the entry's
  metadata and hashes, the anchored **root**, and the **inclusion path** — every chain entry from the
  receipt's own entry to the root, so the verifier walks the links forward and confirms the entry
  belongs to the chain that produced that root. It is gated by room MEMBERSHIP exactly like
  `receiptForDecision` (a non-member gets a 404 indistinguishable from "unknown" — a receipt is not a
  probe for which decisions exist), because exporting one discloses the decision's payload. What it
  discloses, anyone can then check.

- **`verifyDetachedReceipt`** runs three independent checks — BODY (re-hash the payload → `body_hash`),
  ENTRY (recompute `entry_hash` from its parts), CHAIN (walk the path to the root) — and is pure: same
  input, same verdict, on any machine. `scripts/verify-receipt.ts` is the standalone tool; its
  `--demo` builds a receipt offline and shows it catch a flipped payload and a forged link.

The trust boundary is drawn honestly: the verifier proves a receipt is internally consistent AND
reaches a _stated_ root. The one thing it cannot know is whether that root is the real one — so the
principal compares it against the root they received out of band (Bible §17). That comparison is the
only step that matters, and it is exactly the step that needs no trust in us.

## Consequences

- **The trust story's capstone is now real, not documentation-only.** The room already surfaces the
  receipt (decision id + mandate hash, ADR-015's DecisionCard line); now the receipt can be _exported
  and independently verified_. "Verify yourself" stops being a roadmap word.
- **A lying server is caught.** The regression test proves it: edit the source event after anchoring,
  serve the receipt with the real chain entry, and the open verifier refuses — `body=false` — without
  ever asking the server whether it is honest.
- **One algorithm, two consumers.** `audit.ts` (build + server-side verify) and the standalone
  verifier share `@playroom/receipt`; a change to the hash is a change in one place, caught by both
  the chain's tests and the verifier's.

## Honest limits

- **`sig` is still NULL (A3's deferral stands).** The chain is tamper-_evident_ via hashes + the
  anchored root; a fabric signature over each entry (non-repudiation) needs a runtime signing identity
  that deliberately does not exist yet. The detached receipt carries no `sig`, and does not pretend to.
- **The root comparison is manual and out-of-band.** There is no automated "is this the anchored
  root?" oracle here — by design, since an oracle we host would reintroduce the trust we are removing.
  A public, independently-hosted root ledger is a later, additive bar.
- **The inclusion path reveals other rooms' commitment METADATA (not payloads), and is O(entries after
  this one).** The audit chain is one global linked list (all rooms interleaved), so proving a receipt
  links forward to the root discloses the `{room_id, actor_id, event, source_seq}` of the commitments
  anchored after it — which rooms had a decision, who signed, when — to the exporting member. It does
  NOT disclose any decision payload. That metadata is load-bearing for soundness: the verifier
  recomputes each intervening `entry_hash` from it, so it cannot simply be stripped without letting a
  server forge an intermediate link. Closing this properly is a chain change (commit `entry_hash` to a
  `meta_hash` instead of raw meta, or per-room chains, or a Merkle-ised chain giving O(log n) proofs) —
  and any of those **invalidates already-anchored roots**, so it is deliberately deferred rather than
  done here. It is latent today (the live deployment is effectively single-tenant) and must be closed
  before multi-principal, multi-room tenancy. This slice verifies the chain A3 built; it does not
  re-shape it.
- **No in-app verifier UI yet.** Verification is API + CLI today (the honest-limits section on the
  landing says as much); a one-click in-room "verify this receipt" view is the natural next step.
