import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { testPool, uniqueRoomId, startTestServer, type TestServer } from './support.js';
import {
  createRoom,
  admitMember,
  appendDecision,
  appendDecisionResolved,
  type DecisionPayload,
} from '../src/events.js';
import { chainCommitmentEvents, auditRoot, detachedReceiptForDecision } from '../src/audit.js';
import { issueCredential } from '../src/credentials.js';
import { verifyDetachedReceipt, type DetachedReceipt } from '@playroom/receipt';

/**
 * ═══ INDEPENDENT RECEIPT VERIFICATION — VERIFY IT YOURSELF, WITHOUT TRUSTING US (ADR-016) ═══════════
 *
 * A member exports a DETACHED receipt for a co-signed decision; anyone they give it to re-derives every hash
 * with the OPEN verifier (verifyDetachedReceipt) and needs no server. These prove the two agree on a genuine
 * receipt, that the gate holds (a non-member exports nothing), and the payoff: a server that serves a TAMPERED
 * payload with the real chain entry is caught by the verifier — the record does not rest on our word.
 */

const pool = testPool();
const rooms: string[] = [];
const creds: string[] = [];

async function commitmentRoom(
  creator = 'prince',
  inspections?: DecisionPayload['inspections'],
): Promise<{ roomId: string; decisionId: string }> {
  const roomId = uniqueRoomId('receipt');
  rooms.push(roomId);
  await createRoom(pool, roomId, roomId, creator);
  const decisionId = `dec_${roomId}`;
  const decision: DecisionPayload = {
    decision_id: decisionId,
    subject: 'claude-main',
    requested_by: creator,
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
    inspections,
  };
  await appendDecision(pool, roomId, creator, decision);
  await appendDecisionResolved(pool, roomId, creator, {
    decision_id: decisionId,
    resolution: 'APPROVED',
    signed_by: creator,
    signer_principal: 'principal:prince',
    inspections, // ADR-019: carried forward, as signDecision does, so the detached receipt exposes it
  });
  return { roomId, decisionId };
}

afterEach(async () => {
  await pool.query('DELETE FROM audit_chain');
  for (const r of rooms) {
    await pool.query('DELETE FROM events WHERE room_id = $1', [r]);
    await pool.query('DELETE FROM room_members WHERE room_id = $1', [r]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [r]);
  }
  rooms.length = 0;
  for (const id of creds) {
    await pool.query('DELETE FROM member_credentials WHERE id = $1', [id]);
  }
  creds.length = 0;
});

afterAll(async () => {
  await pool.end();
});

