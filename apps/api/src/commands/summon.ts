import { randomUUID } from 'node:crypto';
import { evaluate, type Verdict } from '@playroom/fabric';
import { isAgentActor, SUMMON_INITIATE_ACTION } from '../agent.js';
import {
  appendMessage,
  appendRouteSelected,
  appendSummon,
  type PendingSummonAction,
} from '../events.js';
import { mandateFor } from '../mandates.js';
import { listRoomMembers, matchRoomAgent } from '../members.js';
import { selectRoute } from '../routes.js';
import { ensureTask, taskCreatedEvent, transitionTask } from '../tasks.js';
import { raiseDecisionInterrupts, writeCoSignDecision } from './coSign.js';
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
  /** The member `summonRuling` (human path) or `matchRoomAgent` (agent path) resolved. Never a raw token. */
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
  // The standing order this summon belongs to (S-LOOP), if any. Inherited from the chain on the agent
  // path so a summon emitted inside an order's cycle stays order-rooted; absent on a human tag.
  const orderId = input.chain?.orderId;

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
    // ONE read of the room's members, used for BOTH the evaluator's roster AND target resolution
    // below — reading it twice cost a redundant DB round-trip before B's turn, enough to push the
    // summon-path first token over §11's P95 on the tightest member (docs/demo/s18-*).
    const roomMembers = await listRoomMembers(deps.pool, input.roomId);
    const verdict = evaluate(
      { type: SUMMON_INITIATE_ACTION, resource: `member:${input.member}` },
      ctx.actorId,
      mandateFor(ctx.actorId),
      undefined,
      roomMembers.map((m) => m.id),
    );
    // BLOCK is the injection defense: an agent whose mandate does not grant summon.initiate at all is
    // refused here, whatever its context said. ALLOW and CO_SIGN both proceed — CO_SIGN is an agent
    // that MAY summon but whose summons are PROTECTED (S2.2), and it pauses for a human below rather
    // than being refused. The validity checks (depth, target) run for both before that split.
    if (verdict.decision === 'BLOCK') {
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
    // against the room's AGENT members — the SAME list read above, not a second query. A target that
    // is not an agent in this room is refused — the structured path's "cannot summon a member outside
    // the room", enforced at the choke point rather than trusted to the caller. Resolved AFTER the
    // mandate check so an unauthorised agent learns nothing about the room's membership from a result.
    const resolved = matchRoomAgent(roomMembers, input.member);
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

    // CO_SIGN → PAUSE (S2.2). An agent that MAY summon but whose summons are PROTECTED does not fire
    // one; it writes a decision and waits for a human signature. The held summon rides on the
    // decision's pending_action so an approval fires exactly this summon later — WITHOUT re-evaluating,
    // which would return CO_SIGN again and never complete. BLOCK was refused above; ALLOW falls through
    // to fire immediately. This is the whole of the routine/pivotal split at the summon channel.
    if (verdict.decision === 'CO_SIGN') {
      await pauseSummonForCoSign(deps, ctx, {
        roomId: input.roomId,
        member,
        verdict,
        causeSeq: input.causeSeq,
        intent: input.intent,
        rootActor,
        rootIsHuman,
        depth,
      });
      return;
    }
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

  // Authority is decided; fire the summon. The two entrances to fireSummon — this immediate
  // ALLOW/human path and an APPROVED co-sign (signDecision) — are the only two, and both arrive here
  // already authorised, which is why fireSummon does not re-evaluate.
  await fireSummon(deps, {
    roomId: input.roomId,
    member,
    requestedBy: ctx.actorId,
    rootActor,
    rootIsHuman,
    depth,
    causeSeq: input.causeSeq,
    intent: input.intent,
    spans: input.spans,
    orderId,
  });
}

/** A summon whose authority is already decided — the input `fireSummon` needs. */
export interface FireSummonInput {
  roomId: string;
  member: string; // the resolved target
  requestedBy: string; // who asked — a human, the emitting agent (S1.8), or a loop runner (S-LOOP)
  rootActor: string;
  rootIsHuman: boolean;
  depth: number;
  causeSeq: number;
  intent: string;
  spans?: TurnSpans;
  /** The standing order that fired this summon (S-LOOP), if any — recorded and threaded to the turn. */
  orderId?: string;
}

/**
 * FIRE A SUMMON — reachability, the task, the summon event, the route, and the turn trigger.
 *
 * Extracted from summonCommand's tail (S2.2) so it has EXACTLY TWO callers, and both reach it only
 * AFTER the summon was authorised: an immediate ALLOW/human summon, and an APPROVED co-sign releasing
 * its held summon (commands/signDecision.ts). It therefore does NOT re-evaluate — re-checking a
 * co-signed summon would return CO_SIGN again and it would never fire. THE ONLY PLACE A SUMMON IS
 * BUILT stays true: the authority decision happens before these two entrances, never inside this one.
 */
