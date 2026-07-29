import { randomUUID } from 'node:crypto';
import {
  ERROR_ORDER_BAD_STATE,
  ERROR_ORDER_MEMBER_UNKNOWN,
  ERROR_ORDER_NOT_CREATOR,
  ERROR_ORDER_NOT_HUMAN,
  ERROR_ORDER_UNKNOWN,
} from '@playroom/shared';
import { appendOrderCreated, appendOrderStatus } from '../events.js';
import { listRoomMembers, matchRoomAgent, memberRecord } from '../members.js';
import {
  createOrderRow,
  orderById,
  setOrderStatus,
  TERMINAL_ORDER_STATUSES,
  type OrderStatus,
} from '../orders.js';
import type { CommandContext, CommandDeps } from './context.js';

// ============================================================================
// STANDING ORDERS — created, paused, resumed, revoked (S-LOOP).
//
// An order is delegated human intent. It causes; it does not grant — the summons it will fire (the
// firing commit) travel the existing constructor and are governed exactly as a human's would be. This
// file's whole job is to make sure only the right HUMAN can mint, resume, or revoke that standing
// authorisation, and that every transition is an evented, attributed record.
//
// ── AN AGENT MAY NEVER CREATE, RESUME, OR REVOKE AN ORDER ─────────────────────────────────────
//
// Written here so a later "convenience" argues with it first. Minting or widening a standing
// authorisation is self-authorisation if an agent does it — the exact reasoning that keeps an agent
// from signing a co-signature (commands/signDecision.ts). The check is against the socket's
// AUTHENTICATED member's kind, never a claim in the frame, and a non-human is refused before anything
// else. Pausing is the one safe direction, so any human may pause any order — but still never an agent.
// ============================================================================

export type OrderResult =
  { ok: true; orderId?: string } | { ok: false; refusal: { code: string; message: string } };

const refuse = (code: string, message: string): OrderResult => ({
  ok: false,
  refusal: { code, message },
});

