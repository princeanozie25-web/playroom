# ADR-014: Authority may depend on facts the caller assembles

## Context

The evaluator is a pure function (ADR-010, Bible §11): it receives a request, a member, a mandate, a
clock and a room roster, and it does no I/O. That purity is what makes the decision table a table and
keeps every authority decision in microseconds. But it also means authority **cannot depend on
history**: "may push to `main` only after the tests passed" is not merely unwritten, it is
unexpressible — there is no input in which "event X happened earlier" could be stated.

The Drift rail (Track C's acceptance test) needs exactly that condition. And history-aware refusal
already exists in the repo — the loop runner refuses on spend, interrupt budget, expiry and counts,
all read from the event log — but it lives in the runner, not the fabric, and the two have never been
joined. C3's question: **how does the evaluator gain a temporal condition without gaining a database?**

## Decision

**The caller assembles a facts object and passes it in; `evaluate` stays pure.**

- `evaluate` gains a parameter `facts: readonly string[]` — the set of fact keys that currently hold,
  computed by the caller from history. Inside the evaluator it is a membership test, nothing more; no
  I/O, no query, the <10 ms budget untouched.
- A host grant (`host_scope` / `host_protected`) may carry `requires: [factKey, ...]`. A grant applies
  only when its resource matches **and** every required fact is present. A grant that matched the
  resource but whose facts are unmet yields a new verdict, **`CONDITION_UNMET`** — a BLOCK that means
  _not yet_, distinct from `OUT_OF_SCOPE`'s _never_ and `RESOURCE_OUT_OF_SCOPE`'s _not there_. When the
  facts hold, the grant resolves to its underlying verdict (ALLOW, or CO_SIGN for a protected ref).
- The **fact source** is the caller's, not the actor's. On the node-op door the trusted API assembles
  the room's facts from `room_checks` — a table a node writes to by REPORTING a check `{name, passed}`
  under its lease — where the fact `<name>_passed` is true iff the latest report for that name passed.
  The op body never carries a fact; a node cannot self-authorise by claiming one.

So "no push to `main` until tests pass" is `host_protected: [{action:"git.push",
resource:"refs/heads/main", requires:["tests_passed"]}]`: CONDITION_UNMET until a passing `tests` check
is reported, then CO_SIGN.

### The honest limit

The check is a **self-report by the leased node** — attributable (member + lease, recorded) and
auditable, but only as trustworthy as that node; a node that lies leaves a lying record. A check
reported by a DISTINCT verifier, or a signed CI result, is the provenance-hardening follow-up. C3
delivers the mechanism (authority gated on a recorded fact, deny-by-default when no fact holds); the
fact's provenance strength is a separate axis, stated so it is not mistaken for a cryptographic proof.

### Options rejected, and their costs

**Hand the evaluator a pool / projection.** Would make every authority decision an I/O operation and
end the purity that makes the table a table (Bible §11). Rejected: the facts object keeps the cost
where the caller can see it, and keeps `evaluate` a function of its inputs.

**Let the actor pass facts in the request.** Trivial, and it is self-authorisation — a node claiming
"tests passed" to open its own gate. Rejected: the fact must be established by the trusted caller from
the log, never asserted by the party the fact gates.

**Model checks as a new `ServerEvent` type.** More uniform, but the strict `ServerEvent` union is
parsed on every replay and shared with the web client — a new type is a wire change with deploy-skew
risk. A dedicated `room_checks` table carries the facts with no wire surface. Rejected for v1.

## Consequences

**Easier.** Authority can now depend on history; the Drift rail is real and tested. The mechanism is
general — any host grant can carry `requires`, and the fact set is one indexed read.

**Harder.** There is a new axis of trust (a fact's provenance) that a reader must not confuse with the
mandate's cryptographic authenticity. And a conditional grant BLOCKs by default when no facts are
passed — correct, but a caller that forgets to assemble facts will see CONDITION_UNMET, not ALLOW.

**Foreclosed.** Nothing. Facts on abstract actions (not just host ops), and verifier-signed checks,
both remain available.

## Reconsideration trigger

**A fact that gates something irreversible, or a second fact source.** The moment a fact opens a path
to a real external side effect (past RT-005), the self-report limit above stops being acceptable and a
verified check (distinct reporter or signature) becomes required. Re-read this ADR before wiring a fact
to anything that acts.

## Status

Accepted — 19 Aug 2026.
