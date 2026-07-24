# ADR-001: Fail-closed permission engine

## Context

The permission engine sits on the trust fabric — the single chokepoint every cross-boundary action passes through (roadmap §4.3, §12.2). Its availability and latency therefore gate whether the room can act at all. Its behaviour under unavailability, latency overrun, and unrecognised input must be fixed before any code depends on it, so the failure mode is a decision rather than an accident.

## Decision

If the permission engine is unavailable or evaluation exceeds its 100ms ceiling, all cross-boundary actions BLOCK; reads may continue. An action type not explicitly granted is denied. Unknown action types are denied.

## Consequences

- An incident banner is shown in-room whenever the engine is blocking, so the degraded state is legible to everyone present.
- Audit append failure also blocks cross-boundary sends: an unaudited action is worse than a delayed one.
- Reads continuing during an incident keeps the room readable while every commitment-shaped path stays closed until the engine recovers.

## Status

Accepted — pre-decided in roadmap §4.3 and §12.2.

## Roadmap refs

§4.3 (trust fabric / permission engine); §12.2 (fail-closed operating law).
