-- 021_standing_orders: a human authorises recurring work, once (S-LOOP).
--
-- Additive only. One table. A standing order is delegated human intent — like a standing order at a
-- bank: authorisation given once, executions attributed to it. Except the recurring payment is
-- recurring WORK: on a completed turn matching its filter, the order fires an order-rooted summon.
--
-- ── AN ORDER CAUSES; IT DOES NOT GRANT ────────────────────────────────────────────────
--
-- An order confers NO authority. Its fired summons travel the existing constructor, the existing
-- boundary, the existing mandate evaluation, and are refused exactly as a human's would be if the
-- summoned member's mandate lacks the scope — a mandate is what grants; an order only recurs. This
-- table records WHAT recurs and WHO authorised it; it grants nothing. `creator_member_id` is a HUMAN member (an agent may never create one — enforced
-- in the command, not here, because a CHECK cannot read `members.kind`), and it is the human at the
-- head of every order-rooted summon's chain: the summon is human-rooted through this row.
--
-- ── THE LOG IS THE SOURCE OF TRUTH; THIS TABLE IS A PROJECTION ─────────────────────────
--
-- Every transition appends an event (`order.created`, `order.paused`, `order.resumed`,
-- `order.revoked`, and — S-LOOP's firing commit — `order.cycled`) and then updates the row. The row
-- exists so the runner can find active orders matching a completed turn in one indexed read, and so
-- the room can render a chip, without folding the log every time. It is an index, not the record; if
-- the two ever disagree, THE LOG WINS (the same discipline as `tasks`, migration 011).

CREATE TABLE IF NOT EXISTS standing_orders (
  id                    TEXT PRIMARY KEY,
  -- ON DELETE CASCADE on the room, like tasks (011) and room_members (008): an order is authorised
  -- work IN a room and cannot outlive it.
  room_id               TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  -- WHO AUTHORISED IT — a human member, and the human root of every summon this order fires. Only a
  -- human creates one; only this creator may resume or revoke; any human may pause. Enforced in the
  -- command (memberRecord.kind), the same shape that keeps an agent from signing a co-signature.
  creator_member_id     TEXT NOT NULL REFERENCES members (id),
  -- THE TRIGGER FILTER: a completed turn OF THIS TYPE by THIS MEMBER fires the order. Kept as
  -- (event type + member) so the runner's lookup is a plain indexed query, never a payload scan.
  trigger_event_type    TEXT NOT NULL,
  trigger_member_id     TEXT NOT NULL REFERENCES members (id),
  -- THE ACTION: summon THIS member (order-rooted) each cycle.
  action_member_id      TEXT NOT NULL REFERENCES members (id),
  -- LIMITS. NULL max_cycles / expires_at = that bound is not set; the attendance dial always applies.
  max_cycles            INTEGER,
  max_unattended_cycles INTEGER NOT NULL DEFAULT 3,
  expires_at            TIMESTAMPTZ,
  -- COUNTERS, advanced by the firing commit. `unattended_count` resets on any human message or resume.
  cycle_count           INTEGER NOT NULL DEFAULT 0,
  unattended_count      INTEGER NOT NULL DEFAULT 0,
  -- STATE. Only ACTIVE fires. PAUSED holds and can resume; REVOKED/EXPIRED/LIMIT_REACHED are terminal.
  status                TEXT NOT NULL DEFAULT 'ACTIVE',
  -- WHY it paused, set out loud when status = PAUSED (attendance, budget, error, limit, a human).
  pause_reason          TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT standing_orders_status_known
    CHECK (status IN ('ACTIVE', 'PAUSED', 'REVOKED', 'EXPIRED', 'LIMIT_REACHED'))
);

-- The runner's hot path: find the ACTIVE orders a just-completed turn should fire. Partial on ACTIVE
-- because paused/terminal orders are never fired, and the index should be as small as the live set.
CREATE INDEX IF NOT EXISTS standing_orders_active_trigger_idx
  ON standing_orders (room_id, trigger_member_id)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS standing_orders_room_idx ON standing_orders (room_id);
