# ADR-002: In-process fan-out first

## Context

S0.2 introduces room event fan-out: an event persisted by one connection must
reach every other connection watching the room. The roadmap end-state (§3) is
Redis pub/sub so fan-out survives across processes. But today there is a single
Node process, no presence work, and no second process to reach. Standing up
Redis now buys nothing and adds infrastructure and failure modes for zero
current benefit.

## Decision

Room event fan-out is in-process (a single Node process, one in-memory bus)
until a second process or presence work exists. Redis pub/sub arrives with that
slice. Roadmap §3 remains the end-state; this is a staging decision, not a
reversal of it. The bus lives behind a narrow emit/subscribe seam so the swap to
Redis is a drop-in, not surgery.

## Consequences

- Horizontal scale is blocked until the Redis slice — deliberate, boring, and
  reversible.
- Fan-out for a single process is the simplest thing that is correct; there is
  no cross-process ordering to reason about yet.
- The seam is the contract: when Redis lands, the room and send-path code do not
  change, only the bus implementation behind the seam.

## Status

Accepted.

## Roadmap refs

§3 (realtime end-state / Redis pub/sub); §8 (realtime ordering law); §11.2 (S0.2
slice). Builds on [ADR-001](ADR-001-fail-closed-permission-engine.md)'s
fail-closed posture.
