# ADR-018 — Nothing leaves without passing egress checks

**Status:** accepted
**Date:** 2026-08-20
**Slice:** egress DLP / canary (roadmap: "Nothing leaves without passing egress checks"; the mirror of ADR-017 inbound screening)

## Context

Inbound screening (ADR-017) asks whether text ENTERING a room tries to steer the agent. That is one half of
the exfiltration story; the other half is the OUTBOUND path — a drafted reply, and in time a bridged write.
An agent that was steered (by an injection inbound screening flagged, or simply by a careless prompt) into
putting a secret into its reply would leak it the moment that reply is sent. The landing page promises the
guard: **"Nothing leaves without passing egress checks."** Nothing did the checking.

The two halves are symmetric but not identical, and the difference is the crux: an inbound finding may quote
the offending text back to a reviewer, but an egress finding must NEVER quote what it caught. A DLP scanner
that echoed the secret into a finding, a log, or a receipt would be exactly the leak it exists to prevent.

## Decision

Ship a portable egress scanner with redaction as a first-class property.

- **`@playroom/egress`** — a new pure, zero-dependency package. `scan(text, {canaries})` finds secrets by
  SHAPE — a private-key block, cloud/service tokens (AWS, GitHub, Slack, Google, Stripe, AI-provider keys),
  a JWT, a Bearer token, a connection-string password, a `secret = <value>` assignment, and Playroom's own
  `prm_` credential — plus any pre-seeded **canary**. It returns two things and no third: **findings that carry no secret bytes** — evidence is
  `<label> · <n> chars` (e.g. "GitHub token · 40 chars"), never a character of the value — and a **`redacted`
  copy** of the text with every secret replaced by `«redacted:<label>»`, so a human sees WHERE and WHAT KIND
  without seeing the value, and that copy is safe to log, show, or receipt. `summarize()` rolls scans into a
  compact `{risk, labels, findings}`. Severity: a private key, an internal credential, or a canary is CRITICAL
  (no legitimate outbound content contains them); a third-party token or assignment is ELEVATED.

- **Grokbot** scans the OUTBOUND draft before it is put up for signature; the egress summary rides on the
  `ProposedReply` to the co-signer. This is the exfiltration story closed on both ends: inbound screening
  flags the manipulation attempt, egress DLP catches a secret that reached the output.

Like inbound screening, egress DLP **informs and records; it is not itself the gate.** A grokbot reply is
already co-signed by a human and never auto-posted (RT-005), and the egress summary is what lets that human
decline a draft that leaks. The scanner blocks nothing on its own.

## Consequences

- **The trust story is symmetric.** ADR-017 guards the way in, ADR-018 the way out, through matching portable
  seams; a future bridge (Track E) that performs a real WRITE scans its payload through the same package
  before the human co-signs it.
- **A canary makes exfiltration loud.** A value seeded as a honeytoken has no legitimate reason to appear in
  outbound content, so any occurrence is a critical finding a reviewer should never approve — a tripwire, not
  a heuristic.
- **The redaction discipline is proven, not promised.** The tests assert that no window of a secret appears in
  any finding and that the redacted text masks it — the scanner cannot become the leak. Redaction covers the
  UNION of every detected secret: overlapping matches are merged (never one dropped), and the report cap bounds
  only the findings LIST, never the redaction or the risk grade — so no secret tail survives past a placeholder
  and no attacker can starve a canary by prepending token-shaped filler. An adversarial review found three
  ways secret bytes leaked into the "safe" text (a cap that stopped redaction, an overlap that dropped a span,
  a value char-class that truncated a dotted secret) and a quadratic ReDoS; all four are fixed and pinned by
  regression tests.

## Honest limits

- **It is shape-matching, not proof.** Known credential formats (private keys, cloud/service tokens, JWTs,
  Bearer tokens, connection-string passwords, `key = <value>` assignments, Playroom's `prm_`) and exact
  canaries are caught; a secret with no recognisable shape and no `key =` context — notably a bare 40-char AWS
  _secret_ access key, or a novel token format — can pass. It is a leak-surface reducer and a tripwire, not a
  guarantee that no secret ever leaves.
- **Generic high-entropy detection is deliberately omitted.** Playroom's own audit chain is full of SHA-256
  hashes; a blanket "high-entropy string" detector would cry wolf on every receipt. Precision was chosen over
  that noise; the cost is that an unshaped high-entropy secret is not flagged on its own.
- **It informs, it does not hard-block.** A critical finding (a private key, a canary) argues strongly for a
  gate, but making the fabric REFUSE the action on an egress verdict couples a heuristic to authorisation and
  is a mandate/fact change (surface `egress.risk` as a governed fact, mirror of ADR-017's deferral). That is a
  separately-reviewed step; today the co-signer is the block.
- **One egress path is covered; the write paths are the point.** Only the grokbot draft is scanned so far,
  because it is the only outbound content today. The payoff lands when Track E bridges perform real writes —
  each must scan through this seam before co-signature. Wiring those is the follow-up, not this slice.
- **The finding does not yet bind into the receipt.** Like the inbound summary, the egress summary rides
  in-memory on the `ProposedReply`; carrying it into the tamper-evident decision is the same deferred
  `DecisionPayload`/M-3 change flagged in ADR-017.
- **Canaries are supplied, not yet managed.** `scan` takes canaries as a parameter; a room does not yet
  register or rotate its own honeytokens. That registration surface is a later, additive slice.
