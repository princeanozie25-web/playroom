# ADR-003: Agent turns are events

## Context

S0.3 introduces streamed agent output. It must interoperate with two existing
laws: §8's persist-before-fanout, and resume-from-last-id (S0.2). If agent output
lived outside the room event log — a side channel, an in-memory buffer — those
laws would need special cases for agents, and a client reconnecting mid-stream
would have no way to recover a partial turn.

## Decision

An agent turn is a sequence of ordinary room events, written to the same `events`
table with room sequence ids:

    agent.turn.started → N × agent.turn.delta → agent.turn.completed

They share a `turn_id` so the client groups deltas into one bubble. Because they
are ordinary events, resume-from-last-id replays a turn exactly like any message
history, and §8's persist-before-fanout holds unchanged: each delta is committed
before it is fanned out. `completed` carries the full assembled text plus §17
telemetry (adapter id, tokens, cost, latency, prompt hash, success); the deltas
are prunable once `completed` lands.

## Consequences

- More rows per turn, and a DB round-trip inside each delta's latency — deliberate
  and measured against the §7 budget in the slice's live smoke run.
- Resume replays a partial or complete turn to identical text; no side channel to
  reconcile.
- A failed turn is still a `completed` event, with `success = false` and an
  `error_class` — the room is never left silently hanging.

## Status

Accepted.

## Roadmap refs

§8 (ordering / persist-before-fanout); §17 (telemetry); §11.2 (S0.3). Builds on
[ADR-002](ADR-002-in-process-fanout-first.md) (in-process fan-out) and
[ADR-001](ADR-001-fail-closed-permission-engine.md).
