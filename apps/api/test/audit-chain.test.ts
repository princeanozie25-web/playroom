import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testPool, uniqueRoomId, startTestServer } from './support.js';
import {
  createRoom,
  appendDecision,
  appendDecisionResolved,
  type DecisionPayload,
} from '../src/events.js';
import { chainCommitmentEvents, verifyAuditChain, auditRoot } from '../src/audit.js';

// ═══ A3 — THE TAMPER-EVIDENT AUDIT CHAIN (S2.3, Bible §17) ═══
//
// The property, proven three ways it can be attacked: a chained commitment cannot be edited (its source
// hash stops matching), a chain row cannot be edited (its entry hash stops recomputing), and a row cannot be
// removed (the link to the next one breaks). The anchor runs OFF the co-sign write path, so these tests
// build commitments directly and then chain them.

const pool = testPool();
const rooms: string[] = [];

/** A room with one co-sign lifecycle: a `decision` and its `decision.resolved` — two commitment events. */
async function commitmentRoom(): Promise<{
  roomId: string;
  decisionSeq: number;
  resolvedSeq: number;
}> {
  const roomId = uniqueRoomId('audit');
  rooms.push(roomId);
  await createRoom(pool, roomId, roomId, 'prince');
  const decision: DecisionPayload = {
    decision_id: `dec_${roomId}`,
    subject: 'claude-main',
    requested_by: 'prince',
    subject_basis: 'self',
    principal: 'principal:prince',
    action: 'pr.merge',
    resource: 'repo:playroom/playroom#pr-1',
    arguments_hash: 'sha256:args',
    decision: 'CO_SIGN',
    reason_code: 'PROTECTED_ACTION',
    required_signer: 'principal:prince',
    effective_mandate_hash: 'sha256:mandate',
    policy_version: 'playroom-policy/1.0',
  };
  const d = await appendDecision(pool, roomId, 'prince', decision);
  const r = await appendDecisionResolved(pool, roomId, 'prince', {
    decision_id: decision.decision_id,
    resolution: 'APPROVED',
    signed_by: 'prince',
    signer_principal: 'principal:prince',
  });
  return { roomId, decisionSeq: d.seq, resolvedSeq: r.seq };
}

async function chainRowCount(roomId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    'SELECT count(*) AS n FROM audit_chain WHERE room_id = $1',
    [roomId],
  );
  return Number(rows[0].n);
}

beforeEach(async () => {
  await pool.query('DELETE FROM audit_chain'); // each test builds its chain from genesis
});

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

describe('the audit chain (S2.3 / A3)', () => {
  it('chains commitment events and verifies, with a non-empty root', async () => {
    const { roomId } = await commitmentRoom();
    const anchored = await chainCommitmentEvents(pool);
    expect(anchored.appended).toBeGreaterThanOrEqual(2);
    expect(anchored.root).toBeTruthy();
    expect(await chainRowCount(roomId)).toBe(2); // exactly the decision + its resolution
    const v = await verifyAuditChain(pool);
    expect(v.ok).toBe(true);
    expect(v.root).toBe(anchored.root);
    expect(await auditRoot(pool)).toBe(anchored.root);
  });

  it('is idempotent — a second anchor chains nothing new', async () => {
    await commitmentRoom();
    const first = await chainCommitmentEvents(pool);
    expect(first.appended).toBeGreaterThanOrEqual(2);
    const second = await chainCommitmentEvents(pool);
    expect(second.appended).toBe(0);
    expect(second.root).toBe(first.root); // same root, nothing moved
    expect((await verifyAuditChain(pool)).ok).toBe(true);
  });

  it('DETECTS a tampered source event — editing a chained commitment breaks verification', async () => {
    const { resolvedSeq } = await commitmentRoom();
    await chainCommitmentEvents(pool);
    expect((await verifyAuditChain(pool)).ok).toBe(true);
    // Flip the resolution APPROVED -> DENIED on the already-chained event.
    await pool.query(
      `UPDATE events SET payload = jsonb_set(payload, '{resolution}', '"DENIED"') WHERE seq = $1`,
      [resolvedSeq],
    );
    const v = await verifyAuditChain(pool);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/source event body/i);
  });

  it('DETECTS an edited chain row — a rewritten entry no longer recomputes', async () => {
    const { roomId } = await commitmentRoom();
    await chainCommitmentEvents(pool);
    await pool.query(
      `UPDATE audit_chain SET body_hash = 'sha256:forged' WHERE room_id = $1 AND event = 'decision.resolved'`,
      [roomId],
    );
    const v = await verifyAuditChain(pool);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/entry_hash does not recompute/i);
  });

  it('DETECTS a removed row — the link to the next entry breaks', async () => {
    const { roomId } = await commitmentRoom();
    await chainCommitmentEvents(pool);
    // Remove the FIRST of the two rows; the second's prev_hash now points at a link that is gone.
    await pool.query(
      `DELETE FROM audit_chain WHERE seq = (SELECT MIN(seq) FROM audit_chain WHERE room_id = $1)`,
      [roomId],
    );
    const v = await verifyAuditChain(pool);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/inserted or removed/i);
  });

  it('chains a commitment even when a HIGHER source_seq is already chained (no watermark hole)', async () => {
    // events.seq is BIGSERIAL — a lower seq can commit AFTER a higher one is chained. Simulate the state a
    // `seq > lastSource` cursor would strand: chain both, then remove the LOWER's chain row, leaving the
    // higher as the head. The anti-join must re-pick the stranded low seq; a high-watermark cursor would
    // look past it forever (appended 0). This is the A3-F1 regression.
    const { decisionSeq } = await commitmentRoom(); // decisionSeq < resolvedSeq
    await chainCommitmentEvents(pool);
    await pool.query('DELETE FROM audit_chain WHERE source_seq = $1', [decisionSeq]);
    const again = await chainCommitmentEvents(pool);
    expect(again.appended).toBe(1); // the stranded low-seq commitment is picked back up, not skipped
    const { rows } = await pool.query('SELECT 1 FROM audit_chain WHERE source_seq = $1', [
      decisionSeq,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('DETECTS a tampered source ENVELOPE — editing actor_id on a chained event breaks verification', async () => {
    const { resolvedSeq } = await commitmentRoom();
    await chainCommitmentEvents(pool);
    expect((await verifyAuditChain(pool)).ok).toBe(true);
    await pool.query(`UPDATE events SET actor_id = 'mallory' WHERE seq = $1`, [resolvedSeq]);
    const v = await verifyAuditChain(pool);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/envelope/i);
  });

  it('the in-process anchor chains a new commitment on its interval (no manual call)', async () => {
    // A server with a short anchor interval folds commitments in on its own — the pipeline that makes
    // get_receipt return real receipts in production without an external cron. Polled, not slept-on.
    const server = await startTestServer({ anchorIntervalMs: 100 });
    try {
      const { resolvedSeq } = await commitmentRoom();
      const deadline = Date.now() + 8000;
      let chained = 0;
      while (Date.now() < deadline) {
        const { rows } = await pool.query('SELECT 1 FROM audit_chain WHERE source_seq = $1', [
          resolvedSeq,
        ]);
        if (rows.length > 0) {
          chained = rows.length;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(chained).toBe(1); // the background anchor picked it up, no chainCommitmentEvents() call here
    } finally {
      await server.close();
    }
  });
});
