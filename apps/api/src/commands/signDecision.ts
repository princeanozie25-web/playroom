import {
  ERROR_DECISION_ALREADY_RESOLVED,
  ERROR_DECISION_EXPIRED,
  ERROR_DECISION_NOT_SIGNABLE,
  ERROR_DECISION_STALE,
  ERROR_DECISION_UNKNOWN,
  ERROR_SIGNER_NOT_HUMAN,
  ERROR_WRONG_SIGNER,
} from '@playroom/shared';
import {
  appendDecisionResolved,
  appendMessage,
  decisionEventById,
  decisionResolutionEvent,
} from '../events.js';
import { humanMembersOfPrincipal, memberRecord } from '../members.js';
import { mandateFor } from '../mandates.js';
import { decisionExpiryMs, isExpired } from '../decisions.js';
import { fireSummon } from './summon.js';
import type { CommandContext, CommandDeps } from './context.js';

// ============================================================================
// THE CO-SIGNATURE COMPLETES (S2.2) — the act the DECISION card was always missing.
//
// A CO_SIGN decision is a PENDING decision. This is a human ANSWERING it: approve or deny. The
// command authenticates the SIGNER (the socket's member — never a claim from the frame), refuses
// anyone who is not the human bound to the decision's required principal, and records the answer as
// a `decision.resolved` event. What an APPROVED decision then DOES — fire its held action — is S2.2's
// next commit; this one is the signing act, and its whole job is to let exactly the right person sign.
//
// ── AN AGENT MAY NEVER SIGN ──────────────────────────────────────────────────────────────────
//
// This is the load-bearing line of the entire slice, and it is here on purpose so a later
// "convenience" has to argue with it first. The co-signature is the human in the loop: the whole
// machine exists to put a PERSON between an agent and a consequence. There is therefore no path —
// test-only or otherwise — by which an agent member completes a decision. The check below is against
// what the socket AUTHENTICATED AS, not what any frame claims, and it refuses a non-human member
// before the principal is even consulted. Note that an agent and a human can share a principal
// (claude-main and prince both act for `principal:prince`), so a principal match ALONE would let an
// agent sign for itself — the human-kind check is what forbids that, and it must never be softened.
// ============================================================================

export type SignDecisionResult =
  { ok: true } | { ok: false; refusal: { code: string; message: string } };

