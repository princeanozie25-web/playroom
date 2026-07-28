import { randomUUID } from 'node:crypto';
import { evaluate } from '@playroom/fabric';
import { isAgentActor, SUMMON_INITIATE_ACTION } from '../agent.js';
import { appendMessage, appendRouteSelected, appendSummon } from '../events.js';
import { mandateFor } from '../mandates.js';
import { listRoomMembers, resolveRoomAgent } from '../members.js';
import { selectRoute } from '../routes.js';
import { ensureTask, taskCreatedEvent, transitionTask } from '../tasks.js';
import type { CommandContext, CommandDeps, SummonChain, TurnSpans } from './context.js';

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
 * The cap was left as a TODO until the path that needed it arrived. S1.8 is that path: an agent can
 * now EMIT a summon through the tool-call channel, so the cap is load-bearing here — see below.
 *
 * ── WHY THIS RE-CHECKS THE AUTHOR ──
 *
 * Extracting a command adds a way to reach it: anything holding `deps.execute` can now
 * dispatch `{ kind: 'summon' }`, where before the only path ran downstream of
 * `summonRuling` and could not name an agent. `root_is_human: true` would then be a
 * hardcoded claim behind an open door. So the root is decided HERE, at the choke point,
 * and refuses loudly rather than writing a summon that lies about its root.
 */

/** Human-rooted depth. */
const HUMAN_ROOT_DEPTH = 0;

/**
 * THE DEPTH CAP, now load-bearing (S1.8). A human summon is depth 0; an agent A it summons may itself
 * emit a summon of B (depth 1); B may NOT emit a further summon (depth 2 exceeds the cap). One hop of
 * agent-initiated summoning, never a chain. When more agents are granted `summon.initiate`, this is
 * what keeps their chains from running away — the runaway-loop bound the summon channel needs.
 */
const SUMMON_DEPTH_CAP = 1;

export interface SummonInput {
  roomId: string;
  /** The member `summonRuling` (human path) or `resolveRoomAgent` (agent path) resolved. Never a raw token. */
  member: string;
  /** The event that asked. Half the natural key migration 005 makes unique. */
  causeSeq: number;
  /** The sentence that asked, recorded on the task so it can say what it is for. */
  intent: string;
  spans?: TurnSpans;
  /**
   * When an AGENT emitted this summon through the tool-call channel (S1.8), the chain it extends:
   * the human root at the head, and the depth of the emitting turn's own summon. Absent = human-rooted
   * (depth 0).
   *
   * This is the ONE field that lets an agent root a summon, and it deliberately brings the depth cap
   * and the mandate check with it — there is no way to produce an agent-rooted summon that skips the
   * branch which checks both.
   */
  chain?: SummonChain;
}

