import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { testPool, uniqueRoomId } from './support.js';
import {
  appendDecision,
  appendDecisionResolved,
  decisionEventById,
  decisionResolutionEvent,
  createRoom,
  type DecisionPayload,
} from '../src/events.js';
import { decisionStatus, decisionExpiryMs, isExpired } from '../src/decisions.js';

/**
 * ═══ S2.2 — THE DECISION HAS A LIFECYCLE, RECONSTRUCTED FROM THE LOG ═══
 *
 * A decision has no status column. Its status is a function of two events — the CO_SIGN decision and
 * its `decision.resolved` if one exists — plus the clock. This proves the two things that make that
 * safe: single-use is a DATABASE fact (a decision resolves at most once, or an approved action could
 * fire twice), and the four states are what the log already says, read the same way every time.
 */

const pool = testPool();
const rooms: string[] = [];

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  for (const room of rooms) {
    await pool.query('DELETE FROM events WHERE room_id = $1', [room]);
    await pool.query('DELETE FROM room_members WHERE room_id = $1', [room]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [room]);
  }
  rooms.length = 0;
});

/** A minimal CO_SIGN decision payload — the shape requestAction/summon write. */
function coSignPayload(decisionId: string): DecisionPayload {
  return {
    decision_id: decisionId,
    subject: 'claude-main',
    requested_by: 'claude-main',
    subject_basis: 'self',
    principal: 'principal:prince',
    action: 'pr.merge',
    resource: 'repo:playroom/playroom#pr-1',
    arguments_hash: 'sha256:test',
    decision: 'CO_SIGN',
    reason_code: 'PROTECTED_ACTION',
    required_signer: 'principal:prince',
    effective_mandate_hash: 'sha256:mandate',
    policy_version: 'playroom-policy/1.0',
  };
}

describe('single-use is a database fact (migration 020)', () => {
  it('refuses a SECOND resolution of one decision — an approved action cannot fire twice', async () => {
    const roomId = uniqueRoomId('lifecycle-once');
    rooms.push(roomId);
    await createRoom(pool, roomId, roomId, 'prince');
    const decisionId = 'dec_once_0001';
    await appendDecision(pool, roomId, 'claude-main', coSignPayload(decisionId));

    // First resolution lands.
    await appendDecisionResolved(pool, roomId, 'prince', {
      decision_id: decisionId,
      resolution: 'APPROVED',
      signed_by: 'prince',
      signer_principal: 'principal:prince',
    });

    // A second resolution — a double-click, a retried frame, a second instance — is refused by the
    // partial unique index, not by an in-process check. The INSERT throws (Postgres 23505).
    await expect(
      appendDecisionResolved(pool, roomId, 'prince', {
        decision_id: decisionId,
        resolution: 'DENIED',
        signed_by: 'prince',
        signer_principal: 'principal:prince',
      }),
    ).rejects.toThrow(/duplicate key|unique|23505|events_one_resolution_per_decision/i);

    // Exactly one resolution exists — the first — so the outcome is single and stable.
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM events WHERE room_id = $1 AND event_type = 'decision.resolved'`,
      [roomId],
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it('allows resolving TWO DIFFERENT decisions in one room — the key is the decision, not the room', async () => {
    const roomId = uniqueRoomId('lifecycle-two');
    rooms.push(roomId);
    await createRoom(pool, roomId, roomId, 'prince');
    await appendDecision(pool, roomId, 'claude-main', coSignPayload('dec_two_a'));
    await appendDecision(pool, roomId, 'claude-main', coSignPayload('dec_two_b'));

    await appendDecisionResolved(pool, roomId, 'prince', {
      decision_id: 'dec_two_a',
      resolution: 'APPROVED',
      signed_by: 'prince',
      signer_principal: 'principal:prince',
    });
    await appendDecisionResolved(pool, roomId, 'prince', {
      decision_id: 'dec_two_b',
      resolution: 'DENIED',
      signed_by: 'prince',
      signer_principal: 'principal:prince',
    });

    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM events WHERE room_id = $1 AND event_type = 'decision.resolved'`,
      [roomId],
    );
    expect(Number(rows[0].n)).toBe(2);
  });
});

