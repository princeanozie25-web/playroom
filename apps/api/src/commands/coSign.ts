import { createHash, randomUUID } from 'node:crypto';
import { ERROR_INTERRUPT_BUDGET, type ServerEvent } from '@playroom/shared';
import type { Verdict } from '@playroom/fabric';
import { appendDecision, type PendingSummonAction } from '../events.js';
import { mandateFor } from '../mandates.js';
import { humanMembersOfPrincipal } from '../members.js';
import { raiseInterrupt } from '../interrupts.js';
import type { CommandDeps } from './context.js';

// Shared machinery for the two things that PAUSE for a co-signature: a pr.merge request
// (requestAction) and a protected summon emission (summon). Extracted so both produce the identical
// decision hash and the identical claim on a human's attention — one behaviour, one place to read it.

/** sha256 over the canonical arguments — the decision's `arguments_hash`. */
function argumentsHash(args: Record<string, unknown>): string {
  const canonical = JSON.stringify(args, Object.keys(args).sort());
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/**
 * THE ONE CONSTRUCTION SITE FOR A DECISION EVENT (M-3), and it takes a Verdict — so a decision cannot
 * be invented without an evaluation behind it. Both things that pause for a co-signature build their
 * payload and hand it here: requestAction (a pr.merge), and summon's pauseSummonForCoSign (a protected
 * summon, which passes a `pendingAction` carrying the held summon). The audit line, the reason code and
 * the mandate hash are therefore written in one readable place, and `appendDecision` has one caller.
 * Persists before it fans out (§12), and returns the event so the caller can raise its interrupt.
 */
export async function writeCoSignDecision(
  deps: CommandDeps,
  input: {
    roomId: string;
    subject: string; // the member whose mandate was evaluated
    requestedBy: string; // who asked — also the event's actor
    subjectBasis: string; // self | delegated_task | handoff
    action: string;
    resource: string;
    verdict: Verdict;
    pendingAction?: PendingSummonAction;
  },
): Promise<ServerEvent> {
  const decisionId = `dec_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const mandate = mandateFor(input.subject);
  const event = await appendDecision(deps.pool, input.roomId, input.requestedBy, {
    decision_id: decisionId,
    subject: input.subject,
    requested_by: input.requestedBy,
    subject_basis: input.subjectBasis,
    principal: mandate?.mandate.principal ?? 'unknown',
    action: input.action,
    resource: input.resource,
    arguments_hash: argumentsHash({ action: input.action, resource: input.resource }),
    decision: input.verdict.decision,
    reason_code: input.verdict.reason_code,
    required_signer: input.verdict.required_signer,
    effective_mandate_hash: input.verdict.effective_mandate_hash,
    policy_version: input.verdict.policy_version,
    pending_action: input.pendingAction,
  });
  deps.bus.publish(input.roomId, event); // §12 ordering law: persisted before it fans out.
  return event;
}

/**
 * A CO_SIGN IS AN INTERRUPT (Bible §12.1): "co-sign requests always arrive as an interrupt." Raise
 * one DECISION interrupt per human member of the required principal.
 *
 * WHO IS CHARGED: the SUBJECT, whose mandate needs the signature — the work is theirs, so the claim
 * their work makes on a person is theirs to fund, and it is what makes `interrupts_per_day` mean
 * something. WHO IS ADDRESSED: the human members of the required principal, one each — a principal is
 * not a person and may have several members, so resolving it here keeps the record member-addressed.
 *
 * A BUDGET REFUSAL DOES NOT UNDO THE DECISION. The evaluation happened and the card is real; what
 * fails is the notification, which is logged and left for the next raise. The uniqueness index on
 * interrupts keys on (room, kind, id, recipient), so a replayed co-sign claims a given human's
 * attention exactly once.
 */
export async function raiseDecisionInterrupts(
  deps: CommandDeps,
  input: {
    roomId: string;
    subject: string;
    requiredSigner: string;
    decisionId: string;
    action: string;
  },
): Promise<void> {
  for (const human of await humanMembersOfPrincipal(
    deps.pool,
    input.roomId,
    input.requiredSigner,
  )) {
    const raised = await raiseInterrupt(deps.pool, {
      roomId: input.roomId,
      urgency: 'DECISION',
      raisedBy: input.subject,
      addressedTo: human,
      aboutKind: 'decision',
      aboutId: input.decisionId,
      summary: `${input.action} needs a signature`,
    });
    if (!raised.ok) {
      deps.log.warn(
        {
          room_id: input.roomId,
          raised_by: input.subject,
          addressed_to: human,
          spent: raised.budget.spent,
          limit: raised.budget.limit,
          code: ERROR_INTERRUPT_BUDGET,
        },
        'interrupt refused: no budget left today',
      );
      continue;
    }
    if (raised.event) deps.bus.publish(input.roomId, raised.event);
    if (raised.halt) deps.bus.publish(input.roomId, raised.halt);
  }
}
