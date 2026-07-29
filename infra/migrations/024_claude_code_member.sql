-- 024 — THE FIRST BRIDGED MEMBER (S-CC, SCC-1).
--
-- `claude-code` is an agent member bound to `principal:prince`. What makes it different from every
-- member before it is not this row — it is a member like any other here — but its adapter: it invokes
-- a coding agent whose side effects are real, in a scratch workspace, OUTSIDE the fabric. Its
-- PARTICIPATION is governed (summoned, briefed, budgeted, depth-capped, attributed); its WORK is
-- bridged, not governed, until tool-call mapping lands. The disclosure lives in the red-team ledger
-- (RT-005's retirement) and in mandates/README.md; it cannot live in the strict mandate JSON.
--
-- Its mandate (mandates/claude-code.json) grants NOTHING: scope []. It holds no summon.initiate, so it
-- cannot summon anyone — in the loop, the briefing member summons IT. `adapter_id` names the adapters.yaml
-- entry, which this commit adds DISABLED; the adapter implementation and its enabling are SCC-2, so
-- nothing constructs or warms it yet. `display_name` is "Claude Code" so its summon tokens ("@claude code",
-- "@claude-code") do not collide with "@claude", which still names claude-main.

INSERT INTO members (id, kind, display_name, principal_id, adapter_id) VALUES
  ('claude-code', 'agent', 'Claude Code', 'principal:prince', 'claude-code')
ON CONFLICT (id) DO NOTHING;
