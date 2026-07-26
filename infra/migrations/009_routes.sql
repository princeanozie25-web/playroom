-- 009_routes: how a member is REACHABLE, as records (S1.1c, Bible §6.1).
--
-- Additive only. One table and a seed derived from the members that already exist.
--
-- A MEMBER RECORD SAYS THEY EXIST. A ROUTE SAYS THEY ARE REACHABLE. Nothing in the system
-- could tell those apart before this migration, and the gap was not theoretical:
--
--   * `getAdapterConfig` returns a DISABLED adapter without complaint, so `listMembers`
--     validated a member whose adapter could never be constructed;
--   * a missing provider key surfaced only when a turn was attempted, as a failed turn;
--   * so a member who could not possibly answer looked identical, in the roster and in the
--     database, to one that works. You found out by summoning them.
--
-- With routes, "no usable route" is a state the system can name BEFORE spending a summon on
-- it, and the room can say which constraint failed instead of producing a broken turn.

CREATE TABLE IF NOT EXISTS routes (
  id           TEXT PRIMARY KEY,
  member_id    TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  -- Bible §6.1's route types. A CHECK rather than an enum type: adding one later is an
  -- additive migration instead of an ALTER TYPE that locks the table.
  --   hosted   — Playroom runs the model itself through an adapter (both routes today)
  --   connected — the member's own client acts through our tools (ADR-004, P4)
  --   bridged  — GitHub or email carries the message (S2.6)
  type         TEXT NOT NULL CHECK (type IN ('hosted', 'connected', 'bridged')),
  -- `available` | `degraded` | `unavailable`. Status is a FACT ABOUT REACHABILITY, not a
  -- preference: a route nobody can use is `unavailable` whether or not a better one exists.
  status       TEXT NOT NULL DEFAULT 'available'
               CHECK (status IN ('available', 'degraded', 'unavailable')),
  -- What this route can do — `text`, `stream`, `tool_call`. Today every hosted route is
  -- text+stream, and `tool_call` is the capability whose ABSENCE is why an agent cannot
  -- initiate a structured action (S06-N3, RA-003). Recording it makes that a queryable fact
  -- rather than a paragraph in a claims sheet.
  capabilities TEXT[] NOT NULL DEFAULT '{}',
  /*
   * data_classes — WHICH CLASSES OF CONTEXT THIS ROUTE MAY CARRY.
   *
   * IT ENFORCES NOTHING TODAY. Structure for S1.5's context work, and stated here because
   * this is the FOURTH field in this codebase that would otherwise read as authority and
   * turn out to be description:
   *
   *   `mandate_label`   deleted in M-3 — described authority nothing enforced
   *   `room.post`       deleted in S0.4 — a scope entry nothing dispatched
   *   `counterparties`  unenforced until S1.1b — a restriction with no roster to check
   *   `data_classes`    THIS — no context assembly consults it yet
   *
   * The pattern each time: a field inside an authority record that a reader trusts. It is
   * kept rather than deleted because S1.5 is the slice that reads it and the column is the
   * cheap half; but until an assembler consults it, A ROUTE LISTING `common_ground` IS NOT
   * RESTRICTED TO COMMON GROUND. Do not cite this column as a control.
   */
  data_classes TEXT[] NOT NULL DEFAULT '{}',
  -- The adapter this route runs on, for a hosted route. No foreign key: adapters live in
  -- adapters.yaml, not in Postgres, and §6 keeps them there. Validated at the seam.
  adapter_id   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A hosted route without an adapter cannot run; a connected or bridged route has no
  -- adapter to name. Same shape as members' kind/adapter constraint, for the same reason.
  CONSTRAINT routes_hosted_has_adapter CHECK (
    (type = 'hosted' AND adapter_id IS NOT NULL) OR
    (type <> 'hosted' AND adapter_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS routes_member_idx ON routes (member_id);

-- ── SEED ──────────────────────────────────────────────────────────────────────────────
--
-- Today's two agents each have exactly ONE route — their adapter — so the seed is derived
-- from the member records rather than written out. A human member gets no route: `prince` is
-- reachable by being a person at a keyboard, which is not something this table models.
--
-- NO RANKING, NO PREFERENCE, NO FAILOVER. With one route per member, selection is not a
-- decision, and a selector built before there is a choice is the pattern this project has
-- now avoided four times (see the data_classes note above). The STRUCTURE holds more than
-- one route; the LOGIC picks the only one there is, and says so in the reason it records.
INSERT INTO routes (id, member_id, type, status, capabilities, data_classes, adapter_id)
SELECT
  'rt_' || m.id,
  m.id,
  'hosted',
  'available',
  ARRAY['text', 'stream'],   -- no 'tool_call': no adapter carries one (S06-N3)
  ARRAY[]::TEXT[],           -- inert, see above
  m.adapter_id
FROM members AS m
WHERE m.kind = 'agent' AND m.adapter_id IS NOT NULL
ON CONFLICT (id) DO NOTHING;
