import { createHash } from 'node:crypto';
import { appendWritePerformed, type PendingWriteAction } from '../events.js';
import type { CommandDeps } from './context.js';

// ═══ THE OUTBOUND WRITE EXECUTOR (ADR-020) ════════════════════════════════════════════════════════════
//
// Called ONLY from signDecision step 8, on an APPROVED decision whose pending_action is a `write.perform`.
// The co-signature IS the authorisation, so this does NOT re-evaluate — it performs the exact co-signed
// content through the write backend and records the outcome as a `write.performed` event. Nothing here is
// reached without a human's approval (RT-005), and the resolution's single-use index (migration 020) means
// it runs at most once. It never throws into the sign flow: a backend failure is recorded, not propagated,
// so a failed post cannot roll back the approval that already happened.

export async function fireWrite(
  deps: CommandDeps,
  input: { roomId: string; decisionId: string; action: PendingWriteAction },
): Promise<void> {
  const { medium, target, body, body_hash } = input.action;

  const record = (backend: string, ref: string | null, ok: boolean, error: string | null) =>
    appendWritePerformed(deps.pool, input.roomId, 'system', {
      decision_id: input.decisionId,
      medium,
      target,
      backend,
      ref,
      ok,
      error,
    }).then((event) => deps.bus.publish(input.roomId, event));

  // INTEGRITY: the body must still hash to the commitment the co-signature was over. A body edited between
  // co-sign and fire is refused and recorded — the executor never sends content a human did not sign.
  const actual = createHash('sha256').update(body).digest('hex');
  if (actual !== body_hash) {
    deps.log.warn(
      { room_id: input.roomId, decision_id: input.decisionId },
      'write refused: co-signed body no longer matches its hash',
    );
    await record('none', null, false, 'rejected');
    return;
  }

  // No backend configured — record honestly, perform nothing (a deployment that has not wired a writer).
  if (!deps.writeBackend) {
    await record('none', null, false, 'not_configured');
    return;
  }

  try {
    const receipt = await deps.writeBackend.perform({
      medium,
      target,
      body,
      idempotencyKey: input.decisionId,
    });
    await record(receipt.backend, receipt.ref ?? null, receipt.ok, receipt.error ?? null);
  } catch (err) {
    // A backend that threw is an upstream failure, not a reason to unwind the approval. Record and move on.
    deps.log.warn(
      { room_id: input.roomId, decision_id: input.decisionId, err },
      'write backend threw — recorded as upstream_error',
    );
    await record(deps.writeBackend.backend, null, false, 'upstream_error');
  }
}
