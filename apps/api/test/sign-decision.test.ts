import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentTurnChunk } from '@playroom/shared';
import {
  ERROR_DECISION_ALREADY_RESOLVED,
  ERROR_DECISION_EXPIRED,
  ERROR_DECISION_NOT_SIGNABLE,
  ERROR_DECISION_STALE,
  ERROR_DECISION_UNKNOWN,
  ERROR_SIGNER_NOT_HUMAN,
  ERROR_WRONG_SIGNER,
} from '@playroom/shared';
import { testPool, uniqueRoomId } from './support.js';
import { RoomBus } from '../src/bus.js';
import { appendDecision, createRoom, type DecisionPayload } from '../src/events.js';
import { executeCommand, type CommandDeps } from '../src/commands/index.js';
import { mandateFor } from '../src/mandates.js';

/**
 * ═══ S2.2 — THE SIGNING ACT: ONLY THE RIGHT HUMAN COMPLETES A CO-SIGNATURE ═══
 *
 * The command reads a CO_SIGN decision and lets exactly one party answer it: the human bound to the
 * decision's required principal. An agent can never sign — not even one that shares the principal. A
 * wrong signer is named the right one. A stale, expired, or already-answered decision is refused for
 * its own reason. This is tested against a directly-appended pr.merge CO_SIGN; the real emit → CO_SIGN
 * → approve → EXECUTE path is S2.2's next commit, on the internal summon.
 */

const pool = testPool();
const rooms: string[] = [];

// Never called — signing triggers no turn this commit — but CommandDeps requires it.
function stubAdapter(id: string): AgentAdapter {
  return {
    id,
    async *stream(): AsyncGenerator<AgentTurnChunk> {
      yield { kind: 'done', tokens_in: 0, tokens_out: 0, stop_reason: 'end_turn' };
    },
  };
}

let deps: CommandDeps;
beforeEach(() => {
  deps = {
    pool,
    bus: new RoomBus(),
    log: { info() {}, warn() {}, error() {} },
    adapterFactory: (id) => stubAdapter(id),
    execute: (ctx, command) => executeCommand(ctx, command, deps),
  };
});

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

// The real hash of claude-main's current mandate — a fresh CO_SIGN carries this, so the stale check
// passes on the happy path and a bogus hash trips it.
const currentClaudeHash = (): string => {
  const m = mandateFor('claude-main');
  if (!m) throw new Error('claude-main mandate not loaded');
  return m.hash;
};

/** A pr.merge CO_SIGN decision under claude-main's mandate, signer = principal:prince. */
function coSign(
  decisionId: string,
  opts?: { mandateHash?: string; decision?: string },
): DecisionPayload {
  return {
    decision_id: decisionId,
    subject: 'claude-main',
    requested_by: 'prince',
    subject_basis: 'self',
    principal: 'principal:prince',
    action: 'pr.merge',
    resource: 'repo:playroom/playroom#pr-1',
    arguments_hash: 'sha256:args',
    decision: opts?.decision ?? 'CO_SIGN',
    reason_code: 'PROTECTED_ACTION',
    required_signer: 'principal:prince',
    effective_mandate_hash: opts?.mandateHash ?? currentClaudeHash(),
    policy_version: 'playroom-policy/1.0',
  };
}

async function newRoomWithDecision(
  prefix: string,
  decisionId: string,
  opts?: { mandateHash?: string; decision?: string },
): Promise<string> {
  const roomId = uniqueRoomId(prefix);
  rooms.push(roomId);
  await createRoom(pool, roomId, roomId, 'prince');
  await appendDecision(pool, roomId, 'prince', coSign(decisionId, opts));
  return roomId;
}

async function sign(
  roomId: string,
  actorId: string,
  decisionId: string,
  resolution: 'APPROVED' | 'DENIED',
) {
  return executeCommand(
    { actorId, mode: actorId === 'claude-main' ? 'hosted' : 'human' },
    {
      kind: 'signDecision',
      roomId,
      clientMsgId: `sign-${decisionId}-${actorId}`,
      decisionId,
      resolution,
    },
    deps,
  );
}

async function resolutionsOf(roomId: string, decisionId: string) {
  const { rows } = await pool.query<{
    payload: { resolution: string; signed_by: string; signer_principal: string };
  }>(
    `SELECT payload FROM events
      WHERE room_id = $1 AND event_type = 'decision.resolved' AND payload ->> 'decision_id' = $2`,
    [roomId, decisionId],
  );
  return rows.map((r) => r.payload);
}

