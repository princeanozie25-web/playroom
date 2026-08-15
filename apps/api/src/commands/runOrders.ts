import { randomUUID } from 'node:crypto';
import { ERROR_INTERRUPT_BUDGET } from '@playroom/shared';
import { appendOrderCycled, appendOrderStatus } from '../events.js';
import {
  activeOrdersForTrigger,
  orderById,
  setOrderStatus,
  TERMINAL_ORDER_STATUSES,
  tryOpenCycle,
  type OrderRow,
  type OrderStatus,
} from '../orders.js';
import { spendToday, type SpendState } from '../spend.js';
import { budgetFor, raiseInterrupt } from '../interrupts.js';
import { humanMembersOfPrincipal, principalOf } from '../members.js';
import { fireSummon } from './summon.js';
import type { CommandContext, CommandDeps } from './context.js';

// ============================================================================
// THE LOOP RUNNER (S-LOOP) — a completed turn drives the next cycle, WITHIN LIMITS.
//
// This is the thing that was missing: nothing took a completed turn, fired the next summon, and
// repeated without a person pressing go. It runs at the post-completion seam (agent.ts), where the
// turn already holds its own chain in-process, and it is governed, not governing — every summon it
// fires travels the existing constructor, order-ROOTED (the human creator is the head of the chain),
// and is refused exactly as a human's would be. An order causes; it does not grant.
//
// TWO BOUNDS, TWO PLACES: the depth cap (S1.8) stops runaway WITHIN a cycle; the order's own guards
// stop runaway ACROSS cycles. Those guards are FOUR, and every one of them STOPS OUT LOUD — the order
// moves to a named state, the reason is a sentence in the room, and its owner is told through an
// interrupt (S1.4). A loop that quits silently is indistinguishable from one that broke.
//
//   EXPIRY        (terminal)  the wall-clock deadline passed — the order will never fire again.
//   CEILING       (pause)     the daily spend ceiling is reached — no money to run on; resume later.
//   MAX CYCLES    (terminal)  the count the creator set has been reached — the work is done.
//   ATTENDANCE    (pause)     it has run its unattended budget of cycles with nobody watching.
//
// The two pauses can resume; the two terminals cannot. Expiry and the ceiling are checked BEFORE a
// cycle opens (an expired or unfundable order must not run one more); the count and the dial are read
// FROM the atomic open (orders.tryOpenCycle) and checked AFTER the cycle fires, so the cycle that
// reaches the limit is the last one that runs, not the one that is refused.
// ============================================================================

