import type { Pool } from 'pg';

// THE STANDING-ORDER PROJECTION (S-LOOP, migration 021).
//
// The queryable current state of an order. The LOG is the source of truth (order.created +
// order.status events); this row is an index so the runner can find active orders matching a
// completed turn in one read and the room can render a chip without folding the log. Every writer
// here appends the event first (events.ts), then updates the row — if the two ever disagree, the log
// wins, the same discipline as tasks.

export type OrderStatus = 'ACTIVE' | 'PAUSED' | 'REVOKED' | 'EXPIRED' | 'LIMIT_REACHED';

/** The terminal states an order can never leave — resume does not apply. */
export const TERMINAL_ORDER_STATUSES: ReadonlySet<string> = new Set([
  'REVOKED',
  'EXPIRED',
  'LIMIT_REACHED',
]);

export interface OrderRow {
  id: string;
  room_id: string;
  creator_member_id: string;
  trigger_event_type: string;
  trigger_member_id: string;
  action_member_id: string;
  max_cycles: number | null;
  max_unattended_cycles: number;
  expires_at: string | null; // ISO, or null
  cycle_count: number;
  unattended_count: number;
  status: string;
  pause_reason: string | null;
}

interface OrderDbRow {
  id: string;
  room_id: string;
  creator_member_id: string;
  trigger_event_type: string;
  trigger_member_id: string;
  action_member_id: string;
  max_cycles: number | null;
  max_unattended_cycles: number;
  expires_at: Date | null;
  cycle_count: number;
  unattended_count: number;
  status: string;
  pause_reason: string | null;
}

const ORDER_COLS = `id, room_id, creator_member_id, trigger_event_type, trigger_member_id,
  action_member_id, max_cycles, max_unattended_cycles, expires_at, cycle_count,
  unattended_count, status, pause_reason`;

function toOrderRow(r: OrderDbRow): OrderRow {
  return {
    ...r,
    expires_at: r.expires_at ? r.expires_at.toISOString() : null,
  };
}

export interface CreateOrderInput {
  id: string;
  roomId: string;
  creator: string; // the human member
  triggerEventType: string;
  triggerMember: string;
  actionMember: string;
  maxCycles: number | null;
  maxUnattendedCycles: number;
  expiresAt: string | null; // ISO, or null
}

/** Insert the projection row. The order.created event is written by the command, before this. */
export async function createOrderRow(pool: Pool, input: CreateOrderInput): Promise<OrderRow> {
  const { rows } = await pool.query<OrderDbRow>(
    `INSERT INTO standing_orders
       (id, room_id, creator_member_id, trigger_event_type, trigger_member_id, action_member_id,
        max_cycles, max_unattended_cycles, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${ORDER_COLS}`,
    [
      input.id,
      input.roomId,
      input.creator,
      input.triggerEventType,
      input.triggerMember,
      input.actionMember,
      input.maxCycles,
      input.maxUnattendedCycles,
      input.expiresAt,
    ],
  );
  return toOrderRow(rows[0]);
}

/** The order with this id in this room, or null. Room-scoped so an id from another room misses. */
export async function orderById(
  pool: Pool,
  roomId: string,
  orderId: string,
): Promise<OrderRow | null> {
  const { rows } = await pool.query<OrderDbRow>(
    `SELECT ${ORDER_COLS} FROM standing_orders WHERE id = $1 AND room_id = $2`,
    [orderId, roomId],
  );
  return rows[0] ? toOrderRow(rows[0]) : null;
}

/**
 * Move an order to a new status, recording the reason on the row (null when ACTIVE). The order.status
 * event is appended by the caller, before this, so the log leads the projection.
 */
export async function setOrderStatus(
  pool: Pool,
  orderId: string,
  status: OrderStatus,
  reason: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE standing_orders SET status = $2, pause_reason = $3, updated_at = now() WHERE id = $1`,
    [orderId, status, reason],
  );
}

/** The ACTIVE orders a completed turn of this type by this member should fire (the runner's hot path). */
export async function activeOrdersForTrigger(
  pool: Pool,
  roomId: string,
  eventType: string,
  member: string,
): Promise<OrderRow[]> {
  const { rows } = await pool.query<OrderDbRow>(
    `SELECT ${ORDER_COLS} FROM standing_orders
      WHERE room_id = $1 AND status = 'ACTIVE'
        AND trigger_event_type = $2 AND trigger_member_id = $3
      ORDER BY id`,
    [roomId, eventType, member],
  );
  return rows.map(toOrderRow);
}

/**
 * OPEN A CYCLE — the atomic fire guard (migration 022). Advances the order's cycle iff the triggering
 * completion is NEWER than the one that opened its current cycle, which is BOTH single-cycle-in-flight
 * (the next cycle cannot start until this completion — the terminal of the running one — arrives) AND
 * idempotency (a replayed completion has a seq not newer than the cycle it already opened, so it does
 * nothing). Returns the new cycle number if it fired, or null if the order is not active, not idle, or
 * the completion is a replay.
 */
export async function tryOpenCycle(
  pool: Pool,
  orderId: string,
  triggerSeq: number,
): Promise<number | null> {
  const { rows } = await pool.query<{ cycle_count: number }>(
    `UPDATE standing_orders
        SET open_cycle_seq = $2, cycle_count = cycle_count + 1, unattended_count = unattended_count + 1,
            updated_at = now()
      WHERE id = $1 AND status = 'ACTIVE' AND coalesce(open_cycle_seq, -1) < $2
      RETURNING cycle_count`,
    [orderId, triggerSeq],
  );
  return rows[0] ? rows[0].cycle_count : null;
}
