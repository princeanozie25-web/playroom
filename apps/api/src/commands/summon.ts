import { randomUUID } from 'node:crypto';
import { isAgentActor } from '../agent.js';
import { appendMessage, appendRouteSelected, appendSummon } from '../events.js';
import { selectRoute } from '../routes.js';
import { ensureTask, taskCreatedEvent, transitionTask } from '../tasks.js';
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
  /** The sentence that asked, recorded on the task so it can say what it is for. */
  intent: string;
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

  // ── IS THIS MEMBER REACHABLE? ─────────────────────────────────────────────────────────
  //
  // A member record says they EXIST; a route says they are REACHABLE. Checked HERE rather than
  // in the activation boundary because it is operational state, not a property of the text: a
  // provider going down does not change what a member's message said. The boundary stays pure
  // and its guards are untouched.
  //
  // §6.2's failure rule: a member with no usable route names the FAILED CONSTRAINT. Never a
  // silent downgrade and never a silent nothing — the room gets a sentence, and no summon is
  // written, so nothing downstream believes a turn was asked for.
  // ── THE TASK EXISTS BEFORE THE ROUTE IS CHOSEN ────────────────────────────────────────
  //
  // Deliberately in this order, and §6.2 is why: "if no route satisfies the constraints, THE
  // TASK enters input-required". A task created after a successful route selection could never
  // be in that state — the failure path would have returned already, and `input-required` would
  // stay what it has been since S1.1c, a state the Bible names and the code cannot reach.
  //
  // So the work becomes a record as soon as a human asks for it, and route selection decides
  // which state it starts in. NOT created as `working` and corrected: that writes a state the
  // task was never in, and this log is read as a history.
  //
  // `action` is null. Answering in a room is not a governed action and no mandate scope covers
  // it; a placeholder like 'chat.reply' would invent a scope nobody grants. A handoff is what
  // sets it, because a handoff has to say what work is being handed over.
  const selection = await selectRoute(deps.pool, input.member);
  const { task, created } = await ensureTask(deps.pool, {
    roomId: input.roomId,
    assignee: input.member,
    state: selection.route ? 'working' : 'input-required',
    action: null,
    intent: input.intent,
    createdBy: ctx.actorId,
    causeSeq: input.causeSeq,
  });
  // Only when the row was actually inserted. A replayed frame resolves to the task that
  // already exists, and a second `task.created` for it would put one task in the log twice.
  if (created) deps.bus.publish(input.roomId, await taskCreatedEvent(deps.pool, task, ctx.actorId));

  if (!selection.route) {
    deps.log.warn(
      {
        room_id: input.roomId,
        member: input.member,
        reason: selection.reason,
        failed_constraint: selection.failed_constraint,
      },
      'summon refused: no usable route',
    );
    // A TASK THAT EXISTED ALREADY still has to end up in the right state — the replay case,
    // and the case where a route was available a moment ago and is not now. Returns null when
    // the state is already `input-required`, so nothing is appended twice.
    const moved = await transitionTask(
      deps.pool,
      task,
      'input-required',
      selection.failed_constraint,
      'system',
    );
    if (moved) deps.bus.publish(input.roomId, moved);

    // The room says which constraint failed, keyed to the causing event so a replayed frame
    // resolves to the same notice rather than repeating it. THE SENTENCE IS UNCHANGED from
    // S1.1c: the task state is a new record of the same refusal, not a new refusal.
    const notice = await appendMessage(
      deps.pool,
      input.roomId,
      'system',
      `sys-noroute-${input.causeSeq}-${input.member}`,
      `${input.member} cannot be reached: ${selection.failed_constraint}.`,
    );
    deps.bus.publish(input.roomId, notice);
    return;
  }

  const summonId = `sum_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const summon = await appendSummon(
    deps.pool,
    input.roomId,
    { task_id: task.id },
    {
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
    },
  );

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

  // WHICH ROUTE, AND WHY — Bible §6.2. Written after the summon so it can reference it, and
  // before the turn is triggered so the log reads in the order the decisions were made.
  deps.bus.publish(
    input.roomId,
    await appendRouteSelected(
      deps.pool,
      input.roomId,
      { task_id: task.id },
      {
        summon_id: summonId,
        member: input.member,
        route_id: selection.route.id,
        route_type: selection.route.type,
        reason: selection.reason,
      },
    ),
  );

  void deps
    .execute(
      { actorId: input.member, mode: 'hosted' },
      {
        kind: 'triggerAgentTurn',
        roomId: input.roomId,
        adapterId: input.member,
        summonId,
        taskId: task.id,
        spans: input.spans,
      },
    )
    .catch(() => {}); // runAgentTurn writes its own error event; this guards the fire-and-forget
}
