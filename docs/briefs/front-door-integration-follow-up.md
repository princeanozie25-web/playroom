# Front Door Integration follow-up — 19 August 2026

This note records documentation that was stale while the public landing page was written.

- `README.md` contained an old architecture-diagram note saying the hash chain was not present and
  described all credentials as development-only. Those statements are corrected; Fabric is named as
  the authority engine.
- `SECURITY.md` repeated the older unsigned-mandate / no-receipt posture. Its limitations now describe
  custodial mandate signing, hash-chained receipts, credential/process identity and sanctioned-path
  local-node authority.
- `docs/roadmap/STATUS-2026-08-18.md` predates the working signed-mandate, audit, MCP, OAuth and lease
  paths. It should carry a historical-snapshot warning; its body remains planning provenance.

This is a focused status correction, not a rewrite of historical planning. Claims on the public
landing surface are grounded in current architecture and code; it also states the remaining
verification and local-node limits explicitly.
