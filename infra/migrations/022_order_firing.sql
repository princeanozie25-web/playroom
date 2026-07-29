-- 022_order_firing: one cycle per trigger, one cycle in flight (S-LOOP).
--
-- Additive only. One column, one partial unique index — the two runaway bounds an order needs ACROSS
-- cycles (the depth cap, S1.8, bounds runaway WITHIN a cycle; do not confuse them).
--
-- ── ONE CYCLE IN FLIGHT PER ORDER (the S2.2 PENDING-shape, one level up) ──────────────
--
-- `open_cycle_seq` is the seq of the completed turn that fired the order's current cycle, or NULL when
-- none is running. An order fires cycle N+1 only for a completion NEWER than the one that opened its
-- current cycle — so a completion that fires the order is the terminal of the cycle it ends, and the
-- next cycle cannot start until this one's chain has closed. The firing UPDATE is a single atomic
-- statement gated on `coalesce(open_cycle_seq, -1) < <trigger seq>`, which is both this in-flight bound
-- AND idempotency: a replayed completion has a seq not newer than the cycle it already opened, so it
-- fires nothing.
ALTER TABLE standing_orders ADD COLUMN IF NOT EXISTS open_cycle_seq BIGINT;

-- ── ONE FIRING PER TRIGGERING EVENT, at the database (the migration-005 pattern) ──────
--
-- The order.cycled event records a cycle and carries the triggering completion's seq. At most one per
-- (order, trigger seq): a duplicate delivery of the same completion cannot advance the cycle count or
-- fire a second summon, whatever an in-process check does. The loser's insert is refused by this index,
-- exactly as 005/006 refuse a second summon and a second turn. Partial, on the payload expression, like
-- 005/019/020 — `order.cycled` shares the events table and the uniqueness is meaningless elsewhere.
CREATE UNIQUE INDEX IF NOT EXISTS events_one_cycle_per_trigger
  ON events (room_id, (payload ->> 'order_id'), (payload ->> 'trigger_seq'))
  WHERE event_type = 'order.cycled';