export async function createOrderCommand(
  deps: CommandDeps,
  ctx: CommandContext,
  input: {
    roomId: string;
    clientMsgId: string;
    triggerEventType: string;
    triggerMember: string;
    actionMember: string;
    maxCycles: number | null;
    maxUnattendedCycles: number;
    expiresAt: string | null;
  },
): Promise<OrderResult> {
  const base = { room_id: input.roomId, member: ctx.actorId };

  // 1. Only a HUMAN may authorise recurring work. Checked against the authenticated member's kind.
  const creator = await memberRecord(deps.pool, ctx.actorId);
  if (!creator || creator.kind !== 'human') {
    deps.log.warn(
      { ...base, code: ERROR_ORDER_NOT_HUMAN },
      'order create refused: only a human may create one',
    );
    return refuse(ERROR_ORDER_NOT_HUMAN, 'only a human may create a standing order');
  }

  // 2. The trigger and action members must be AGENT members of this room — a turn is taken by an
  //    agent, and an order fires a summon of one. Resolved against the room's own agents so an order
  //    cannot name a member outside it (the matchRoomAgent rule the summon channel uses).
  const roomMembers = await listRoomMembers(deps.pool, input.roomId);
  const triggerMember = matchRoomAgent(roomMembers, input.triggerMember);
  const actionMember = matchRoomAgent(roomMembers, input.actionMember);
  if (!triggerMember || !actionMember) {
    deps.log.warn(
      {
        ...base,
        trigger: input.triggerMember,
        action: input.actionMember,
        code: ERROR_ORDER_MEMBER_UNKNOWN,
      },
      'order create refused: trigger or action member is not an agent in this room',
    );
    return refuse(
      ERROR_ORDER_MEMBER_UNKNOWN,
      'a standing order can only name agent members of this room for its trigger and action',
    );
  }

  const orderId = `ord_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const created = await appendOrderCreated(deps.pool, input.roomId, ctx.actorId, {
    order_id: orderId,
    creator: ctx.actorId,
    trigger_event_type: input.triggerEventType,
    trigger_member: triggerMember,
    action_member: actionMember,
    max_cycles: input.maxCycles,
    max_unattended_cycles: input.maxUnattendedCycles,
    expires_at: input.expiresAt,
  });
  await createOrderRow(deps.pool, {
    id: orderId,
    roomId: input.roomId,
    creator: ctx.actorId,
    triggerEventType: input.triggerEventType,
    triggerMember,
    actionMember,
    maxCycles: input.maxCycles,
    maxUnattendedCycles: input.maxUnattendedCycles,
    expiresAt: input.expiresAt,
  });
  deps.bus.publish(input.roomId, created);
  deps.log.info(
    { ...base, order_id: orderId, trigger_member: triggerMember, action_member: actionMember },
    'standing order created',
  );
  return { ok: true, orderId };
}

export async function controlOrderCommand(
  deps: CommandDeps,
  ctx: CommandContext,
  input: {
    roomId: string;
    clientMsgId: string;
    orderId: string;
    op: 'pause' | 'resume' | 'revoke';
  },
): Promise<OrderResult> {
  const base = {
    room_id: input.roomId,
    member: ctx.actorId,
    order_id: input.orderId,
    op: input.op,
  };

  const order = await orderById(deps.pool, input.roomId, input.orderId);
  if (!order) {
    deps.log.warn({ ...base, code: ERROR_ORDER_UNKNOWN }, 'order control refused: no such order');
    return refuse(ERROR_ORDER_UNKNOWN, 'there is no such standing order');
  }

  // AN AGENT MAY NEVER pause, resume, or revoke — checked against the authenticated member's kind.
  const actor = await memberRecord(deps.pool, ctx.actorId);
  if (!actor || actor.kind !== 'human') {
    deps.log.warn(
      { ...base, code: ERROR_ORDER_NOT_HUMAN },
      'order control refused: only a human may act on an order',
    );
    return refuse(
      ERROR_ORDER_NOT_HUMAN,
      'only a human may pause, resume or revoke a standing order',
    );
  }

  // RESUME and REVOKE are the creator's alone; PAUSE is any human's (the safe direction).
  if ((input.op === 'resume' || input.op === 'revoke') && ctx.actorId !== order.creator_member_id) {
    deps.log.warn(
      { ...base, creator: order.creator_member_id, code: ERROR_ORDER_NOT_CREATOR },
      'order control refused: not the creator',
    );
    return refuse(ERROR_ORDER_NOT_CREATOR, `only the order's creator may ${input.op} it`);
  }

  // The op must apply in the current state — resuming an active order, pausing a dead one, or acting
  // on a revoked/expired/limit-reached order are refused rather than silently no-op'd.
  const terminal = TERMINAL_ORDER_STATUSES.has(order.status);
  const bad =
    (input.op === 'pause' && order.status !== 'ACTIVE') ||
    (input.op === 'resume' && order.status !== 'PAUSED') ||
    (input.op === 'revoke' && terminal);
  if (bad) {
    deps.log.warn(
      { ...base, status: order.status, code: ERROR_ORDER_BAD_STATE },
      'order control refused: wrong state for op',
    );
    return refuse(
      ERROR_ORDER_BAD_STATE,
      `a ${order.status.toLowerCase()} order cannot be ${input.op}d`,
    );
  }

  const next: { status: OrderStatus; reason: string; pauseReason: string | null } =
    input.op === 'pause'
      ? {
          status: 'PAUSED',
          reason: `paused by ${ctx.actorId}`,
          pauseReason: `paused by ${ctx.actorId}`,
        }
      : input.op === 'resume'
        ? { status: 'ACTIVE', reason: `resumed by ${ctx.actorId}`, pauseReason: null }
        : {
            status: 'REVOKED',
            reason: `revoked by ${ctx.actorId}`,
            pauseReason: `revoked by ${ctx.actorId}`,
          };

  const event = await appendOrderStatus(deps.pool, input.roomId, ctx.actorId, {
    order_id: input.orderId,
    status: next.status,
    reason: next.reason,
    actor: ctx.actorId,
  });
  await setOrderStatus(deps.pool, input.orderId, next.status, next.pauseReason);
  deps.bus.publish(input.roomId, event);
  deps.log.info({ ...base, status: next.status }, 'standing order transitioned');
  return { ok: true, orderId: input.orderId };
}
