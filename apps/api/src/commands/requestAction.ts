import { performance } from 'node:perf_hooks';
import { evaluate, type Verdict } from '@playroom/fabric';
import { ERROR_SUBJECT_NOT_JUSTIFIED } from '@playroom/shared';
// The process-wide mandate cache, shared with the handoff and the turn stamp (S1.3). It used to
// live here as a module-local `let`, which meant every new reader grew its own.
import { mandateFor } from '../mandates.js';
import { listRoomMembers } from '../members.js';
import { subjectBasis } from '../tasks.js';
// The shared co-sign machinery (S2.2): the one decision constructor and the DECISION interrupt, so a
// pr.merge co-sign here and a protected-summon co-sign in commands/summon.ts are written one way.
import { raiseDecisionInterrupts, writeCoSignDecision } from './coSign.js';
import type { CommandContext, CommandDeps } from './context.js';

// ============================================================================
// THE ONLY PLACE A DECISION EVENT IS CONSTRUCTED.
//
// Every governed action traverses evaluate() here, and the decision event is written
// from its verdict — nowhere else in apps/api or packages/ builds one. That is the
// property `grep -rn "decision" apps/api/src packages/` is meant to demonstrate, and
// it is a property of the layout rather than a convention: `appendDecision` takes a
// Verdict, so a caller cannot invent a decision without first having evaluated one.
//
// Bible §8: no commitment-bearing action reaches an external system without traversing
// the fabric. Bible §9.2: every outcome is audited with the mandate hash.
// ============================================================================

/**
 * Evaluate a requested action and record the decision.
 *
 * NOTHING IS EXECUTED. There is no executor for `pr.merge` and none is needed — the
 * refusal happens before one exists, which is the architecture working rather than a
 * gap. On ALLOW the verdict is logged and the action is not performed; on CO_SIGN or
 * BLOCK a decision event is appended to the room log and fanned out, where the S-UI
 * card renders it.
 *
 * CO_SIGN PAUSES AND STAYS PAUSED. Completing a co-signature is S2.2; nothing here
 * resumes anything.
 */
export type RequestActionResult =
  // On success the caller learns the VERDICT and, when a decision event was written (CO_SIGN/BLOCK),
  // its id — so an out-of-process caller (the S2.1b door) can return the verdict and poll the decision.
  // ALLOW carries a null decisionId: A4-F1 rules it writes no event. Enriched fields; existing callers
  // (runAgentTurn, the ws request_action handler) read only `.ok` and are unaffected.
  | { ok: true; verdict: Verdict; decisionId: string | null }
  | { ok: false; refusal: { code: string; message: string } };