export async function summonCommand(
  deps: CommandDeps,
  ctx: CommandContext,
  input: SummonInput,
): Promise<void> {
  // ── WHO MAY ROOT THIS SUMMON, WHOM IT NAMES, AND AT WHAT DEPTH ────────────────────────────
  let rootActor: string;
  let rootIsHuman: boolean;
  let depth: number;
  // The resolved target. On the human path `input.member` is already resolved (summonRuling did it);
  // on the agent path it is a RAW string the model emitted, resolved here against the room's agents.
  let member: string;

  if (input.chain) {
    // AGENT-EMITTED (S1.8). The human path's "only a human may root" is REPLACED here by two
    // controls, each refused OUT LOUD — silence is RT-001's shape and this is exactly the surface
    // where it is tempting. A human summon never reaches this branch (no chain), and an agent summon
    // never reaches the human branch. Target-in-room was already enforced by the caller resolving the
    // target against the room's agents (runAgentTurn), as summonRuling resolves the human path's.
    //
    //  1. THE EMITTING AGENT'S MANDATE must grant `summon.initiate` — THE INJECTION DEFENSE. An agent
    //     talked into emitting a summon it is not authorised for is refused here, whatever the foreign
    //     content in its context said. Default-closed. Evaluated through evaluate(), so the scope
    //     entry is one the evaluator actually receives (mandate.ts's rule), not dead authority text.
    //  2. THE DEPTH CAP.
    //
    // Standing before request (RA-007): the mandate — may this agent summon AT ALL — is checked
    // before the depth, which is a property of this particular summon.
    const roster = (await listRoomMembers(deps.pool, input.roomId)).map((m) => m.id);
    const verdict = evaluate(
      { type: SUMMON_INITIATE_ACTION, resource: `member:${input.member}` },
      ctx.actorId,
      mandateFor(ctx.actorId),
      undefined,
      roster,
    );
    if (verdict.decision !== 'ALLOW') {
      deps.log.warn(
        {
          room_id: input.roomId,
          requested_by: ctx.actorId,
          member: input.member,
          reason_code: verdict.reason_code,
        },
        'summon refused: emitting agent is not authorised to initiate a summon',
      );
      const notice = await appendMessage(
        deps.pool,
        input.roomId,
        'system',
        `sys-nosummon-${input.causeSeq}-${input.member}`,
        `${ctx.actorId} cannot initiate a summon — its mandate does not grant it.`,
      );
      deps.bus.publish(input.roomId, notice);
      return;
    }
    depth = input.chain.depth + 1;
    if (depth > SUMMON_DEPTH_CAP) {
      deps.log.warn(
        {
          room_id: input.roomId,
          requested_by: ctx.actorId,
          member: input.member,
          depth,
          cap: SUMMON_DEPTH_CAP,
        },
        'summon refused: depth cap exceeded',
      );
      const notice = await appendMessage(
        deps.pool,
        input.roomId,
        'system',
        `sys-depth-${input.causeSeq}-${input.member}`,
        `${ctx.actorId} cannot summon ${input.member}: an agent that was itself summoned may not start another summon.`,
      );
      deps.bus.publish(input.roomId, notice);
      return;
    }
    // 3. TARGET IN ROOM (control a). `input.member` is a RAW string the model emitted; resolve it
    // against the room's AGENT members. A target that is not an agent in this room is refused — the
    // structured path's "cannot summon a member outside the room", enforced at the choke point rather
    // than trusted to the caller. Resolved AFTER the mandate check so an unauthorised agent learns
    // nothing about the room's membership from a resolution result.
    const resolved = await resolveRoomAgent(deps.pool, input.roomId, input.member);
    if (!resolved) {
      deps.log.warn(
        { room_id: input.roomId, requested_by: ctx.actorId, target: input.member },
        'summon refused: target is not an agent member of this room',
      );
      const notice = await appendMessage(
        deps.pool,
        input.roomId,
        'system',
        `sys-notarget-${input.causeSeq}-${input.member.slice(0, 32)}`,
        `${ctx.actorId} cannot summon "${input.member.slice(0, 32)}" — no agent by that name is in this room.`,
      );
      deps.bus.publish(input.roomId, notice);
      return;
    }
    member = resolved;
    rootActor = input.chain.rootActor;
    rootIsHuman = input.chain.rootIsHuman;
  } else {
    // HUMAN-ROOTED. Barrier 2, unchanged: only a human may root a summon. `ctx.actorId` is the root
    // being recorded, so a non-human here would mean writing root_is_human: true about an agent.
    if (ctx.actorId === 'system' || isAgentActor(ctx.actorId)) {
      deps.log.warn(
        { room_id: input.roomId, member: input.member, requested_by: ctx.actorId },
        'summon refused: only a human may root a summon',
      );
      return;
    }
    member = input.member;
    rootActor = ctx.actorId;
    rootIsHuman = true;
    depth = HUMAN_ROOT_DEPTH;
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
  const selection = await selectRoute(deps.pool, member);
  const { task, created } = await ensureTask(deps.pool, {
    roomId: input.roomId,
    assignee: member,
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
        member,
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
      `sys-noroute-${input.causeSeq}-${member}`,
      `${member} cannot be reached: ${selection.failed_constraint}.`,
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
      member,
      // WHO ASKED is the actor — the human on the human path, the emitting agent on the structured
      // path (S1.8). WHO IS AT THE HEAD of the chain is `root_actor`, and it is a human on both paths:
      // an agent-emitted summon inherits the human root of the turn that emitted it.
      requested_by: ctx.actorId,
      root_actor: rootActor,
      root_is_human: rootIsHuman,
      depth,
      cause_seq: input.causeSeq,
    },
  );

  // NULL IS NOT AN ERROR. It means this cause has already summoned this member —
  // migration 005 refused the second insert — so the turn it authorises is already
  // running or already done. Triggering here is what made a replayed frame produce two
  // agent turns from one human ask. One call site, one branch, no convention to forget.
  if (!summon) {
    deps.log.info(
      { room_id: input.roomId, member, cause_seq: input.causeSeq },
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
        member,
        route_id: selection.route.id,
        route_type: selection.route.type,
        reason: selection.reason,
      },
    ),
  );

  void deps
    .execute(
      { actorId: member, mode: 'hosted' },
      {
        kind: 'triggerAgentTurn',
        roomId: input.roomId,
        adapterId: member,
        summonId,
        taskId: task.id,
        spans: input.spans,
        // THE CHAIN THIS TURN CARRIES (S1.8): its own summon's root and depth. If this turn emits a
        // summon of its own, that is the chain it extends — so the depth cap sees one more hop, and
        // the human root at the head is preserved down the chain. A human-rooted turn (depth 0)
        // passes depth 0; an agent-emitted turn passes its depth, and the constructor increments.
        chain: { rootActor, rootIsHuman, depth },
      },
    )
    .catch(() => {}); // runAgentTurn writes its own error event; this guards the fire-and-forget
}
