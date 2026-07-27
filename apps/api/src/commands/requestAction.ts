import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { evaluate } from '@playroom/fabric';
// The process-wide mandate cache, shared with the handoff and the turn stamp (S1.3). It used to
// live here as a module-local `let`, which meant every new reader grew its own.
import { mandateFor } from '../mandates.js';
import { appendDecision } from '../events.js';
import { listRoomMembers } from '../members.js';
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

function argumentsHash(args: Record<string, unknown>): string {
  const canonical = JSON.stringify(args, Object.keys(args).sort());
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

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
export async function requestActionCommand(
  deps: CommandDeps,
  ctx: CommandContext,
  input: { roomId: string; clientMsgId: string; subject: string; action: string; resource: string },
): Promise<void> {
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
  if (verdict.decision === 'ALLOW') return;

  // THE EVENT'S ACTOR IS THE REQUESTER, NOT THE SUBJECT.
  //
  // It was the subject until S1.2, which was wrong in two ways. The actor of an event is who
  // CAUSED it, and a decision is caused by whoever asked — the subject is the member whose
  // mandate was evaluated, which is what the payload already records. And because `subject` is
  // still a claim from the frame, using it as the actor meant a caller could write an event
  // attributed to a name that is not a member at all: migration 010's constraint — every event
  // names a member or is the room speaking — could not hold while that was true.
  const event = await appendDecision(deps.pool, input.roomId, ctx.actorId, {
    decision_id: `dec_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    subject: input.subject,
    principal: mandate?.mandate.principal ?? 'unknown',
    action: input.action,
    resource: input.resource,
    arguments_hash: argumentsHash({ action: input.action, resource: input.resource }),
    decision: verdict.decision,
    reason_code: verdict.reason_code,
    required_signer: verdict.required_signer,
    effective_mandate_hash: verdict.effective_mandate_hash,
    policy_version: verdict.policy_version,
  });

  // §12 ordering law: persisted before it fans out.
  deps.bus.publish(input.roomId, event);
}
