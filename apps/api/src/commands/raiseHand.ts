import { ERROR_INTERRUPT_BUDGET } from '@playroom/shared';
import { humanMembersOfPrincipal, principalOf } from '../members.js';
import { raiseInterrupt, type Budget } from '../interrupts.js';
import type { CommandContext, CommandDeps } from './context.js';

/**
 * RAISE A BARE HAND (SCC-3, SCC3-1) — the thing SCC2-N1 said the door could not do.
 *
 * A connected member surfaces a NON-decision concern: a BLOCKER ("I'm blocked, need input") or an FYI
 * ("heads up"). It is NOT a decision — it mints no decision event, cannot be resolved by a signature,
 * and `requestAction` is never called. It is exactly one fact: an `interrupt.raised` about a 'hand'
 * (migration 025), addressed to the humans of the RAISER's own principal, and charged to the raiser
 * from the same `interrupts_per_day` budget every other claim on a person's attention spends. No
 * message, no summon, no attendance reset — a raised hand does not pretend the room is being watched.
 *
 * ── SILENCE IS FREE; INTERRUPTS ARE PRICED ──
 *
 * The budget check lives in `raiseInterrupt`, the sole construction site. A BLOCKER costs one; an FYI
 * costs nothing and so is never refused. When the budget is spent the raise is refused with its OWN
 * reason code (`interrupt_budget_exhausted`) — legible enough for the agent to stop or continue
 * without escalating, rather than spin. A refusal writes nothing.
 *
 * ── DERIVED, NEVER CLAIMED ──
 *
 * `raisedBy` is the credential's member (ctx.actorId) and `addressedTo` is resolved from that member's
 * principal — never read from a request body. A member cannot raise a hand AS another member, or point
 * one AT an arbitrary member: the record is member-addressed by construction, exactly as the action and
 * message doors derive their actor.
 */
export type RaisedHandUrgency = 'BLOCKER' | 'FYI';

export interface RaisedHand {
  interrupt_id: string;
  addressed_to: string;
  budget_remaining: number | null;
}

export interface RaiseHandResult {
  /** The humans an interrupt was addressed to — the raiser's own principal's humans, in this room. */
  addressed: string[];
  /** One per human whose attention was successfully claimed. */
  raised: RaisedHand[];
  /** Present when the daily budget refused at least one addressee. The priced claim, not the concern. */
  refused: { code: typeof ERROR_INTERRUPT_BUDGET; budget: Budget } | null;
}

export async function raiseHandCommand(
  deps: CommandDeps,
  ctx: CommandContext,
  input: { roomId: string; clientMsgId: string; urgency: RaisedHandUrgency; reason: string },
): Promise<RaiseHandResult> {
  // WHO TO REACH: the humans of the raiser's own principal — claude-code raises a hand to Prince. The
  // same resolution the co-sign path uses (humanMembersOfPrincipal), so a second human behind the
  // principal is told too, with no reshaped record. ctx.principalId is set by the door; principalOf is
  // the fallback for callers that do not carry it.
  const principal = ctx.principalId ?? (await principalOf(deps.pool, ctx.actorId));
  const humans = principal ? await humanMembersOfPrincipal(deps.pool, input.roomId, principal) : [];

  const raised: RaisedHand[] = [];
  let refused: RaiseHandResult['refused'] = null;
  for (const human of humans) {
    // about_id is derived from the caller's idempotency token, so a retried raise claims a person's
    // attention exactly once (the uniqueness index dedups) while a fresh raise gets its own claim. No
    // taskId: a connected member's work is bridged (RT-005), so there is no fabric task to halt — a
    // BLOCKER from a puller claims attention without stopping anything the fabric owns.
    const r = await raiseInterrupt(deps.pool, {
      roomId: input.roomId,
      urgency: input.urgency,
      raisedBy: ctx.actorId,
      addressedTo: human,
      aboutKind: 'hand',
      aboutId: `hand:${input.clientMsgId}`,
      summary: input.reason,
    });
    if (!r.ok) {
      // The priced ping is refused; nothing was written for this addressee. Logged with the operator
      // distinction (spent/limit), told to the caller only as a named code.
      deps.log.warn(
        {
          room_id: input.roomId,
          raised_by: ctx.actorId,
          addressed_to: human,
          spent: r.budget.spent,
          limit: r.budget.limit,
          code: ERROR_INTERRUPT_BUDGET,
        },
        'raised hand refused: no budget left today',
      );
      refused = { code: ERROR_INTERRUPT_BUDGET, budget: r.budget };
      continue;
    }
    if (r.event) deps.bus.publish(input.roomId, r.event);
    // The snapshot the room shows — what the raiser had left after this claim. Null on an idempotent
    // re-raise (no fresh event) or for a member with no mandate and so no limit.
    const payload = r.event?.payload as { budget_remaining?: number | null } | undefined;
    const budgetRemaining =
      payload && typeof payload.budget_remaining === 'number' ? payload.budget_remaining : null;
    raised.push({
      interrupt_id: r.interrupt.id,
      addressed_to: human,
      budget_remaining: budgetRemaining,
    });
  }
  return { addressed: humans, raised, refused };
}
