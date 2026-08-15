import { randomUUID } from 'node:crypto';
import {
  ERROR_ORDER_BAD_STATE,
  ERROR_ORDER_INVALID_CONFIG,
  ERROR_ORDER_MEMBER_UNKNOWN,
  ERROR_ORDER_NOT_CREATOR,
  ERROR_ORDER_NOT_HUMAN,
  ERROR_ORDER_TASK_ABSENT,
  ERROR_ORDER_TASK_BLANK,
  ERROR_ORDER_TASK_TOO_LARGE,
  ERROR_ORDER_UNBOUNDED_DIAL,
  ERROR_ORDER_UNKNOWN,
  ORDER_TASK_MAX_CHARS,
} from '@playroom/shared';
import { appendOrderCreated, appendOrderStatus, appendOrderUpdated } from '../events.js';
import { listRoomMembers, matchRoomAgent, memberRecord } from '../members.js';
import {
  createOrderRow,
  orderById,
  setOrderStatus,
  TERMINAL_ORDER_STATUSES,
  updateOrderConfig,
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

/**
 * A LOOP THAT CHECKS IN RARELY MUST HAVE AN END (S-DIAL).
 *
 * At a dial of 1 the attendance check-in WAS the bound: a person saw every cycle before the next one
 * ran, so an order with no count and no deadline still could not get far unattended. SP-4's
 * observation lifted that gate, and lifting it removes that protection — so the order has to carry
 * one of the two bounds that actually STOP: a count or a clock.
 *
 * THE DAILY CEILING DOES NOT COUNT, and that is the whole reason this exists. It is a BUDGET: it
 * pauses when reached and resumes after the UTC midnight reset, which turns an unbounded loop into
 * one that never finishes rather than one that stops.
 *
 * Returns the refusal or null. Shared by create and edit, because an EDIT can raise the dial just as
 * easily as a create can set it, and a rule enforced on one path is a rule with a door in it.
 */
function unboundedDial(
  maxUnattendedCycles: number,
  maxCycles: number | null,
  expiresAt: string | null,
): { code: string; message: string } | null {
  if (maxUnattendedCycles <= 1) return null;
  if (maxCycles !== null || expiresAt !== null) return null;
  return {
    code: ERROR_ORDER_UNBOUNDED_DIAL,
    message:
      'a standing order that checks in less often than every cycle must also say when it ends — ' +
      'give it a cycle cap or an expiry (the daily spending ceiling pauses a loop, it does not end one)',
  };
}

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
    /** What the order is for (S-TASK). Optional in the TYPE so an old caller reaches the named
     *  refusal below rather than a type error at a call site nobody will see at runtime. */
    task?: string;
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

  // 3. THE ORDER MUST SAY WHAT IT IS FOR (S-TASK). Refused HERE, at creation, and not at fire time:
  //    the person authorising recurring work is the only party who can supply the objective, and the
  //    moment they are present is the moment to ask. An order that reached the runner without one
  //    would burn a paid turn discovering it (SL2-N5) — and there is no editing a task in, because a
  //    task is wiring: changing it means creating a new order.
  //
  //    Three refusals, three fixes: nothing sent (an old client), an empty box (a person), too long
  //    (an objective that is really a document — put the framing in the room's briefing instead).
  if (input.task === undefined) {
    deps.log.warn(
      { ...base, code: ERROR_ORDER_TASK_ABSENT },
      'order create refused: no task — an order must say what it is for',
    );
    return refuse(
      ERROR_ORDER_TASK_ABSENT,
      'a standing order must say what it is for — give it a task, which is set once and cannot be edited later',
    );
  }
  const task = input.task.trim();
  if (task === '') {
    deps.log.warn({ ...base, code: ERROR_ORDER_TASK_BLANK }, 'order create refused: blank task');
    return refuse(
      ERROR_ORDER_TASK_BLANK,
      "a standing order's task cannot be blank — say what each cycle is for",
    );
  }
  if (task.length > ORDER_TASK_MAX_CHARS) {
    deps.log.warn(
      { ...base, code: ERROR_ORDER_TASK_TOO_LARGE, length: task.length },
      'order create refused: task over the cap',
    );
    return refuse(
      ERROR_ORDER_TASK_TOO_LARGE,
      `a standing order's task must be ${ORDER_TASK_MAX_CHARS} characters or fewer (this one is ${task.length}) — the standing framing belongs in the room's briefing`,
    );
  }

  // 4. A RAISED DIAL NEEDS AN END (S-DIAL). Refused at creation, where the person is.
  const unbounded = unboundedDial(input.maxUnattendedCycles, input.maxCycles, input.expiresAt);
  if (unbounded) {
    deps.log.warn(
      { ...base, dial: input.maxUnattendedCycles, code: unbounded.code },
      'order create refused: a dial above 1 with no cycle cap and no expiry',
    );
    return refuse(unbounded.code, unbounded.message);
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
    task,
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
    task,
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

// ── EDITING AN ORDER'S TERMS (S-UI3) ───────────────────────────────────────────────────────────
//
// The form over the record needs a way to change an order after creation — but a NARROW one. What is
// editable is HOW OFTEN it checks in and WHEN it stops: the attendance dial, the cycle cap, the expiry.
// What is NOT is WHO it wires together — trigger, action, members — because rewiring a running loop is
// a different act than adjusting its cadence, and it is done by revoke-and-recreate so the old wiring's
// record ends and a new one begins rather than a summon quietly changing target mid-life. The immutable
// half is enforced by ABSENCE: this command has no parameter for it. Creator-only, matching resume and
// revoke; an agent may do none of it (checked against the authenticated member's kind, never the frame).

/** An integer at or above `min`, or null when nullable is allowed and the value is null. */
function validCount(v: number | null, min: number, nullable: boolean): boolean {
  if (v === null) return nullable;
  return Number.isInteger(v) && v >= min;
}

export async function updateOrderCommand(
  deps: CommandDeps,
  ctx: CommandContext,
  input: {
    roomId: string;
    clientMsgId: string;
    orderId: string;
    maxCycles: number | null;
    maxUnattendedCycles: number;
    expiresAt: string | null;
  },
): Promise<OrderResult> {
  const base = { room_id: input.roomId, member: ctx.actorId, order_id: input.orderId };

  const order = await orderById(deps.pool, input.roomId, input.orderId);
  if (!order) {
    deps.log.warn({ ...base, code: ERROR_ORDER_UNKNOWN }, 'order edit refused: no such order');
    return refuse(ERROR_ORDER_UNKNOWN, 'there is no such standing order');
  }

  // AN AGENT MAY NEVER EDIT — checked against the authenticated member's kind, same as create/resume.
  const actor = await memberRecord(deps.pool, ctx.actorId);
  if (!actor || actor.kind !== 'human') {
    deps.log.warn(
      { ...base, code: ERROR_ORDER_NOT_HUMAN },
      'order edit refused: only a human may edit',
    );
    return refuse(ERROR_ORDER_NOT_HUMAN, 'only a human may edit a standing order');
  }

  // CREATOR-ONLY, matching resume and revoke. Adjusting the terms is not the safe direction pausing is.
  if (ctx.actorId !== order.creator_member_id) {
    deps.log.warn(
      { ...base, creator: order.creator_member_id, code: ERROR_ORDER_NOT_CREATOR },
      'order edit refused: not the creator',
    );
    return refuse(ERROR_ORDER_NOT_CREATOR, "only the order's creator may edit it");
  }

  // A terminal order will never fire again, so its terms are frozen — editing a revoked/expired/
  // limit-reached order is refused rather than silently written to a record nothing reads.
  if (TERMINAL_ORDER_STATUSES.has(order.status)) {
    deps.log.warn(
      { ...base, status: order.status, code: ERROR_ORDER_BAD_STATE },
      'order edit refused: terminal order',
    );
    return refuse(ERROR_ORDER_BAD_STATE, `a ${order.status.toLowerCase()} order cannot be edited`);
  }

  // OUT-OF-RANGE VALUES ARE REFUSED SERVER-SIDE, because the form adds no enforcement and bypasses
  // none. The dial must be at least 1 (a dial of 0 would pause before any unattended cycle ran); a
  // cycle cap is null or at least 1; an expiry is null or a real timestamp (a past one is allowed — it
  // is a valid way to wind an order down).
  const expiryValid = input.expiresAt === null || !Number.isNaN(Date.parse(input.expiresAt));
  if (
    !validCount(input.maxUnattendedCycles, 1, false) ||
    !validCount(input.maxCycles, 1, true) ||
    !expiryValid
  ) {
    deps.log.warn(
      { ...base, code: ERROR_ORDER_INVALID_CONFIG },
      'order edit refused: invalid config',
    );
    return refuse(
      ERROR_ORDER_INVALID_CONFIG,
      'the attendance dial must be at least 1, a cycle cap must be a positive whole number or empty, and an expiry must be a valid date or empty',
    );
  }

  // A RAISED DIAL NEEDS AN END, on this path too (S-DIAL) — checked against the values being
  // written, so raising the dial and adding a cap in one edit is allowed and raising it alone is not.
  const unboundedEdit = unboundedDial(input.maxUnattendedCycles, input.maxCycles, input.expiresAt);
  if (unboundedEdit) {
    deps.log.warn(
      { ...base, dial: input.maxUnattendedCycles, code: unboundedEdit.code },
      'order edit refused: a dial above 1 with no cycle cap and no expiry',
    );
    return refuse(unboundedEdit.code, unboundedEdit.message);
  }

  // The event carries BEFORE and AFTER — only the editable terms, because only they can change.
  const before = {
    max_cycles: order.max_cycles,
    max_unattended_cycles: order.max_unattended_cycles,
    expires_at: order.expires_at,
  };
  const after = {
    max_cycles: input.maxCycles,
    max_unattended_cycles: input.maxUnattendedCycles,
    expires_at: input.expiresAt,
  };
  const event = await appendOrderUpdated(deps.pool, input.roomId, ctx.actorId, {
    order_id: input.orderId,
    before,
    after,
    actor: ctx.actorId,
  });
  await updateOrderConfig(deps.pool, input.orderId, {
    maxCycles: input.maxCycles,
    maxUnattendedCycles: input.maxUnattendedCycles,
    expiresAt: input.expiresAt,
  });
  deps.bus.publish(input.roomId, event);
  deps.log.info({ ...base }, 'standing order edited; effective next cycle');
  return { ok: true, orderId: input.orderId };
}
