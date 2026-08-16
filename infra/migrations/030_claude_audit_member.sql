-- 030 — THE BRIEF-WRITER GETS ITS OWN MEMBER (AUDIT-FABLE).
--
-- `claude-audit` is an agent member bound to `principal:prince`, running the same provider and model
-- as `claude-main`. It is NOT a better writer; it is a SEPARATE ONE, and the separation is the whole
-- reason it exists.
--
-- ── WHY A NEW MEMBER RATHER THAN REUSING claude-main ─────────────────────────────────
--
-- A standing order's stop-interrupts are charged to its ACTION MEMBER (S-DIAL), and `interrupts_per_day`
-- is per raiser per day. A twelve-cycle audit loop at dial 3 needs four tellings — three attendance
-- pauses and one FINISHED — and claude-main's six are spent by everything else that happens in a day.
-- A loop sharing a voice with the rest of the room goes silent partway through and pauses on a budget
-- it did not spend, which is the failure SD-1 exists to make impossible rather than merely visible.
-- So the loop gets a member whose six belong to it.
--
-- ── ITS MANDATE GRANTS NOTHING, AND THAT IS THE POINT ────────────────────────────────
--
-- mandates/claude-audit.json carries `scope: []`, no protected actions and nothing to co-sign — the
-- narrowest document in the directory, matching the shape migration 024 used for claude-code. A member
-- that reads a room and posts a brief needs no governed action to do either, so the honest scope is the
-- empty one: every governed emission it could make resolves BLOCK by default-closed.
--
-- `display_name` is "Claude Audit", so its summon tokens ("@claude audit", "@claude-audit") do not
-- collide with "@claude", which still names claude-main — the same care migration 024 took.
--
-- ── APPLYING THIS TO A RUNNING PRODUCTION, IN THE RIGHT ORDER ────────────────────────
--
-- `listMembers` fails closed in BOTH directions: a mandate naming a member that has no row throws, and
-- an agent row naming an adapter that is not in adapters.yaml throws. It runs at boot and on every
-- roster read, so a half-applied change does not degrade the tier, it stops it.
--
-- Applying this INSERT to production before deploying the code would give the running machines an
-- agent row whose adapter they have never heard of. Deploying the code first would give them a mandate
-- naming a member that does not exist. Both break the same function. So production was sequenced as:
--
--   1. INSERT the row with `adapter_id` NULL   (member exists; the adapter check skips a null)
--   2. deploy the code                          (mandate resolves; adapter entry now present)
--   3. UPDATE the row to set `adapter_id`       (both halves true at once)
--
-- This file states the END STATE, which is what a fresh database and the test database should get in
-- one step. The three-step order above is an operational note about a tier that is already running,
-- not a different destination.

INSERT INTO members (id, kind, display_name, principal_id, adapter_id) VALUES
  ('claude-audit', 'agent', 'Claude Audit', 'principal:prince', 'claude-audit')
ON CONFLICT (id) DO NOTHING;

-- AND ITS ROUTE, in the same migration, because a member without one is unreachable and the suite
-- says so out loud: `every agent member can actually be reached` is an INVARIANT over the roster, not
-- a list of the rows that happened to exist when it was written. Same shape migration 017 used when it
-- added the guest agents — hosted, available, text+stream, no tool_call (S06-N3), inert data classes.
INSERT INTO routes (id, member_id, type, status, capabilities, data_classes, adapter_id)
SELECT 'rt_' || m.id, m.id, 'hosted', 'available',
       ARRAY['text', 'stream'], ARRAY[]::TEXT[], m.adapter_id
  FROM members AS m
 WHERE m.id = 'claude-audit'
ON CONFLICT (id) DO NOTHING;
