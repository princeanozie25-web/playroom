-- 036 — ROOM CHECKS: the fact source for temporal policy (Track C / C3, ADR-014).
--
-- C3 lets authority depend on history: a host grant may carry `requires: ["tests_passed"]`, and the gate
-- refuses the op (CONDITION_UNMET) until the fact holds. The facts are assembled by the CALLER from the
-- event log and passed to the pure `evaluate` — this table is where the concrete facts come from.
--
-- A node, under its lease, REPORTS a check result for a room: `{ name, passed }`. Reports are append-only
-- (every report is a record, with the reporting member and lease as provenance), and the FACT is the LATEST
-- report per check name — so re-running the tests flips the fact, and a stale pass does not linger. A check
-- named `tests` that passed yields the fact `tests_passed`, which a mandate's `requires` names.
--
-- HONEST LIMIT (recorded here and in ADR-014): the check is a SELF-REPORT by the leased node. It is
-- attributable (member + lease) and auditable, but it is only as trustworthy as that node — a node that
-- lies leaves a lying record. A check reported by a DISTINCT verifier, or a signed CI result, is the
-- provenance-hardening follow-up; the mechanism (authority gated on a recorded fact) is what C3 delivers.

CREATE TABLE IF NOT EXISTS room_checks (
  id          BIGSERIAL PRIMARY KEY,
  room_id     TEXT NOT NULL,
  name        TEXT NOT NULL,            -- the check's name, e.g. 'tests' -> the fact 'tests_passed'
  passed      BOOLEAN NOT NULL,
  reported_by TEXT NOT NULL,            -- the member the reporting lease resolves to
  lease_id    TEXT NOT NULL,            -- which node reported it (provenance)
  ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The fact lookup reads the latest report per (room, name); this index serves the DISTINCT ON ... ORDER BY.
CREATE INDEX IF NOT EXISTS room_checks_latest_idx ON room_checks (room_id, name, ts DESC);
