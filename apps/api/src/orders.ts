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
 *
 * RESUMING RESETS THE ATTENDANCE STREAK. The only transition INTO 'ACTIVE' is a resume (creation
 * starts the row at 0), and a resume is a person saying "I am back" — so the unattended count starts
 * over. Folded into the one status writer rather than added at the resume call site, so it cannot be
 * forgotten by a future caller and cannot be applied to a pause by mistake.
 */
export async function setOrderStatus(
  pool: Pool,
  orderId: string,
  status: OrderStatus,
  reason: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE standing_orders
        SET status = $2, pause_reason = $3, updated_at = now(),
            unattended_count = CASE WHEN $2 = 'ACTIVE' THEN 0 ELSE unattended_count END
      WHERE id = $1`,
    [orderId, status, reason],
  );
}

/**
 * A HUMAN PAID ATTENTION — clear the unattended streak for every ACTIVE order in this room.
 *
 * The attendance dial counts cycles that ran with nobody watching; a person typing in the room IS
 * watching, so the streak starts over. Scoped to ACTIVE orders with a streak to clear, so it is one
 * indexed write that usually touches nothing — cheap enough to sit off the send path as
 * fire-and-forget (postMessage.ts). Resume is the other reset, and it is the backstop if this is ever
 * lost to a crash: the streak a person never cleared is cleared the moment they resume the order.
 */
export async function resetUnattended(pool: Pool, roomId: string): Promise<void> {
  await pool.query(
    `UPDATE standing_orders SET unattended_count = 0, updated_at = now()
      WHERE room_id = $1 AND status = 'ACTIVE' AND unattended_count > 0`,
    [roomId],
  );
}

export interface OrderConfigUpdate {
  maxCycles: number | null;
  maxUnattendedCycles: number;
  expiresAt: string | null;
}

/**
 * EDIT AN ORDER'S TERMS — the dial, the limits, the expiry (S-UI3). The WIRING (trigger, action,
 * members) is not a parameter and cannot be changed here: rewiring a running loop is revoke-and-
 * recreate, a different act than adjusting how often it checks in. The order.updated event is appended
 * by the caller, before this (log leads the projection). It does NOT touch cycle_count or
 * unattended_count, so an edit never resets a streak — that is resume's job alone. Effective next
 * cycle by construction: the runner reads a fresh row per trigger, so a cycle already in flight keeps
 * the terms it opened under.
 */
export async function updateOrderConfig(
  pool: Pool,
  orderId: string,
  cfg: OrderConfigUpdate,
): Promise<void> {
  await pool.query(
    `UPDATE standing_orders
        SET max_cycles = $2, max_unattended_cycles = $3, expires_at = $4, updated_at = now()
      WHERE id = $1`,
    [orderId, cfg.maxCycles, cfg.maxUnattendedCycles, cfg.expiresAt],
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
 * nothing). Returns the new cycle number AND the new unattended count if it fired, or null if the
 * order is not active, not idle, or the completion is a replay. Both counts come from the atomic
 * UPDATE, so the limit check (max_cycles) and the attendance dial (max_unattended_cycles) decide a
 * stop on the number the write produced rather than on a re-read that could have moved.
 */
export interface OpenedCycle {
  cycle: number;
  unattended: number;
}

export async function tryOpenCycle(
  pool: Pool,
  orderId: string,
  triggerSeq: number,
): Promise<OpenedCycle | null> {
  const { rows } = await pool.query<{ cycle_count: number; unattended_count: number }>(
    `UPDATE standing_orders
        SET open_cycle_seq = $2, cycle_count = cycle_count + 1, unattended_count = unattended_count + 1,
            updated_at = now()
      WHERE id = $1 AND status = 'ACTIVE' AND coalesce(open_cycle_seq, -1) < $2
      RETURNING cycle_count, unattended_count`,
    [orderId, triggerSeq],
  );
  return rows[0] ? { cycle: rows[0].cycle_count, unattended: rows[0].unattended_count } : null;
}
