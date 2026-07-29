import { appendOrderCycled, appendOrderStatus } from '../events.js';
import {
  activeOrdersForTrigger,
  orderById,
  setOrderStatus,
  tryOpenCycle,
  type OrderRow,
} from '../orders.js';
import { fireSummon } from './summon.js';
import type { CommandContext, CommandDeps } from './context.js';

// ============================================================================
// THE LOOP RUNNER (S-LOOP) — a completed turn drives the next cycle.
//
// This is the thing that was missing: nothing took a completed turn, fired the next summon, and
// repeated without a person pressing go. It runs at the post-completion seam (agent.ts), where the
// turn already holds its own chain in-process, and it is governed, not governing — every summon it
// fires travels the existing constructor, order-ROOTED (the human creator is the head of the chain),
// and is refused exactly as a human's would be. An order causes; it does not grant.
//
// TWO BOUNDS, TWO PLACES: the depth cap (S1.8) stops runaway WITHIN a cycle; the order's own guards
// (idempotency + one-cycle-in-flight, migration 022; limits + attendance, the next commit) stop
// runaway ACROSS cycles. This file must not weaken the first to serve the second.
// ============================================================================

/**
 * Fire one cycle of an order: open a cycle (the atomic idempotency + in-flight guard), record it, and
 * fire the order-rooted summon. `triggerSeq` is the completed turn that fired it (or, for the first
 * cycle, the order.created event). Returns whether a cycle actually fired — false when the order is not
 * idle, not active, or the trigger is a replay.
 *
 * The summon's requester is the CREATOR (a human member, so the task's created_by is valid and the
 * root is a real person); `order_id` is what marks it as order-fired rather than a direct human tag.
 * depth 0: an order fires a FRESH human-rooted cycle, so the summoned member keeps its one S1.8 hop.
 */
export async function fireOrderCycle(
  deps: CommandDeps,
  roomId: string,
  order: OrderRow,
  triggerSeq: number,
): Promise<boolean> {
  const cycle = await tryOpenCycle(deps.pool, order.id, triggerSeq);
  if (cycle === null) return false;

  const cycled = await appendOrderCycled(deps.pool, roomId, order.creator_member_id, {
    order_id: order.id,
    cycle,
    trigger_seq: triggerSeq,
    member: order.action_member_id,
  });
  if (cycled) deps.bus.publish(roomId, cycled);

  await fireSummon(deps, {
    roomId,
    member: order.action_member_id,
    requestedBy: order.creator_member_id,
    rootActor: order.creator_member_id,
    rootIsHuman: true,
    depth: 0,
    causeSeq: triggerSeq,
    intent: `standing order — ${order.creator_member_id} authorised ${order.action_member_id} to recur`,
    orderId: order.id,
  });
  deps.log.info(
    { room_id: roomId, order_id: order.id, cycle, member: order.action_member_id },
    'standing order fired a cycle',
  );
  return true;
}

/**
 * An error terminal pauses the order, out loud (Bible §14 shape, one level up). A turn that ended in
 * error does not trigger the next cycle — cycling into an error loop would burn budget and hide the
 * failure; pausing surfaces it as the "needs your input" moment. Keyed on the ERRORED turn's order
 * (threaded through the chain), so the order whose cycle broke is the one that pauses.
 */
async function pauseOrderOnError(
  deps: CommandDeps,
  roomId: string,
  orderId: string,
  member: string,
): Promise<void> {
  const order = await orderById(deps.pool, roomId, orderId);
  if (!order || order.status !== 'ACTIVE') return; // already paused, terminal, or gone
  const reason = `${member}'s turn ended in error, so the loop paused rather than cycling on a failure`;
  const event = await appendOrderStatus(deps.pool, roomId, 'system', {
    order_id: orderId,
    status: 'PAUSED',
    reason,
    actor: 'system',
  });
  await setOrderStatus(deps.pool, orderId, 'PAUSED', reason);
  deps.bus.publish(roomId, event);
  deps.log.warn(
    { room_id: roomId, order_id: orderId, member },
    'standing order paused: error terminal',
  );
}

/**
 * The runner, dispatched from the post-completion seam. On a SUCCESS completion, advance any order this
 * completion triggers; on an ERROR completion of an order-rooted turn, pause that order instead of
 * cycling. Fire-and-forget from agent.ts, so a per-order failure is logged and does not throw.
 */
export async function runOrdersCommand(
  deps: CommandDeps,
  _ctx: CommandContext,
  input: {
    roomId: string;
    member: string;
    completedSeq: number;
    success: boolean;
    orderId?: string;
  },
): Promise<void> {
  if (!input.success) {
    if (input.orderId) await pauseOrderOnError(deps, input.roomId, input.orderId, input.member);
    return;
  }
  const orders = await activeOrdersForTrigger(
    deps.pool,
    input.roomId,
    'agent.turn.completed',
    input.member,
  );
  for (const order of orders) {
    try {
      await fireOrderCycle(deps, input.roomId, order, input.completedSeq);
    } catch (err) {
      deps.log.error(
        { room_id: input.roomId, order_id: order.id, err: String(err) },
        'standing order firing failed',
      );
    }
  }
}
