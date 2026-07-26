import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { evaluate, loadMandates, type LoadedMandate } from '@playroom/fabric';
import { appendDecision } from '../events.js';
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

// Mandates are loaded once per process and cached, exactly like the adapter registry.
// Reloading per evaluation would put file I/O inside the §11 <10 ms budget for no gain:
// mandates are code (Bible §9.5) and change by deploy, not at runtime.
let cache: Map<string, LoadedMandate> | undefined;
function mandateFor(member: string): LoadedMandate | undefined {
  const loaded = (cache ??= loadMandates());
  return loaded.get(member);
}

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
  const t0 = performance.now();
  const mandate = mandateFor(input.subject);
  const verdict = evaluate(
    { type: input.action, resource: input.resource },
    input.subject,
    mandate,
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

  const event = await appendDecision(deps.pool, input.roomId, input.subject, {
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
