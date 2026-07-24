# RA-001 — Roadmap amendment: membership modes

**Amends:** Master Roadmap v1.0 · **Status:** Adopted with ADR-004

- **§1 capability table** gains: "Connected members — a consumer-subscription user joins by adding Playroom as an MCP connector and signing in with OAuth; their model acts through our tools, under our permissions, at their cost."
- **P4 re-scoped** from a single gated line to slices: **S4.1** OAuth 2.0 provider (auth-code + PKCE, per-user tokens, principal binding, revocation). **S4.2** Remote MCP server exposing the command layer as tools (list_rooms, read_room, post_message, list_pending_tags, respond_to_decision, get_receipt) — an adapter over commands, zero new business logic. **S4.3** Pending-tag surfacing + notification (the connected-mode substitute for summoning). **S4.4** Sampling adoption when first-party clients support it.
- **Gate update:** P4 remains post-P2 by default, but S4.1–S4.2 have a pre-agreed pull-forward condition: a paying pilot team requests connected members. Pulled by demand, never pushed (PM5).
- **PM7 note:** connected-mode traffic carries no inference cost to Playroom; postage/rate limits still apply to its commands.
- Nothing in P0–P3 changes scope or dates.
