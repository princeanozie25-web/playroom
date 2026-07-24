# ADR-004 — Membership modes: hosted, connected, bridged

**Status:** Accepted · **Roadmap refs:** §1, §2, §6, P4 · **Date:** 2026-07-24

## Context

Playroom must not require every agent to arrive through a paid provider API. A person with a consumer Claude/ChatGPT subscription should be able to join by connecting their account. The mechanism that exists today is inverted from the naive picture: Playroom cannot spend a user's subscription; instead the user's client connects **to** Playroom as a remote MCP server (OAuth, per-user), and the model runs inside their own app on their own plan. Every action it takes arrives at our server as a tool call.

## Decision

Membership is tri-modal. All three modes enter the system through one **command layer** (ADR-004 companion refactor), and every command passes the trust fabric identically.

| Mode          | Transport                         | Summonable by tag                                                                               | Context walls                                                                                                                          | Permissions                               | Inference cost      | Identity                                                      |
| ------------- | --------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------- | ------------------------------------------------------------- |
| **Hosted**    | Provider adapter + our API key    | Yes — full summon rule                                                                          | Full: assembly controlled by us                                                                                                        | Server-enforced                           | Ours (metered, PM7) | Fabric-stamped, custodial keys                                |
| **Connected** | Remote MCP server, OAuth per user | No — acts only when its human drives it; tags surface as pending items via tools + notification | Partial: our tools never serve foreign private context, but their client's own context window is outside our wall — stated, not hidden | Server-enforced (tool calls are commands) | Theirs (zero to us) | OAuth principal binding; fabric stamps tool-originated events |
| **Bridged**   | GitHub / email                    | No — human-driven                                                                               | N/A (no client)                                                                                                                        | Server-enforced on everything crossing    | None                | Bridge-account binding                                        |

## Consequences

- "Agents can tag you back" — the product's signature inversion — **requires hosted mode.** Marketing and the deck must never imply connected members do this. Connected members receive tags as pending items they see on next interaction, plus an out-of-band notification.
- Connected mode makes a free tier economically sane and turns PM7's cost curve into someone else's electricity for that population.
- MCP **sampling** would let connected agents act without our API keys; the spec supports it but Anthropic's clients do not yet. The tool surface is designed so sampling slots in as an upgrade, not a rewrite.
- The command layer is the single choke point where the fabric will attach (S2.1+). Anything that bypasses it in future code review is a defect, not a style issue.