/**
 * Fire one cycle of an order, subject to its limits. Returns whether a cycle actually fired — false
 * when the order was stopped by a pre-open gate (expiry, ceiling), or when the atomic open found the
 * order not idle, not active, or the trigger a replay.
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
  // ── PRE-OPEN GATE 0: THE ORDER MUST SAY WHAT IT IS FOR (S-TASK, pause) ──────────────
  //
  // Only orders created before S-TASK can be here: creation refuses a missing task, and nothing
  // edits one. There is no honest way to fire this — an objective cannot be inferred from a trigger
  // and an action member, and firing with an empty one is precisely the bug S-TASK exists to fix
  // (SL2-N5: a paid turn spent asking what the work is). So it stops, and it stops OUT LOUD, naming
  // the rule and what a person must do. PAUSED rather than terminal because the order is not wrong,
  // it is incomplete — and the fix is a new order, so the pause is where it stays.
  if (order.task === null || order.task.trim() === '') {
    await stopOrder(
      deps,
      roomId,
      order,
      'PAUSED',
      `the standing order paused because it has no task, so nothing can say what a cycle is for — ` +
        `a task is set once when an order is created and cannot be added later, so create a new order with one`,
    );
    return false;
  }

  // ── PRE-OPEN GATE 0b: THE ORDER MUST STILL HAVE A VOICE (S-DIAL, pause) ─────────────
  //
  // AN ORDER THAT CANNOT SPEAK MUST NOT CONTINUE. `interrupts_per_day` is spent per RAISER per day,
  // and an order's own stop-interrupt is charged to its ACTION MEMBER — the same member whose cycles
  // run and whose co-signatures are charged. So a loop at a raised dial can spend its whole voice on
  // ordinary claims and then keep running with no way to tell anyone anything: the exact failure
  // S-PUSH exists to prevent, arriving through a door S-PUSH does not watch.
  //
  // THE FIX IS NOT A BIGGER BUDGET. Raising the number only moves where the silence starts, and the
  // budget exists because an agent that can interrupt without limit can exhaust a person. So this
  // fails closed instead, in ADR-001's shape: when the thing that governs is unavailable, the action
  // does not proceed. Checked BEFORE a cycle opens, next to expiry and the ceiling, because a cycle
  // that runs and then cannot report is worse than one that never ran.
  //
  // ── THE LAST UNTELLABLE EVENT, NAMED ────────────────────────────────────────────────
  //
  // THIS PAUSE IS THE ONE THING THAT CANNOT REACH A CLOSED PHONE. Telling it would mean raising an
  // interrupt, and the reason it is happening is that raising one is refused. There is no exemption
  // here on purpose — an exemption is a widening, and a widening written under pressure becomes
  // permanent. So the boundary is stated rather than engineered around:
  //
  //   the last event that CAN reach a phone is the raise that spends the final unit of budget;
  //   the pause that follows is visible in the ROOM (an order.status event and a sentence) and in
  //   the log, and it is found the next time a person opens the room.
  //
  // The loop still STOPS, which is the property that matters: a person who does not look finds a
  // paused order rather than a loop that ran all night unable to say so.
  const voice = await budgetFor(deps.pool, order.action_member_id);
  if (voice.remaining !== null && voice.remaining <= 0) {
    await stopOrder(
      deps,
      roomId,
      order,
      'PAUSED',
      `the standing order paused because ${order.action_member_id} has spent its interrupt budget ` +
        `for today (${voice.spent}/${voice.limit}), so it could no longer tell you anything — ` +
        `a loop that cannot speak does not keep running. It can resume tomorrow, or you can resume it now`,
    );
    return false;
  }

  // ── PRE-OPEN GATE 1: EXPIRY (terminal) ──────────────────────────────────────────────
  // A wall-clock deadline, compared against the DATABASE clock — the same `now()` the ceiling and the
  // interrupt budget use, so one definition of "now" decides every time-bounded thing in the system.
  if (await orderExpired(deps.pool, order)) {
    await stopOrder(
      deps,
      roomId,
      order,
      'EXPIRED',
      `the standing order reached its expiry and stopped — it will not run again`,
    );
    return false;
  }

  // ── PRE-OPEN GATE 2: THE DAILY CEILING (pause) ──────────────────────────────────────
  // A pre-check, no retry, out loud — the same refusal a stranger's tag gets (spend.ts), one level up:
  // a loop must not be the thing that runs my provider key past the ceiling while nobody is watching.
  // Paused, not terminal: it can resume once the ceiling resets, and a person can resume it sooner.
  const spend = await spendToday(deps.pool);
  if (spend.exceeded) {
    await stopOrder(
      deps,
      roomId,
      order,
      'PAUSED',
      `the standing order paused because ${ceilingPhrase(spend)} was reached — ` +
        `it can resume once the limit resets at midnight UTC`,
    );
    return false;
  }

  // ── OPEN THE CYCLE — the atomic idempotency + one-in-flight guard (migration 022) ────
  const opened = await tryOpenCycle(deps.pool, order.id, triggerSeq);
  if (opened === null) return false;
  const { cycle, unattended } = opened;

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
    // THE ORDER'S TASK IS THE SUMMON'S INTENT (S-TASK). This used to be
    // `standing order — <creator> authorised <member> to recur`, which named the AUTHORITY and never
    // the WORK, so a briefed cycle arrived framed and unasked (SL2-N5).
    //
    // WHY THE INTENT AND NOT A NEW ASSEMBLY REGION: the intent is already durable. `fireSummon`
    // writes it to `tasks.intent`, a column, and assembly's `task` part reads that row from the
    // RECORD on every turn — so it cannot scroll out of the recent window any more than the briefing
    // can, which was the requirement. A fifth region would have meant a new declared part, a second
    // read of the same fact, and threading the order id into `assembleContext`, to deliver text that
    // the existing task region already carries and already labels.
    //
    // The creator is not lost by dropping the old sentence: the summon's `requested_by`/`root_actor`
    // and the order.cycled event carry it, which is where provenance belongs.
    intent: order.task,
    orderId: order.id,
  });
  deps.log.info(
    { room_id: roomId, order_id: order.id, cycle, unattended, member: order.action_member_id },
    'standing order fired a cycle',
  );

  // ── POST-OPEN GATE 3: MAX CYCLES (terminal) ─────────────────────────────────────────
  // The cycle just fired was allowed; if it reached the count the creator set, it was the LAST one.
  // Terminal — the work the order described is finished, not merely resting.
  if (order.max_cycles !== null && cycle >= order.max_cycles) {
    await stopOrder(
      deps,
      roomId,
      order,
      'LIMIT_REACHED',
      `the standing order finished the ${order.max_cycles} ${plural(order.max_cycles, 'cycle')} ` +
        `it was set to run`,
    );
    return true;
  }

  // ── POST-OPEN GATE 4: THE ATTENDANCE DIAL (pause) ───────────────────────────────────
  // It has now run this many cycles since a person last watched (a message in the room, or a resume).
  // At the dial it pauses and taps its owner on the shoulder — a loop should not run forever unseen.
  if (unattended >= order.max_unattended_cycles) {
    await stopOrder(
      deps,
      roomId,
      order,
      'PAUSED',
      `the standing order ran ${unattended} ${plural(unattended, 'cycle')} without you — ` +
        `resume it to keep the loop going`,
    );
  }
  return true;
}

/** Is this order past its expiry? Null expiry never expires. Compared against the DB clock. */
async function orderExpired(pool: CommandDeps['pool'], order: OrderRow): Promise<boolean> {
  if (!order.expires_at) return false;
  const { rows } = await pool.query<{ expired: boolean }>(
    'SELECT ($1::timestamptz <= now()) AS expired',
    [order.expires_at],
  );
  return rows[0].expired;
}

