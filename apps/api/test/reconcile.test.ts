import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { testPool, uniqueRoomId } from './support.js';
import { createRoom, appendDecision, type DecisionPayload } from '../src/events.js';
import { chainCommitmentEvents, chainView, reconcileWith } from '../src/audit.js';

/**
 * ═══ KEEP THE SAME ROOM CONSISTENT ACROSS MACHINES (ADR-021) ══════════════════════════════════════════
 *
 * This machine anchors a tamper-evident chain (A3). `reconcileWith` compares OUR chain to another host's
 * exported view and answers: do we agree (in_sync), is one simply ahead (a fast-forward), or have we FORKED
 * (committed different history from a shared point)? These build a real chain and drive it through each answer.
 */

const pool = testPool();
const rooms: string[] = [];

function decision(id: string): DecisionPayload {
  return {
    decision_id: id,
    subject: 'claude-main',
    requested_by: 'prince',
    subject_basis: 'self',
    principal: 'principal:prince',
    action: 'pr.merge',
    resource: `repo:playroom/playroom#${id}`,
    arguments_hash: 'sha256:args',
    decision: 'CO_SIGN',
    reason_code: 'PROTECTED_ACTION',
    required_signer: 'principal:prince',
    effective_mandate_hash: 'sha256:mandate',
    policy_version: 'playroom-policy/1.0',
  };
}

/** Append `n` commitments in a fresh room and anchor them — leaving `n` entries in the chain. */
async function chainOf(n: number): Promise<void> {
  const roomId = uniqueRoomId('recon');
  rooms.push(roomId);
  await createRoom(pool, roomId, roomId, 'prince');
  for (let i = 0; i < n; i += 1) {
    await appendDecision(pool, roomId, 'prince', decision(`dec_${roomId}_${i}`));
  }
  await chainCommitmentEvents(pool);
}

afterEach(async () => {
  await pool.query('DELETE FROM audit_chain');
  for (const r of rooms) {
    await pool.query('DELETE FROM events WHERE room_id = $1', [r]);
    await pool.query('DELETE FROM room_members WHERE room_id = $1', [r]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [r]);
  }
  rooms.length = 0;
});

afterAll(async () => {
  await pool.end();
});

// The audit chain is GLOBAL — other suites in this shared test DB leave commitments that chainCommitmentEvents
// also anchors — so these assert reconcile SEMANTICS relative to whatever chainView returns (always ≥ the
// entries we appended), never an absolute length. That is exactly the property reconcile guarantees.
describe('reconcileWith — this machine against another host (ADR-021)', () => {
  it('our chain reconciles with an identical remote view as in_sync', async () => {
    await chainOf(3);
    const local = await chainView(pool);
    expect(local.length).toBeGreaterThanOrEqual(3);
    const r = await reconcileWith(pool, local);
    expect(r.status).toBe('in_sync');
    expect(r.commonRoot).toBe(local[local.length - 1].entry_hash);
    expect(r.localAhead).toBe(0);
    expect(r.remoteAhead).toBe(0);
  });

  it('a remote missing our latest entry is local_ahead (it can fast-forward to us)', async () => {
    await chainOf(3);
    const local = await chainView(pool);
    const r = await reconcileWith(pool, local.slice(0, -1)); // the remote is our prefix — one behind
    expect(r.status).toBe('local_ahead');
    expect(r.localAhead).toBe(1);
    expect(r.commonRoot).toBe(local[local.length - 2].entry_hash);
  });

  it('a remote with an entry we do not have is remote_ahead (we can fast-forward to it)', async () => {
    await chainOf(2);
    const local = await chainView(pool);
    const remote = [
      ...local,
      {
        seq: local.length,
        entry_hash: 'sha256:theirs-newer',
        prev_hash: local[local.length - 1].entry_hash,
      },
    ];
    const r = await reconcileWith(pool, remote);
    expect(r.status).toBe('remote_ahead');
    expect(r.remoteAhead).toBe(1);
  });

  it('a remote that committed different history from a shared point is FORKED, at the divergence', async () => {
    await chainOf(3);
    const local = await chainView(pool);
    // The remote agreed with us up to the second-to-last entry, then anchored something else — a real fork.
    const forkAt = local.length - 1;
    const remote = local.map((l, i) =>
      i === forkAt ? { ...l, entry_hash: 'sha256:their-fork' } : l,
    );
    const r = await reconcileWith(pool, remote);
    expect(r.status).toBe('forked');
    expect(r.forkIndex).toBe(forkAt);
    expect(r.commonRoot).toBe(local[forkAt - 1].entry_hash); // the last point both agreed on
  });
});