describe('the right human signs', () => {
  it('APPROVES a decision required of their principal, with full attribution', async () => {
    const roomId = await newRoomWithDecision('sign-ok', 'dec_ok_1');
    const result = await sign(roomId, 'prince', 'dec_ok_1', 'APPROVED');
    expect(result).toEqual({ ok: true });

    const res = await resolutionsOf(roomId, 'dec_ok_1');
    expect(res).toHaveLength(1);
    expect(res[0].resolution).toBe('APPROVED');
    expect(res[0].signed_by).toBe('prince');
    expect(res[0].signer_principal).toBe('principal:prince');
  });

  it('DENIES, recording the denial as the decision’s answer', async () => {
    const roomId = await newRoomWithDecision('sign-deny', 'dec_deny_1');
    const result = await sign(roomId, 'prince', 'dec_deny_1', 'DENIED');
    expect(result).toEqual({ ok: true });
    const res = await resolutionsOf(roomId, 'dec_deny_1');
    expect(res).toHaveLength(1);
    expect(res[0].resolution).toBe('DENIED');
  });
});

describe('an agent may never sign', () => {
  it('refuses claude-main — even though it SHARES the required principal (principal:prince)', async () => {
    const roomId = await newRoomWithDecision('sign-agent', 'dec_agent_1');
    // claude-main acts for principal:prince, the same principal the decision requires — a principal
    // match alone would let it sign for itself. The human-kind check is what forbids that.
    const result = await sign(roomId, 'claude-main', 'dec_agent_1', 'APPROVED');
    expect(result).toEqual({
      ok: false,
      refusal: { code: ERROR_SIGNER_NOT_HUMAN, message: expect.any(String) },
    });
    expect(await resolutionsOf(roomId, 'dec_agent_1')).toHaveLength(0);
  });
});

describe('a wrong human is refused, and named the right one', () => {
  it('refuses jerry (principal:jerry) and names principal:prince', async () => {
    const roomId = await newRoomWithDecision('sign-wrong', 'dec_wrong_1');
    const result = await sign(roomId, 'jerry', 'dec_wrong_1', 'APPROVED');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe(ERROR_WRONG_SIGNER);
      expect(result.refusal.message).toContain('principal:prince'); // the card shows it; not an oracle
    }
    expect(await resolutionsOf(roomId, 'dec_wrong_1')).toHaveLength(0);
  });
});

describe('the stale check', () => {
  it('refuses when the mandate hash no longer matches the subject’s current mandate', async () => {
    const roomId = await newRoomWithDecision('sign-stale', 'dec_stale_1', {
      mandateHash: 'sha256:a-mandate-that-was-since-changed',
    });
    const result = await sign(roomId, 'prince', 'dec_stale_1', 'APPROVED');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe(ERROR_DECISION_STALE);
    expect(await resolutionsOf(roomId, 'dec_stale_1')).toHaveLength(0);
  });
});

describe('single-use and expiry', () => {
  it('refuses a SECOND signature of one decision', async () => {
    const roomId = await newRoomWithDecision('sign-twice', 'dec_twice_1');
    expect(await sign(roomId, 'prince', 'dec_twice_1', 'APPROVED')).toEqual({ ok: true });
    const second = await sign(roomId, 'prince', 'dec_twice_1', 'DENIED');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.refusal.code).toBe(ERROR_DECISION_ALREADY_RESOLVED);
    expect(await resolutionsOf(roomId, 'dec_twice_1')).toHaveLength(1); // the first, unchanged
  });

  it('refuses an EXPIRED decision — nothing times out into a verdict; re-request', async () => {
    const roomId = await newRoomWithDecision('sign-expired', 'dec_exp_1');
    // Backdate the decision two days — past the 24h default window.
    await pool.query(
      `UPDATE events SET ts = now() - interval '2 days'
        WHERE room_id = $1 AND event_type = 'decision' AND payload ->> 'decision_id' = $2`,
      [roomId, 'dec_exp_1'],
    );
    const result = await sign(roomId, 'prince', 'dec_exp_1', 'APPROVED');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe(ERROR_DECISION_EXPIRED);
    expect(await resolutionsOf(roomId, 'dec_exp_1')).toHaveLength(0);
  });
});

describe('nothing else is signable', () => {
  it('refuses an unknown decision id', async () => {
    const roomId = uniqueRoomId('sign-unknown');
    rooms.push(roomId);
    await createRoom(pool, roomId, roomId, 'prince');
    const result = await sign(roomId, 'prince', 'dec_nope', 'APPROVED');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe(ERROR_DECISION_UNKNOWN);
  });

  it('refuses a decision that is not awaiting a signature (not a CO_SIGN)', async () => {
    const roomId = await newRoomWithDecision('sign-allow', 'dec_allow_1', { decision: 'ALLOW' });
    const result = await sign(roomId, 'prince', 'dec_allow_1', 'APPROVED');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe(ERROR_DECISION_NOT_SIGNABLE);
  });
});