export async function fireSummon(deps: CommandDeps, input: FireSummonInput): Promise<void> {
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
  // So the work becomes a record as soon as it is asked for, and route selection decides which
  // state it starts in. NOT created as `working` and corrected: that writes a state the task was
  // never in, and this log is read as a history.
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
    createdBy: input.requestedBy,
    causeSeq: input.causeSeq,
  });
  // Only when the row was actually inserted. A replayed frame resolves to the task that
  // already exists, and a second `task.created` for it would put one task in the log twice.
  if (created)
    deps.bus.publish(input.roomId, await taskCreatedEvent(deps.pool, task, input.requestedBy));

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
      // WHO ASKED is the requester — the human on the human path, the emitting agent on the structured
      // path (S1.8). WHO IS AT THE HEAD of the chain is `root_actor`, and it is a human on both paths:
      // an agent-emitted summon inherits the human root of the turn that emitted it. On an approved
      // co-sign the requester is still the emitting agent — the human APPROVED it, they did not ask.
      requested_by: input.requestedBy,
      root_actor: input.rootActor,
      root_is_human: input.rootIsHuman,
      depth: input.depth,
      cause_seq: input.causeSeq,
      order_id: input.orderId,
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
        // THE CHAIN THIS TURN CARRIES (S1.8): its own summon's root and depth. If this turn emits a
        // summon of its own, that is the chain it extends — so the depth cap sees one more hop, and
        // the human root at the head is preserved down the chain. A human-rooted turn (depth 0)
        // passes depth 0; an agent-emitted turn passes its depth, and the constructor increments.
        // THE CYCLE THIS TURN IS, if it is one (S-CYCLE). Set only for an order's OWN first summon:
        // `depth === 0` is what an order fires at, and a summon this turn goes on to emit inherits
        // the order id at depth ≥ 1 — so this field distinguishes "the cycle's turn" from "a turn
        // downstream of the cycle", and only the former counts. Outside the chain on purpose: the
        // chain is inherited, and a cycle is counted once.
        orderTriggerSeq: input.orderId && input.depth === 0 ? input.causeSeq : undefined,
        chain: {
          rootActor: input.rootActor,
          rootIsHuman: input.rootIsHuman,
          depth: input.depth,
          orderId: input.orderId,
        },
      },
    )
    .catch(() => {}); // runAgentTurn writes its own error event; this guards the fire-and-forget
}

/**
 * PAUSE a protected summon for a co-signature (S2.2).
 *
 * Writes a CO_SIGN decision — reusing the DECISION card and the interrupt machinery unchanged — whose
 * `pending_action` carries the HELD summon, then raises the DECISION interrupt. No summon is written
 * and no turn is triggered: the emission stops here until a human signs, and the approval fires
 * exactly this held summon (signDecision → fireSummon), never a re-derived one.
 */
async function pauseSummonForCoSign(
  deps: CommandDeps,
  ctx: CommandContext,
  p: {
    roomId: string;
    member: string;
    verdict: Verdict;
    causeSeq: number;
    intent: string;
    rootActor: string;
    rootIsHuman: boolean;
    depth: number;
  },
): Promise<void> {
  const resource = `member:${p.member}`;
  // The HELD summon rides on the decision's pending_action — everything an approval needs to fire
  // exactly this summon later, without re-deriving it.
  const pending: PendingSummonAction = {
    kind: 'summon.initiate',
    member: p.member,
    cause_seq: p.causeSeq,
    intent: p.intent,
    root_actor: p.rootActor,
    root_is_human: p.rootIsHuman,
    depth: p.depth,
  };
  // Built through the one decision constructor (M-3) — the subject is the emitting agent, summoning
  // under its own mandate (`self`).
  const decision = await writeCoSignDecision(deps, {
    roomId: p.roomId,
    subject: ctx.actorId,
    requestedBy: ctx.actorId,
    subjectBasis: 'self',
    action: SUMMON_INITIATE_ACTION,
    resource,
    verdict: p.verdict,
    pendingAction: pending,
  });
  const decisionId = decision.event_type === 'decision' ? decision.payload.decision_id : '';

  if (p.verdict.required_signer) {
    await raiseDecisionInterrupts(deps, {
      roomId: p.roomId,
      subject: ctx.actorId,
      requiredSigner: p.verdict.required_signer,
      decisionId,
      action: SUMMON_INITIATE_ACTION,
    });
  }
  deps.log.info(
    {
      room_id: p.roomId,
      requested_by: ctx.actorId,
      member: p.member,
      decision_id: decisionId,
      required_signer: p.verdict.required_signer,
    },
    'summon paused for co-sign',
  );
}