export async function signDecisionCommand(
  deps: CommandDeps,
  ctx: CommandContext,
  input: {
    roomId: string;
    clientMsgId: string;
    decisionId: string;
    resolution: 'APPROVED' | 'DENIED';
  },
): Promise<SignDecisionResult> {
  const base = { room_id: input.roomId, decision_id: input.decisionId, member: ctx.actorId };
  const refuse = (code: string, message: string): SignDecisionResult => ({
    ok: false,
    refusal: { code, message },
  });

  // 1. The decision must exist and be one awaiting a signature.
  const event = await decisionEventById(deps.pool, input.roomId, input.decisionId);
  if (!event || event.event_type !== 'decision') {
    deps.log.warn({ ...base, code: ERROR_DECISION_UNKNOWN }, 'sign refused: no such decision');
    return refuse(ERROR_DECISION_UNKNOWN, 'there is no such decision to sign');
  }
  const d = event.payload;
  if (d.decision !== 'CO_SIGN' || !d.required_signer) {
    // A CO_SIGN with no required_signer is MISCONFIGURED — evaluate() always sets one — so it is
    // logged as an error, distinct from the ordinary "not a CO_SIGN" refusal (the misconfigured-vs-
    // refused distinction the standing rule asks for).
    if (d.decision === 'CO_SIGN' && !d.required_signer) {
      deps.log.error(
        { ...base },
        'sign refused: CO_SIGN decision names no required signer (misconfigured)',
      );
    } else {
      deps.log.warn(
        { ...base, decision: d.decision },
        'sign refused: decision is not awaiting a signature',
      );
    }
    return refuse(ERROR_DECISION_NOT_SIGNABLE, 'that decision is not awaiting a signature');
  }

  // 2. AN AGENT MAY NEVER SIGN (see the header). Checked against the authenticated member's KIND,
  //    before the principal, so a non-human is refused as such rather than as a wrong signer.
  const signer = await memberRecord(deps.pool, ctx.actorId);
  if (!signer || signer.kind !== 'human') {
    deps.log.warn({ ...base, code: ERROR_SIGNER_NOT_HUMAN }, 'sign refused: only a human may sign');
    return refuse(ERROR_SIGNER_NOT_HUMAN, 'only a human may complete a co-signature');
  }

  // 3. The signer must be a human member bound to the decision's required PRINCIPAL, in this room.
  //    This is the exact set the co-sign interrupt was addressed to — only those asked may answer.
  const eligible = await humanMembersOfPrincipal(deps.pool, input.roomId, d.required_signer);
  if (!eligible.includes(ctx.actorId)) {
    deps.log.warn(
      { ...base, required_signer: d.required_signer, code: ERROR_WRONG_SIGNER },
      'sign refused: wrong signer',
    );
    // Naming the required signer is not an oracle — the card already displays it.
    return refuse(
      ERROR_WRONG_SIGNER,
      `this decision needs a signature from ${d.required_signer}, not from you`,
    );
  }

  // 4. Not already resolved. Single-use is the DATABASE's guarantee (migration 020); this is the
  //    clean, early refusal for the common case, and step 7 catches a true race the index refuses.
  const existing = await decisionResolutionEvent(deps.pool, input.roomId, input.decisionId);
  if (existing) {
    deps.log.warn(
      { ...base, code: ERROR_DECISION_ALREADY_RESOLVED },
      'sign refused: already resolved',
    );
    return refuse(ERROR_DECISION_ALREADY_RESOLVED, 'that decision has already been answered');
  }

  // 5. Not expired. Nothing times out INTO a verdict (§15.3) — an expired card holds, and the action
  //    must be re-requested and re-evaluated rather than signed late.
  if (isExpired(event.ts, new Date(), decisionExpiryMs())) {
    deps.log.warn(
      { ...base, code: ERROR_DECISION_EXPIRED },
      'sign refused: co-sign window has passed',
    );
    return refuse(
      ERROR_DECISION_EXPIRED,
      'the time to sign this has passed — the action must be requested again',
    );
  }

  // 6. STALE CHECK — the cheap, honest slice of §9.4 the machine is unsafe without. The mandate the
  //    fabric evaluated must still be the subject's CURRENT mandate; a hash mismatch means the human
  //    would be endorsing authority that is not the authority that was ruled on. Refuse; re-request.
  const current = mandateFor(d.subject);
  if (!current || current.hash !== d.effective_mandate_hash) {
    deps.log.warn(
      { ...base, subject: d.subject, code: ERROR_DECISION_STALE },
      'sign refused: mandate changed since evaluation',
    );
    return refuse(
      ERROR_DECISION_STALE,
      'the mandate has changed since this was evaluated — request the action again',
    );
  }

  // 7. Record the answer. The resolution carries WHO signed, as WHICH principal — full attribution.
  let resolved;
  try {
    resolved = await appendDecisionResolved(deps.pool, input.roomId, ctx.actorId, {
      decision_id: input.decisionId,
      resolution: input.resolution,
      signed_by: ctx.actorId,
      signer_principal: d.required_signer,
    });
  } catch (err) {
    // A resolution raced past step 4 and lost the unique index (migration 020). That is single-use
    // working, not a failure — refuse as already-resolved rather than surfacing a database error.
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === '23505'
    ) {
      deps.log.warn(
        { ...base, code: ERROR_DECISION_ALREADY_RESOLVED },
        'sign refused: resolution raced',
      );
      return refuse(ERROR_DECISION_ALREADY_RESOLVED, 'that decision has already been answered');
    }
    throw err;
  }
  deps.bus.publish(input.roomId, resolved);
  deps.log.info(
    { ...base, resolution: input.resolution, signed_by: ctx.actorId, principal: d.required_signer },
    'decision resolved',
  );

  // 8. EXECUTE THE ANSWER (S2.2) — the ONLY place a co-signed action is released, and it runs at most
  //    once because the resolution above is single-use (migration 020). A DENIAL runs nothing and the
  //    room says so; an APPROVAL fires the held action, or records honestly that there is no executor.
  if (input.resolution === 'DENIED') {
    // No silent death, no automatic retry — the room states the denial, and the action must be
    // requested again if it is still wanted.
    const notice = await appendMessage(
      deps.pool,
      input.roomId,
      'system',
      `sys-denied-${input.decisionId}`,
      `${d.action} was denied and will not run.`,
    );
    deps.bus.publish(input.roomId, notice);
  } else if (d.pending_action?.kind === 'summon.initiate') {
    // APPROVED, and the decision holds an executable summon (S1.8). Fire it via fireSummon — NEVER
    // summonCommand — so it is not re-evaluated: the co-signature IS the authorisation. The emitting
    // agent is still the requester; the human approved it, they did not ask.
    const pa = d.pending_action;
    await fireSummon(deps, {
      roomId: input.roomId,
      member: pa.member,
      requestedBy: d.subject,
      rootActor: pa.root_actor,
      rootIsHuman: pa.root_is_human,
      depth: pa.depth,
      causeSeq: pa.cause_seq,
      intent: pa.intent,
    });
  } else {
    // APPROVED, but there is NO EXECUTOR — a pr.merge, whose bridge is S2.6 (RT-005). The room must
    // not imply a merge occurred, so it says exactly what happened and no more: approved, not run.
    const notice = await appendMessage(
      deps.pool,
      input.roomId,
      'system',
      `sys-approved-noexec-${input.decisionId}`,
      `${d.action} was approved. No executor exists yet, so nothing was performed (S2.6).`,
    );
    deps.bus.publish(input.roomId, notice);
  }
  return { ok: true };
}
