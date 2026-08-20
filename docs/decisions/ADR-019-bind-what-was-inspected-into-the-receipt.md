# ADR-019 — Bind what was inspected into the tamper-evident receipt

**Status:** accepted
**Date:** 2026-08-20
**Slice:** the capstone that ties ADR-016 (verify a receipt), ADR-017 (inbound screening) and ADR-018 (egress DLP) together

## Context

Two slices taught the fabric to see: inbound screening (ADR-017) classifies what untrusted text ENTERING a
room tries to do, and egress DLP (ADR-018) catches a secret in what LEAVES. Both computed a compact summary
and both, honestly, left it **in memory** — riding on a grokbot `ProposedReply`, or on a `document.added`
event, but never on the DECISION. Both ADRs named the same gap in their honest limits: the finding "does not
yet bind into the tamper-evident receipt." So a co-signer saw the summary at sign time, but nothing recorded,
tamper-evidently, that they saw it — and a third party verifying a receipt (ADR-016) could not see it at all.

This closes that gap: what the fabric inspected becomes part of the co-signed, hash-chained, independently
verifiable record.

## Decision

Add an optional `inspections` to the decision, carry it to the resolution, and let the existing machinery do
the rest.

- **`DecisionInspections`** (`{ inbound?: ScreeningSummary, egress?: EgressSummary }`) is a new shared shape.
  It is added, OPTIONAL, to the `decision` and `decision.resolved` payloads — so a plain `pr.merge` omits it and
  every decision written before this parses unchanged (the C1 optional-field discipline).

- **`requestActionCommand` — the sole decision constructor (M-3) — accepts `inspections` and records it** via
  `writeCoSignDecision`. This is an **in-process parameter only**: the `executeCommand` overload for
  `requestAction` does NOT carry it, so the HTTP actions door cannot forward a caller-supplied value. A caller
  asserting its own clean screening verdict would be worthless; only server-side code that actually ran the
  scan attaches one. The type layout enforces this — the door literally has no field to pass.

- **Signing carries it forward.** `signDecision` copies the decision's `inspections` onto the `decision.resolved`
  event. Because the **detached receipt (ADR-016) is built from the resolution**, `inspections` then lands in
  the receipt's `source_payload` — which is inside the hashed body — so the open verifier's existing BODY check
  already covers it. **No change to `@playroom/receipt` or its verifier was needed.**

- **Grokbot forwards what it inspected.** Its `propose` seam now carries `inspections: { inbound, egress }`; an
  in-process propose binds it onto the decision, and the summaries it already surfaced on the `ProposedReply`
  are the same objects that ride to the receipt.

## Consequences

- **The trust story is now end-to-end and verifiable.** A third party who exports a receipt and checks it with
  the open verifier (no trust in us) sees the co-signed outcome AND what the input tried and whether the output
  leaked — and that a server which flipped an inspection after the fact is caught: the regression test tampers
  `inspections.egress.risk` from `critical` to `none` after anchoring, and `verifyDetachedReceipt` refuses on
  the body check.
- **It is tamper-evident on the live chain too.** The decision event is a commitment event; `verifyAuditChain`
  re-hashes its payload, so an edit to the recorded `inspections` is detectable independently of the receipt.
- **One shape, three consumers.** `ScreeningSummary`/`EgressSummary`/`DecisionInspections` are shared zod
  schemas; the decision event, the resolution event, and grokbot all use them, and the wire validates them.

## Honest limits

- **Only the in-process path attaches inspections.** By design — the HTTP actions door drops them, because a
  caller cannot be trusted to screen itself. A governed cycle that runs in-process (grokbot, and Track E bridges
  to come) binds them; an external MCP/HTTP caller does not, and its receipt simply omits the field. That is the
  correct default (absent = "not inspected here"), not a silent gap.
- **The summary is compact, not the findings.** `inspections` carries risk + kinds + counts, never the evidence
  excerpts (and, for egress, never a secret byte — labels only). A verifier learns THAT the input tried to
  steer and THAT the output carried a secret, not the verbatim text; the full findings live in the logs, not
  the immutable record.
- **It records what was inspected, it does not gate on it.** Consistent with ADR-017/018: a co-signer reads the
  inspections and decides. Making the fabric refuse on an inspection verdict is still the separately-reviewed
  mandate/fact change both prior ADRs defer.
- **The document path is not yet bound.** A `document.added` event still carries its screening summary as its
  own field (ADR-017); it is not a decision, so it does not flow through this. Binding a document's screening
  into a decision would need a decision to hang it on (an upload is not co-signed today).