export async function requestActionCommand(
  deps: CommandDeps,
  ctx: CommandContext,
  input: { roomId: string; clientMsgId: string; subject: string; action: string; resource: string },
): Promise<RequestActionResult> {
  // ── THE SUBJECT MUST BE JUSTIFIED, NOT ASSERTED (S12-N2, closed) ──────────────────────
  //
  // Until S1.3 this field was the last claim on the wire. S1.2 deleted `author` and proved WHO
  // ASKED; `subject` still let any authenticated member name any other — or any string at all,
  // which is worse than the finding recorded: `decision.test.ts` has a passing case with
  // `nobody-in-particular` as the subject. The verdict was always sound for the subject it was
  // given, and the room still implied that member had asked.
  //
  // The fix is not a rule about names. It is a RECORD: a task the requester delegated to that
  // member, a handoff they performed to them, or the requester acting as themselves. That record
  // is what S13-1 and S13-2 exist to create, which is why the handoff was built first.
  //
  // CHECKED BEFORE THE EVALUATOR RUNS — standing before the request (RA-007). A caller with no
  // standing must not learn what another member's mandate contains, and asking whether Sol's
  // mandate admits an action is meaningless if the caller had no right to ask under it.
  const basis = await subjectBasis(deps.pool, input.roomId, ctx.actorId, input.subject);
  if (!basis) {
    deps.log.warn(
      {
        room_id: input.roomId,
        subject: input.subject,
        requested_by: ctx.actorId,
        action: input.action,
        code: ERROR_SUBJECT_NOT_JUSTIFIED,
      },
      'request refused: no record entitles this member to act for that subject',
    );
    // NO DECISION EVENT. The fabric evaluated nothing, because the room refused the ATTRIBUTION
    // — and a BLOCK card reading "requested under Sol's mandate" would repeat the claim being
    // rejected. The card either says something true or it does not appear.
    return {
      ok: false,
      refusal: {
        code: ERROR_SUBJECT_NOT_JUSTIFIED,
        message: `no record entitles ${ctx.actorId} to request under ${input.subject}'s mandate — delegate a task or hand one over first`,
      },
    };
  }

  // The room's roster, for the `counterparties` branch. Read BEFORE the timer starts: the
  // §11 budget is on the evaluation, which is pure and measured in microseconds, and folding
  // a database round trip into that number would make the budget meaningless.
  const roster = (await listRoomMembers(deps.pool, input.roomId)).map((m) => m.id);

  const t0 = performance.now();
  const mandate = mandateFor(input.subject);
  const verdict = evaluate(
    { type: input.action, resource: input.resource },
    input.subject,
    mandate,
    undefined,
    roster,
  );
  const durationMs = Number((performance.now() - t0).toFixed(3));

  // Bible §9.2 — EVERY outcome is audited with the mandate hash, whichever way it went.
  // A refusal is a warning (someone tried something they could not do); an ALLOW is
  // informational. Both are emitted; neither is optional.
  //
  // Called through `deps.log` rather than via an extracted method reference: pino's
  // methods are bound to the logger instance, so `const f = log.warn; f(...)` throws.
  const record = {
    room_id: input.roomId,
    subject: input.subject,
    requested_by: ctx.actorId,
    action: input.action,
    resource: input.resource,
    subject_basis: basis,
    decision: verdict.decision,
    reason_code: verdict.reason_code,
    mandate_hash: verdict.effective_mandate_hash,
    required_signer: verdict.required_signer,
    duration_ms: durationMs,
  };
  if (verdict.decision === 'ALLOW') deps.log.info(record, 'mandate evaluated');
  else deps.log.warn(record, 'mandate evaluated');

  // ALLOW is recorded in the log above and nothing else happens: there is no executor.
  // Deliberately NOT written as a decision event — the room log would fill with
  // approvals for actions that never ran, which reads as work having happened.
  if (verdict.decision === 'ALLOW') return { ok: true, verdict, decisionId: null };

  // THE EVENT'S ACTOR IS THE REQUESTER, NOT THE SUBJECT (the requester CAUSED it; the subject is
  // whose mandate was evaluated, recorded in the payload). Built through the shared constructor
  // (commands/coSign.ts) so a decision here and a protected-summon decision are written one way, in
  // one place — `writeCoSignDecision` takes the Verdict, so nothing can invent a decision (M-3).
  const event = await writeCoSignDecision(deps, {
    roomId: input.roomId,
    subject: input.subject,
    requestedBy: ctx.actorId,
    subjectBasis: basis,
    action: input.action,
    resource: input.resource,
    verdict,
  });

  // The decision event's id, so an out-of-process caller (the S2.1b door) can poll this decision later.
  // A decision event always exists here (the ALLOW branch returned above), so this is never null.
  const decisionId = event.event_type === 'decision' ? event.payload.decision_id : null;

  // ── A CO_SIGN IS AN INTERRUPT (Bible §12.1) ─────────────────────────────────────────
  //
  // "Co-sign requests always arrive as an interrupt." A decision awaiting a signature is a claim
  // on a specific person's attention by definition — so it goes through THE INTERRUPT RECORD
  // rather than a parallel notification concept. Two records for one fact would drift, and the
  // second one would be the one nobody budgeted.
  //
  // WHO IS CHARGED: the SUBJECT, whose mandate needs the signature. The work is theirs, so the
  // claim their work makes on a person is theirs to fund — and it is the answer that makes
  // `interrupts_per_day` mean something, since the subject is the member the limit belongs to.
  //
  // WHO IS ADDRESSED: the human members of the required PRINCIPAL, one interrupt each. A
  // principal is not a person and may have several members; resolving it here is what keeps the
  // record member-addressed without assuming one human sits behind it.
  //
  // A BUDGET REFUSAL DOES NOT UNDO THE DECISION. The evaluation happened, the card is real, and
  // the room shows it — what fails is the claim on someone's attention, which is logged and left
  // for the next raise. Rolling the decision back because a notification was too expensive would
  // be the tail wagging the dog.
  if (verdict.decision === 'CO_SIGN' && verdict.required_signer) {
    await raiseDecisionInterrupts(deps, {
      roomId: input.roomId,
      subject: input.subject,
      requiredSigner: verdict.required_signer,
      decisionId: event.event_type === 'decision' ? event.payload.decision_id : input.clientMsgId,
      action: input.action,
    });
  }

  return { ok: true, verdict, decisionId };
}