describe('independent receipt verification (ADR-016)', () => {
  it('a server-built receipt verifies with the OPEN verifier, and its root is the audit root', async () => {
    const { roomId, decisionId } = await commitmentRoom();
    await chainCommitmentEvents(pool);

    const receipt = await detachedReceiptForDecision(pool, decisionId, 'prince');
    expect(receipt).not.toBeNull();

    // The whole point: the OPEN verifier (no DB, no server) accepts what the server built.
    const v = verifyDetachedReceipt(receipt as DetachedReceipt);
    expect(v.ok).toBe(true);
    expect(v.checks).toEqual({ body: true, entry: true, chain: true, outcome: true });
    expect(v.outcome?.resolution).toBe('APPROVED');

    // And the root the receipt resolves to is the chain's real root — the value to compare out of band.
    expect(receipt!.root).toBe(await auditRoot(pool));
    expect(receipt!.decision_id).toBe(decisionId);
    expect(receipt!.resolution).toBe('APPROVED');
    expect(receipt!.meta.room_id).toBe(roomId);
  });

  it('ADR-019: the detached receipt exposes what was inspected, tamper-evidently and verifiably', async () => {
    const inspections = {
      inbound: { risk: 'elevated' as const, signals: ['instruction_override'], findings: 2 },
      egress: { risk: 'critical' as const, labels: ['canary token'], findings: 1 },
    };
    const { decisionId } = await commitmentRoom('prince', inspections);
    await chainCommitmentEvents(pool);

    const receipt = (await detachedReceiptForDecision(
      pool,
      decisionId,
      'prince',
    )) as DetachedReceipt;
    // The inspections ride in the receipt's source_payload — inside the hashed body, so the open verifier's
    // body check already covers them: a third party sees what the input tried and whether the output leaked.
    expect((receipt.source_payload as { inspections?: unknown }).inspections).toEqual(inspections);
    expect(verifyDetachedReceipt(receipt).ok).toBe(true);

    // Tamper the recorded inspection AFTER anchoring — flip the egress risk to hide a leak. The body no
    // longer hashes to the chain entry, and the open verifier refuses without asking us.
    await pool.query(
      `UPDATE events
          SET payload = jsonb_set(payload, '{inspections,egress,risk}', '"none"')
        WHERE event_type = 'decision.resolved' AND payload ->> 'decision_id' = $1`,
      [decisionId],
    );
    const tampered = (await detachedReceiptForDecision(
      pool,
      decisionId,
      'prince',
    )) as DetachedReceipt;
    const v = verifyDetachedReceipt(tampered);
    expect(v.ok).toBe(false);
    expect(v.checks.body).toBe(false);
  });

  it('a non-member exports nothing — a receipt is not a probe for which decisions exist', async () => {
    const { decisionId } = await commitmentRoom('prince');
    await chainCommitmentEvents(pool);
    expect(await detachedReceiptForDecision(pool, decisionId, 'someone-else')).toBeNull();
  });

  it('a resolution not yet anchored has no detached receipt (null until the chain has an entry)', async () => {
    const { decisionId } = await commitmentRoom();
    // No chainCommitmentEvents() call — nothing is anchored yet.
    expect(await detachedReceiptForDecision(pool, decisionId, 'prince')).toBeNull();
  });

  it('CATCHES A LYING SERVER — a tampered payload served with the real chain entry fails the open verifier', async () => {
    const { decisionId } = await commitmentRoom();
    await chainCommitmentEvents(pool);
    expect(
      verifyDetachedReceipt((await detachedReceiptForDecision(pool, decisionId, 'prince'))!).ok,
    ).toBe(true);

    // The server edits the source event AFTER anchoring but keeps the old chain entry (whose body_hash still
    // commits to the ORIGINAL payload). The re-exported receipt now carries the tampered payload — and the
    // open verifier re-hashes it and refuses, without ever asking the server whether it is honest.
    await pool.query(
      `UPDATE events SET payload = jsonb_set(payload, '{resolution}', '"DENIED"')
        WHERE event_type = 'decision.resolved' AND payload ->> 'decision_id' = $1`,
      [decisionId],
    );
    const tampered = await detachedReceiptForDecision(pool, decisionId, 'prince');
    const v = verifyDetachedReceipt(tampered as DetachedReceipt);
    expect(v.ok).toBe(false);
    expect(v.checks.body).toBe(false);
    expect(v.reason).toMatch(/body/i);
  });

  it('the HTTP door returns a verifiable receipt to a member and 404s a non-member', async () => {
    const server: TestServer = await startTestServer();
    try {
      const { roomId, decisionId } = await commitmentRoom('prince');
      await admitMember(pool, roomId, 'claude-code'); // a second member, with a credential
      await chainCommitmentEvents(pool);

      const memberCred = await issueCredential(pool, 'claude-code', 'receipt test');
      creds.push(memberCred.id);
      const res = await fetch(
        `${server.httpBase}/rooms/${roomId}/decisions/${decisionId}/receipt`,
        {
          headers: { authorization: `Bearer ${memberCred.token}` },
        },
      );
      expect(res.status).toBe(200);
      const receipt = (await res.json()) as DetachedReceipt;
      expect(verifyDetachedReceipt(receipt).ok).toBe(true);

      // A member of NO room asks for the same receipt — 404, indistinguishable from "unknown".
      const outsider = await issueCredential(pool, 'sol', 'outsider');
      creds.push(outsider.id);
      const denied = await fetch(
        `${server.httpBase}/rooms/${roomId}/decisions/${decisionId}/receipt`,
        { headers: { authorization: `Bearer ${outsider.token}` } },
      );
      expect(denied.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
