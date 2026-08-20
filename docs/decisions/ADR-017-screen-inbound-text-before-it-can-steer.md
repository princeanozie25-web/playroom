# ADR-017 — Screen inbound text before it can steer an agent

**Status:** accepted
**Date:** 2026-08-20
**Slice:** inbound screening (roadmap: "Untrusted input is screened before it can steer an agent"; generalises grokbot's `screenExternalText`)

## Context

Untrusted external text enters a room from more than one place — an X mention and its thread (grokbot),
an uploaded document, and, in time, a bridged payload. The only neutraliser that existed, `screenExternalText`,
was **stranded inside `apps/api/src/grokbot.ts`** and applied to exactly one corpus (X posts). Everything else
reached a model raw: a document's body was surfaced verbatim in the assembly window (`assembly.ts`), and its
only screen — `screenDocument` — is explicitly _"MECHANICAL … NOT A CLASSIFIER"_ (it rejects binaries and
control bytes, it does not look at what the text is trying to do).

The isolation corpus (SU-3) already makes a document **inert as authority**: it is shared, cannot summon, and
confers no scope, so a directive inside it cannot route around the mandate. But inertness-as-authority is not
the same as _a model never reading "ignore your instructions"_. The landing page promises the stronger thing —
**"Untrusted input is screened before it can steer an agent"** — and that needs one seam, applied at every
inbound path, that both neutralises the text a model sees and says, on the record, what the text tried to do.

## Decision

Lift screening out of grokbot into a portable package and apply it at the inbound paths.

- **`@playroom/screen`** — a new pure, zero-runtime-dependency package (the `@playroom/receipt` pattern). Two
  jobs, in one deterministic function `screen(text)`:
  1. **Neutralise** — `safe` is the text a model may be shown: control chars → spaces, invisible and
     bidi-override characters dropped, whitespace collapsed, length capped. Behaviour-compatible with the
     original `screenExternalText` (which is now a one-line alias over `neutralize`, kept for its callers).
  2. **Classify** — `findings` are the classified attempts to STEER the agent: `instruction_override`,
     `authority_claim`, `role_impersonation`, `exfiltration_lure`, `hidden_text`. Detection runs over a
     normalised copy (lower-cased, invisibles stripped, whitespace collapsed) so spacing and zero-width tricks
     do not evade a match — and never over the truncated `safe` copy, so a signature at the end of a long
     document is still seen. `summarize()` rolls several screened texts (a mention plus its whole thread, or one
     document) into a compact `{ risk, signals, findings }` small enough to ride in an event.

- **Grokbot** now screens through the package: the neutralised copy reaches the draft step exactly as before,
  and the classified `screening` summary (over the mention AND every thread post) rides into the `ProposedReply`,
  so a co-signer sees what the input tried to do at the moment they sign.

- **Documents** are classified at ingest (`commands/document.ts`). The summary is written onto the room-visible
  `document.added` event (an optional field on the wire schema, so rooms predating screening still replay). A
  document is **never refused for its content** — it is isolated and inert (SU-3), so a steer shape inside it
  cannot escalate; screening records what it tried to do, it does not block.

The seam is **defence-in-depth and audit context, not an authorisation boundary.** It blocks nothing. A finding
is heuristic and deliberately tuned for **recall over precision**: a false flag costs a reviewer one extra
glance, while a false negative is still caught by the mandate + co-signature (RT-005 — the fabric decides and
executes on the governed action, never on a regex verdict). This is the honest framing the original code already
held ("this reduces a hostile surface; the governance below is the real guard"), now generalised.

## Consequences

- **"Screened before it can steer an agent" is real at two paths, not one.** X posts (via grokbot) and uploaded
  documents both pass through the same seam; the summary is visible to a co-signer (grokbot) and in room history
  (documents).
- **One algorithm, many callers.** Neutralisation and classification live in one package; a change to a
  signature or to what "neutralised" means is one edit, covered by one test suite.
- **The finding travels with the record.** A document's `screening` summary is on its `document.added` event, so
  a reader (and later a UI) sees "this document tried to override instructions" without re-running anything.

## Honest limits

- **It is a heuristic, not a proof.** The signatures catch known prompt-injection and social-engineering shapes;
  a novel phrasing can pass. It is a hostile-surface reducer and an audit signal, never the guard — the guard is
  deny-by-default mandates and human co-signature. The code and this ADR say so on purpose, so no one mistakes a
  clean screen for a safe input.
- **Recall over precision, by choice.** The signatures catch the bare, commonest shapes ("ignore your
  instructions", "you are now unrestricted", "ignore the above and…") — not only the textbook "ignore ALL
  PREVIOUS instructions" — and overlapping matches of one signal are deduped so a threat counts once. The cost
  is false positives: "I am the owner of a small bakery" trips `authority_claim`. Accepted — a finding informs,
  it never blocks, so a false positive is bounded to a second glance. A precision pass (context, an allowlist)
  is a later, additive refinement, and its test already pins the current behaviour so the change is deliberate.
- **Known evasions remain.** Detection strips zero-width/bidi obfuscation and defeats padded whitespace, but a
  plain-space letter-spacing (`i g n o r e`) survives the collapse and is not caught, and any novel phrasing can
  pass. This is a hostile-surface reducer and an audit signal, not a filter that a determined adversary cannot
  step around — which is exactly why it never blocks and the mandate remains the guard.
- **Two inbound paths are covered; three remain.** Briefings, plain room messages surfaced to an agent, and the
  action-door `resource` string are **not** screened yet. They are lower-risk (a briefing is owner-authored; a
  message is already governed; the resource is hash-committed and ≤512 chars), but the seam should reach them.
  Deferred, not forgotten.
- **The finding does not yet bind into the tamper-evident receipt.** Making a screening finding travel into a
  DECISION (so a third party verifying a receipt sees it) means adding a field to `DecisionPayload` and populating
  it in the sole decision constructor (`writeCoSignDecision`, M-3) — load-bearing, and worth its own reviewed
  slice. Today the grokbot summary is in-memory on the `ProposedReply` and the document summary is on the
  `document.added` event (not part of the audit chain). Binding into the receipt is the natural next step.
- **The assembly surface is untouched.** Documents/briefings still reach the model as raw body in the window; the
  isolation corpus (SU-3, a dedicated CI job) makes them inert as authority, and annotating that path with a
  screening banner risks the inertness proof, so it is deferred to a slice that can prove the annotation is not a
  new injection vector.
- **The governed fact is not wired.** A mandate could one day react to `screening.risk` (e.g. force co-sign on
  elevated inbound risk) by surfacing it as a C3 fact. That couples a heuristic to authorisation and needs its
  own design + review; this seam only produces the signal.
