import { randomUUID } from 'node:crypto';
import { isAgentActor } from '../agent.js';
import { appendSummon } from '../events.js';
import type { CommandContext, CommandDeps, TurnSpans } from './context.js';

/**
 * THE ONLY PLACE A SUMMON IS BUILT.
 *
 * Same discipline as `requestAction` being the only constructor of a decision event: an
 * invariant that lives in one function can be read, and an invariant spread across call
 * sites is a convention that will be half-applied. `postMessage` is a CALLER of this —
 * it decides WHO was named, this decides whether a summon may exist and what it records.
 *
 * ── DEPTH ──
 *
 * `depth` is owned here and is NOT an input. The signature cannot express a non-zero
 * depth, so there is no call site that can quietly produce a chain: adding an
 * agent-initiated summon means deliberately opening this constructor and bringing its
 * cap with it, at this one line, rather than passing a different number from somewhere.
 *
 * There is deliberately NO CAP YET. A cap on a depth nothing can reach is enforcement
 * built before the thing it enforces — speculative code that reads as a guarantee. The
 * cap arrives with the path that needs it, which is S1.3's handoff object, because
 * "@Sol, take review" is a task transfer and not a mention.
 *
 * ── WHY THIS RE-CHECKS THE AUTHOR ──
 *
 * Extracting a command adds a way to reach it: anything holding `deps.execute` can now
 * dispatch `{ kind: 'summon' }`, where before the only path ran downstream of
 * `summonRuling` and could not name an agent. `root_is_human: true` would then be a
 * hardcoded claim behind an open door. So barrier 2 is re-applied HERE, at the choke
 * point, and refuses loudly rather than writing a summon that lies about its root.
 */

/** Human-rooted, and the only depth this constructor can produce. */
const HUMAN_ROOT_DEPTH = 0;

export interface SummonInput {
  roomId: string;
  /** The adapter id `summonRuling` resolved. Never a raw token. */
  member: string;
  /** The event that asked. Half the natural key migration 005 makes unique. */
  causeSeq: number;
  spans?: TurnSpans;
}

export async function summonCommand(
  deps: CommandDeps,
  ctx: CommandContext,
  input: SummonInput,
): Promise<void> {
  // BARRIER 2, at the construction site. `ctx.actorId` is the root being recorded, so a
  // non-human here would mean writing root_is_human: true about an agent.
  if (ctx.actorId === 'system' || isAgentActor(ctx.actorId)) {
    deps.log.warn(
      { room_id: input.roomId, member: input.member, requested_by: ctx.actorId },
      'summon refused: only a human may root a summon',
    );
    return;
  }

  const summonId = `sum_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const summon = await appendSummon(deps.pool, input.roomId, {
    summon_id: summonId,
    member: input.member,
    requested_by: ctx.actorId,
    // Recorded, not derived — S1.1 is what makes a member resolvable, and this log has
    // to be checkable before then. Only as true as the identity claim behind it, which
    // arrives unauthenticated until S1.2.
    root_actor: ctx.actorId,
    root_is_human: true,
    depth: HUMAN_ROOT_DEPTH,
    cause_seq: input.causeSeq,
  });

  // NULL IS NOT AN ERROR. It means this cause has already summoned this member —
  // migration 005 refused the second insert — so the turn it authorises is already
  // running or already done. Triggering here is what made a replayed frame produce two
  // agent turns from one human ask. One call site, one branch, no convention to forget.
  if (!summon) {
    deps.log.info(
      { room_id: input.roomId, member: input.member, cause_seq: input.causeSeq },
      'summon already exists for this cause',
    );
    return;
  }
  deps.bus.publish(input.roomId, summon);

  void deps
    .execute(
      { actorId: input.member, mode: 'hosted' },
      {
        kind: 'triggerAgentTurn',
        roomId: input.roomId,
        adapterId: input.member,
        summonId,
        spans: input.spans,
      },
    )
    .catch(() => {}); // runAgentTurn writes its own error event; this guards the fire-and-forget
}