describe('the status is reconstructed from the log', () => {
  it('reads APPROVED end to end from the decision and its resolution', async () => {
    const roomId = uniqueRoomId('lifecycle-approved');
    rooms.push(roomId);
    await createRoom(pool, roomId, roomId, 'prince');
    const decisionId = 'dec_appr_0001';
    const decision = await appendDecision(pool, roomId, 'claude-main', coSignPayload(decisionId));

    // Before a resolution: PENDING (well inside the window).
    const loaded = await decisionEventById(pool, roomId, decisionId);
    expect(loaded?.event_type).toBe('decision');
    const noRes = await decisionResolutionEvent(pool, roomId, decisionId);
    expect(noRes).toBeNull();
    expect(decisionStatus(decision.ts, null, new Date(decision.ts), decisionExpiryMs())).toBe(
      'PENDING',
    );

    // After: the resolution is in the log and the status derives to APPROVED.
    await appendDecisionResolved(pool, roomId, 'prince', {
      decision_id: decisionId,
      resolution: 'APPROVED',
      signed_by: 'prince',
      signer_principal: 'principal:prince',
    });
    const res = await decisionResolutionEvent(pool, roomId, decisionId);
    expect(res?.event_type).toBe('decision.resolved');
    const resolution =
      res?.event_type === 'decision.resolved' ? { resolution: res.payload.resolution } : null;
    expect(decisionStatus(decision.ts, resolution, new Date(), decisionExpiryMs())).toBe(
      'APPROVED',
    );
  });
});

describe('status derivation — the four states, and what cannot happen', () => {
  const now = new Date('2026-07-28T12:00:00.000Z');
  const window = 1000; // a 1-second window, for the test

  it('PENDING inside the window, EXPIRED past it, with NO resolution', () => {
    expect(decisionStatus('2026-07-28T11:59:59.500Z', null, now, window)).toBe('PENDING'); // 500ms ago
    expect(decisionStatus('2026-07-28T11:59:58.000Z', null, now, window)).toBe('EXPIRED'); // 2s ago
    expect(isExpired('2026-07-28T11:59:58.000Z', now, window)).toBe(true);
    expect(isExpired('2026-07-28T11:59:59.500Z', now, window)).toBe(false);
  });

  it('a resolution is TERMINAL — an approved or denied decision never becomes EXPIRED by sitting', () => {
    // Opened 2s ago (past the window), but RESOLVED — the resolution wins over the clock. This is the
    // §15.3 guarantee from the other side: time cannot un-resolve a decision any more than it can
    // resolve one.
    expect(
      decisionStatus('2026-07-28T11:59:58.000Z', { resolution: 'APPROVED' }, now, window),
    ).toBe('APPROVED');
    expect(decisionStatus('2026-07-28T11:59:58.000Z', { resolution: 'DENIED' }, now, window)).toBe(
      'DENIED',
    );
  });
});

describe('the expiry window is config with a loud malformed guard', () => {
  it('defaults when unset and refuses a malformed override rather than silently reverting', () => {
    const previous = process.env.PLAYROOM_DECISION_EXPIRY_MS;
    try {
      delete process.env.PLAYROOM_DECISION_EXPIRY_MS;
      expect(decisionExpiryMs()).toBe(24 * 60 * 60 * 1000);

      process.env.PLAYROOM_DECISION_EXPIRY_MS = '60000';
      expect(decisionExpiryMs()).toBe(60000);

      process.env.PLAYROOM_DECISION_EXPIRY_MS = 'soon';
      expect(() => decisionExpiryMs()).toThrow(/not a positive number/i);

      process.env.PLAYROOM_DECISION_EXPIRY_MS = '-5';
      expect(() => decisionExpiryMs()).toThrow(/not a positive number/i);
    } finally {
      if (previous === undefined) delete process.env.PLAYROOM_DECISION_EXPIRY_MS;
      else process.env.PLAYROOM_DECISION_EXPIRY_MS = previous;
    }
  });
});