/** A short phrase naming the ceiling, for the pause sentence. No spend figure — see spend.ts. */
function ceilingPhrase(spend: SpendState): string {
  return spend.ceiling_usd === null
    ? "today's spending ceiling"
    : `today's $${spend.ceiling_usd} spending ceiling`;
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

/**
 * STOP AN ORDER, OUT LOUD — the one place a self-stop is written. Appends the order.status event
 * (log first, §12), moves the projection, fans out, and raises the owner's interrupt. Guarded on the
 * order still being ACTIVE so a racing second trigger cannot stop it twice; the winner is whoever
 * reads it ACTIVE first, and the rest are no-ops. `system` is the actor — nothing changes an order
 * silently, but no person acted here.
 */
async function stopOrder(
  deps: CommandDeps,
  roomId: string,
  order: OrderRow,
  status: OrderStatus,
  reason: string,
): Promise<boolean> {
  const fresh = await orderById(deps.pool, roomId, order.id);
  if (!fresh || fresh.status !== 'ACTIVE') return false; // already stopped, terminal, or gone

  const event = await appendOrderStatus(deps.pool, roomId, 'system', {
    order_id: order.id,
    status,
    reason,
    actor: 'system',
  });
  await setOrderStatus(deps.pool, order.id, status, reason);
  deps.bus.publish(roomId, event);
  // THE TONE IS DERIVED FROM THE STATUS THIS FUNCTION JUST WROTE (S-DIAL), and from nothing a member
  // said. TERMINAL_ORDER_STATUSES is the server's own set — REVOKED, EXPIRED, LIMIT_REACHED — so a
  // FINISHED notification can only follow an order the SERVER ended. A pause (attendance, ceiling,
  // error, a spent voice) is NEEDS-YOU, because every one of those wants a person.
  const telling = await raiseOrderInterrupts(
    deps,
    roomId,
    order,
    reason,
    TERMINAL_ORDER_STATUSES.has(status) ? 'FINISHED' : 'NEEDS-YOU',
  );
  // WHETHER ANYONE WAS TOLD IS PART OF THE RECORD OF THE STOP. The order.status event above and the
  // sentence in the room happen either way — the ROOM always knows. What this line distinguishes is
  // whether the claim on a person could be made at all, which is the difference between "stopped,
  // and they will hear" and "stopped, and they will find out when they next look".
  deps.log.warn(
    {
      room_id: roomId,
      order_id: order.id,
      status,
      told: telling.told,
      untellable: telling.refusedForBudget,
    },
    telling.told === 0 && telling.refusedForBudget > 0
      ? 'standing order stopped itself and could NOT tell anyone: the interrupt budget is spent'
      : 'standing order stopped itself',
  );
  return true;
}

/**
 * A STOPPED ORDER CLAIMS ITS OWNER'S ATTENTION (S1.4). One DECISION interrupt per human member of the
 * creator's principal — the sibling of coSign's `raiseDecisionInterrupts`, routed through the same
 * single construction site (`raiseInterrupt`) so the budget, the idempotency and the record are the
 * ones every interrupt already has.
 *
 * WHO IS CHARGED: the loop's own AGENT member (`action_member`). The recurring work is the agent's,
 * so the claim it makes on a person's attention is the agent's to fund — the same reasoning that
 * charges a co-sign to the subject whose mandate needs the signature.
 *
 * about_id IS UNIQUE PER STOP. There is no interrupt-clearing in the system; a claim persists as the
 * record that it was made. So a fresh id per stop is what lets the SAME order re-claim attention when
 * it pauses again after a resume — keyed on the order (the prefix attributes it) with a unique suffix
 * (each stop is its own moment). A budget refusal is logged and does NOT undo the stop: the order is
 * already stopped and the record already written; what failed is the notification.
 */
async function raiseOrderInterrupts(
  deps: CommandDeps,
  roomId: string,
  order: OrderRow,
  summary: string,
  tone: 'FINISHED' | 'NEEDS-YOU',
): Promise<{ told: number; refusedForBudget: number }> {
  const principal = await principalOf(deps.pool, order.creator_member_id);
  // RETURNED, NOT SWALLOWED (S-DIAL). This used to be `Promise<void>`, so `stopOrder` could not tell
  // a stop that reached its owner from one that reached nobody — an order could stop itself in
  // silence and the log would read exactly the same. The counts go back to the caller now.
  if (!principal) return { told: 0, refusedForBudget: 0 };
  let told = 0;
  let refusedForBudget = 0;
  const aboutId = `${order.id}:${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  for (const human of await humanMembersOfPrincipal(deps.pool, roomId, principal)) {
    const raised = await raiseInterrupt(deps.pool, {
      roomId,
      urgency: 'DECISION',
      raisedBy: order.action_member_id,
      addressedTo: human,
      aboutKind: 'order',
      aboutId,
      summary,
      // Only ever 'FINISHED' from a terminal status; NEEDS-YOU is the absence of the field.
      ...(tone === 'FINISHED' ? { notifyTone: 'FINISHED' as const } : {}),
    });
    if (!raised.ok) {
      deps.log.warn(
        {
          room_id: roomId,
          order_id: order.id,
          raised_by: order.action_member_id,
          addressed_to: human,
          spent: raised.budget.spent,
          limit: raised.budget.limit,
          code: ERROR_INTERRUPT_BUDGET,
        },
        'order interrupt refused: no budget left today',
      );
      refusedForBudget += 1;
      continue;
    }
    told += 1;
    if (raised.event) deps.bus.publish(roomId, raised.event);
    // No halt branch: a DECISION never halts a task (interrupts.ts). Only a BLOCKER does.
  }
  return { told, refusedForBudget };
}

/**
 * An error terminal pauses the order, out loud. A turn that ended in error does not trigger the next
 * cycle — cycling into an error loop would burn budget and hide the failure; pausing surfaces it as
 * the "needs your input" moment. Keyed on the ERRORED turn's order (threaded through the chain), so
 * the order whose cycle broke is the one that pauses. Routed through `stopOrder`, so an error-stop
 * claims its owner's attention exactly like every other self-stop.
 */
async function pauseOrderOnError(
  deps: CommandDeps,
  roomId: string,
  orderId: string,
  member: string,
  errorClass?: string | null,
): Promise<void> {
  const order = await orderById(deps.pool, roomId, orderId);
  if (!order) return;
  // THE CLASS IS IN THE SENTENCE. A pause that says only "ended in error" reads identically whether
  // the provider was down or the fabric refused the window it was about to send, and the room is
  // where the owner reads it. Naming the class costs one clause and is the difference between "the
  // model had a bad night" and "this loop cannot run until someone fixes assembly".
  const named = errorClass ? ` (${errorClass})` : '';
  await stopOrder(
    deps,
    roomId,
    order,
    'PAUSED',
    `${member}'s turn ended in error${named}, so the loop paused rather than cycling on a failure`,
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
    errorClass?: string | null;
  },
): Promise<void> {
  if (!input.success) {
    if (input.orderId)
      await pauseOrderOnError(deps, input.roomId, input.orderId, input.member, input.errorClass);
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
