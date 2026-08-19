# Security

Playroom moves instructions, artifacts and decisions between agents belonging to **different
principals**. That is the interesting part and it is also the dangerous part, so findings against
the trust boundary are welcome and are treated as the most valuable contribution anyone can make.

## Reporting

Open a **private security advisory** on this repository (Security → Advisories → Report a
vulnerability). If that is not available to you, open a normal issue with the word `security` in
the title and **no exploit details**, and I will follow up privately.

Please include what you would want if you were reading it: the property you believe is violated,
the smallest sequence that violates it, and what you observed instead of what the code claims.

## What gets priority

In order:

1. **A permission or principal boundary can be crossed.** An agent acting beyond its mandate, one
   principal's context reaching another's, a room admitting a member it should refuse.
2. **A governed action's outcome can be misrepresented.** A decision that renders as something the
   fabric did not produce, or a refusal that is indistinguishable from an acceptance.
3. **A credential leaves the place it belongs.** Anything that puts a token in a log, a URL, a page
   payload or a repository.
4. Everything else.

## No SLA

This is a solo project. There is no on-call rotation and no response-time commitment — I will
acknowledge a report when I see it, and I would rather tell you honestly that something will take a
week than promise a day. If a report is urgent and unacknowledged, say so again; it means I missed
it, not that I judged it unimportant.

## What is already known

**Read [`docs/security/red-team-log.md`](docs/security/red-team-log.md) first.** It is the ledger of
findings against this system's own boundary, including the ones I caused and the ones that were
false when first claimed. Every entry carries a severity, a disposition and — where a finding is
accepted rather than fixed — the condition that re-opens it.

If your finding is already in there, that is still worth telling me: a finding I accepted may have
had its acceptance expire without my noticing, which has happened once and is recorded.

## Scope

Playroom's own code. Not the providers behind the adapters, not Postgres, not Docker. A model
saying something wrong is a model being a model; a model being **able to do** something its mandate
forbids is a Playroom bug and exactly what I want to hear about.

## Not yet true, and therefore not vulnerabilities

These are limits of the current build rather than defects. They are stated so nobody spends a
weekend reporting a gap that is already written down:

- **Identity authenticates a credential and process, not a real person.** OAuth and member
  credentials bind a session to a principal and support revocation; they are not strong
  real-person verification or proof of which human is operating a process.
- **Mandate signatures use a custodial key.** Unsigned, invalidly signed and tampered mandates are
  refused before scope is read. The current bootstrap signing key is operator-held rather than a
  principal-held or hardware-backed key.
- **Receipts are hash-chained, but public verification is incomplete.** The audit chain and daily
  root are tamper-evident and receipts are available through API/MCP. Per-entry fabric signatures,
  independent root publication and a complete public verification UI are not present.
- **External execution exists only through the sanctioned local-node path.** A compliant node must
  hold a live, scoped lease and receive an allowed node-operation decision. This does not control an
  arbitrary process already running outside that path, and the planned GitHub/email/A2A bridges do
  not exist.

The full version of this list, with what each limit means for a claim made on screen, is the
what-it-does-not-prove column of [`docs/demo/p0-claims.md`](docs/demo/p0-claims.md).
