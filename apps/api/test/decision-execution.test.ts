import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentAdapter, AgentTurnChunk } from '@playroom/shared';
import { Mandate, signMandate } from '@playroom/fabric';
import { admitToRoom, testPool, uniqueRoomId } from './support.js';
import { RoomBus } from '../src/bus.js';
import { appendDecision, createRoom, type DecisionPayload } from '../src/events.js';
import { executeCommand, type CommandDeps } from '../src/commands/index.js';
import { resetMandateCache, mandateFor } from '../src/mandates.js';

/**
 * ═══ S2.2 — AN APPROVED CO-SIGN RELEASES ITS ACTION EXACTLY ONCE ═══
 *
 * The whole cycle on the one internal protected action there is — a summon. A DESIGNATED member's
 * summon.initiate is marked protected (a temp mandate dir; the shipped mandates are unchanged, so the
 * routine summon path and every S18 test are untouched). Then: the agent emits → CO_SIGN → PAUSE →
 * DECISION interrupt → a human approves → the summon FIRES → exactly one attributed turn. The
 * mechanism is asserted at every step: the pause writes no summon, the approval writes exactly one.
 *
 * Denied runs nothing and says so. And a pr.merge approval records the sign-off and executes NOTHING —
 * RT-005 holds: no ALLOW, and now no APPROVAL, causes any external side effect.
 */

const MANDATES_DIR = resolve(import.meta.dirname, '../../../mandates');
const pool = testPool();
const rooms: string[] = [];

function replyingAdapter(id: string): AgentAdapter {
  return {
    id,
    async *stream(): AsyncGenerator<AgentTurnChunk> {
      yield { kind: 'text_delta', text: 'on it' };
      yield { kind: 'done', tokens_in: 3, tokens_out: 2, stop_reason: 'end_turn' };
    },
  };
}

function deps(): CommandDeps {
  const d: CommandDeps = {
    pool,
    bus: new RoomBus(),
    log: { info() {}, warn() {}, error() {} },
    adapterFactory: (id) => replyingAdapter(id),
    execute: (ctx, command) => executeCommand(ctx, command, d),
  };
  return d;
}

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

/**
 * Run `fn` with claude-main's summon.initiate DESIGNATED protected — a temp mandate dir with just that
 * one edit. Models "an action a principal has marked protected" without shipping the change; a mandate
 * change is a restart (S2.2), which resetMandateCache stands in for.
 *
 * Post-S2.1 an authority change is a RE-SIGNING, not a text edit: the modified mandate is signed with a
 * throwaway keypair whose public half is pointed to via `PLAYROOM_MANDATE_PUBKEY` for the duration. So
 * the mandate the evaluator sees is authentic (it would otherwise be refused at §0 as a tampered
 * document), which is exactly the production shape of "a principal re-issued an authority" — not a
 * forgery. The other mandates are re-signed unchanged with the same key so they too verify.
 */
async function withProtectedSummon<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'playroom-cosign-'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  for (const f of readdirSync(MANDATES_DIR).filter((f) => f.endsWith('.json'))) {
    const raw = JSON.parse(readFileSync(join(MANDATES_DIR, f), 'utf8'));
    delete raw.sig; // drop the shipped signature; this edit is re-signed below with the test key
    if (raw.member === 'claude-main') {
      raw.protected_actions = [...raw.protected_actions, 'summon.initiate'];
      raw.co_sign.actions = [...raw.co_sign.actions, 'summon.initiate'];
    }
    const sig = signMandate(Mandate.parse(raw), priv);
    writeFileSync(join(dir, f), JSON.stringify({ ...raw, sig }));
  }
  const previousDir = process.env.PLAYROOM_MANDATES_DIR;
  const previousPub = process.env.PLAYROOM_MANDATE_PUBKEY;
  process.env.PLAYROOM_MANDATES_DIR = dir;
  process.env.PLAYROOM_MANDATE_PUBKEY = pub;
  resetMandateCache();
  try {
    return await fn();
  } finally {
    if (previousDir === undefined) delete process.env.PLAYROOM_MANDATES_DIR;
    else process.env.PLAYROOM_MANDATES_DIR = previousDir;
    if (previousPub === undefined) delete process.env.PLAYROOM_MANDATE_PUBKEY;
    else process.env.PLAYROOM_MANDATE_PUBKEY = previousPub;
    resetMandateCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 15000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

interface DecRow {
  decision_id: string;
  decision: string;
  subject: string;
  required_signer: string;
  action: string;
  pending_action?: { kind: string; member: string };
}
async function coSignDecisions(roomId: string): Promise<DecRow[]> {
  const { rows } = await pool.query<{ payload: DecRow }>(
    `SELECT payload FROM events
      WHERE room_id = $1 AND event_type = 'decision' AND payload ->> 'decision' = 'CO_SIGN'
      ORDER BY seq`,
    [roomId],
  );
  return rows.map((r) => r.payload);
}
interface SummonRow {
  member: string;
  requested_by: string;
  root_actor: string;
  depth: number;
  root_is_human: boolean;
}
async function summonsOf(roomId: string, member: string): Promise<SummonRow[]> {
  const { rows } = await pool.query<{
    payload: Omit<SummonRow, 'root_is_human'>;
    root_is_human: boolean;
  }>(
    `SELECT payload, root_is_human FROM events
      WHERE room_id = $1 AND event_type = 'summon' AND payload ->> 'member' = $2`,
    [roomId, member],
  );
  return rows.map((r) => ({ ...r.payload, root_is_human: r.root_is_human }));
}
async function turnsOf(roomId: string, adapterId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM events
      WHERE room_id = $1 AND event_type = 'agent.turn.completed' AND adapter_id = $2`,
    [roomId, adapterId],
  );
  return Number(rows[0].n);
}
async function interruptsToAbout(
  roomId: string,
  addressedTo: string,
  decisionId: string,
): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM interrupts
      WHERE room_id = $1 AND addressed_to = $2 AND about_kind = 'decision' AND about_id = $3`,
    [roomId, addressedTo, decisionId],
  );
  return Number(rows[0].n);
}
async function resolutionsOf(roomId: string, decisionId: string) {
  const { rows } = await pool.query<{ payload: { resolution: string; signed_by: string } }>(
    `SELECT payload FROM events
      WHERE room_id = $1 AND event_type = 'decision.resolved' AND payload ->> 'decision_id' = $2`,
    [roomId, decisionId],
  );
  return rows.map((r) => r.payload);
}
async function systemSays(roomId: string, needle: string): Promise<boolean> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM events
      WHERE room_id = $1 AND event_type = 'message' AND actor_id = 'system' AND payload ->> 'body' ILIKE $2`,
    [roomId, `%${needle}%`],
  );
  return Number(rows[0].n) > 0;
}

/** claude-main emits a protected summon of sol; returns the paused decision. */
async function emitProtectedSummon(d: CommandDeps, roomId: string, causeSeq = 1): Promise<DecRow> {
  await executeCommand(
    { actorId: 'claude-main', mode: 'hosted' },
    {
      kind: 'summon',
      roomId,
      member: 'sol',
      causeSeq,
      intent: 'claude-main summoned sol',
      chain: { rootActor: 'prince', rootIsHuman: true, depth: 0 },
    },
    d,
  );
  const decisions = await coSignDecisions(roomId);
  expect(decisions).toHaveLength(1);
  return decisions[0];
}

describe('the pause: a protected summon writes a decision and NO summon', () => {
  it('emits → CO_SIGN → pause → DECISION interrupt, with the held summon on the decision', async () => {
    await withProtectedSummon(async () => {
      const d = deps();
      const roomId = uniqueRoomId('exec-pause');
      rooms.push(roomId);
      await createRoom(pool, roomId, roomId, 'prince');
      // The summon targets sol, so sol must be in the room for it to resolve (and to fire on approval);
      // claude-main, the emitter, is admitted alongside (harmless). Creation enrols only prince now (ADR-009).
      await admitToRoom(roomId, 'claude-main', 'sol');

      const dec = await emitProtectedSummon(d, roomId);
      // The decision is a CO_SIGN of summon.initiate, under claude-main's mandate, needing prince.
      expect(dec.decision).toBe('CO_SIGN');
      expect(dec.subject).toBe('claude-main');
      expect(dec.action).toBe('summon.initiate');
      expect(dec.required_signer).toBe('principal:prince');
      // The held summon rides on the decision, so an approval can fire exactly it.
      expect(dec.pending_action?.kind).toBe('summon.initiate');
      expect(dec.pending_action?.member).toBe('sol');
      // NO summon of sol yet, and NO turn — the emission stopped at the pause.
      expect(await summonsOf(roomId, 'sol')).toHaveLength(0);
      expect(await turnsOf(roomId, 'sol')).toBe(0);
      // A DECISION interrupt was raised to the human signer.
      expect(await interruptsToAbout(roomId, 'prince', dec.decision_id)).toBe(1);
    });
  });
});

describe('the release: an approval fires the held summon exactly once', () => {
  it('prince approves → sol is summoned at depth 1, rooted in prince, and takes exactly one turn', async () => {
    await withProtectedSummon(async () => {
      const d = deps();
      const roomId = uniqueRoomId('exec-approve');
      rooms.push(roomId);
      await createRoom(pool, roomId, roomId, 'prince');
      await admitToRoom(roomId, 'claude-main', 'sol'); // the approved summon fires sol's turn — she must be here
      const dec = await emitProtectedSummon(d, roomId);

      // The human signs. THE ONLY thing that releases the held summon.
      const signed = await executeCommand(
        { actorId: 'prince', mode: 'human' },
        {
          kind: 'signDecision',
          roomId,
          clientMsgId: 'sign-1',
          decisionId: dec.decision_id,
          resolution: 'APPROVED',
        },
        d,
      );
      expect(signed).toEqual({ ok: true });

      // The summon fires: exactly one, requested by the EMITTING AGENT, rooted in the human, depth 1.
      await until(
        () => turnsOf(roomId, 'sol'),
        (n) => n >= 1,
      );
      const solSummons = await summonsOf(roomId, 'sol');
      expect(solSummons).toHaveLength(1);
      expect(solSummons[0].requested_by).toBe('claude-main');
      expect(solSummons[0].root_actor).toBe('prince');
      expect(solSummons[0].root_is_human).toBe(true);
      expect(solSummons[0].depth).toBe(1);
      // Exactly one turn — the release ran once (single-use guaranteed the resolution is unique).
      expect(await turnsOf(roomId, 'sol')).toBe(1);
      // And the decision is resolved APPROVED, signed by the human.
      const res = await resolutionsOf(roomId, dec.decision_id);
      expect(res).toHaveLength(1);
      expect(res[0].resolution).toBe('APPROVED');
      expect(res[0].signed_by).toBe('prince');
    });
  });
});

describe('denied: the action never runs, and the room says so', () => {
  it('prince denies → no summon, no turn, a denial notice, and no auto-retry', async () => {
    await withProtectedSummon(async () => {
      const d = deps();
      const roomId = uniqueRoomId('exec-deny');
      rooms.push(roomId);
      await createRoom(pool, roomId, roomId, 'prince');
      await admitToRoom(roomId, 'claude-main', 'sol'); // sol resolvable so the emission reaches the pause, not a not-in-room refusal
      const dec = await emitProtectedSummon(d, roomId);

      const signed = await executeCommand(
        { actorId: 'prince', mode: 'human' },
        {
          kind: 'signDecision',
          roomId,
          clientMsgId: 'deny-1',
          decisionId: dec.decision_id,
          resolution: 'DENIED',
        },
        d,
      );
      expect(signed).toEqual({ ok: true });
      await new Promise((r) => setTimeout(r, 300)); // let any (wrong) turn surface

      expect(await summonsOf(roomId, 'sol')).toHaveLength(0);
      expect(await turnsOf(roomId, 'sol')).toBe(0);
      expect(await systemSays(roomId, 'was denied and will not run')).toBe(true);
      // The resolution is DENIED — a real answer, single and terminal, not a silent death.
      const res = await resolutionsOf(roomId, dec.decision_id);
      expect(res).toHaveLength(1);
      expect(res[0].resolution).toBe('DENIED');
    });
  });
});

describe('RT-005 survives: a pr.merge approval records and executes NOTHING', () => {
  it('approves a pr.merge co-sign; nothing runs, and the room does not imply a merge occurred', async () => {
    const d = deps();
    const roomId = uniqueRoomId('exec-merge');
    rooms.push(roomId);
    await createRoom(pool, roomId, roomId, 'prince');
    // A pr.merge CO_SIGN carries NO pending_action — there is no executor. Written with claude-main's
    // real, current mandate hash so the stale check passes.
    const hash = mandateFor('claude-main')?.hash ?? 'sha256:x';
    const payload: DecisionPayload = {
      decision_id: 'dec_merge_1',
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
      effective_mandate_hash: hash,
      policy_version: 'playroom-policy/1.0',
    };
    await appendDecision(pool, roomId, 'prince', payload);

    const signed = await executeCommand(
      { actorId: 'prince', mode: 'human' },
      {
        kind: 'signDecision',
        roomId,
        clientMsgId: 'merge-1',
        decisionId: 'dec_merge_1',
        resolution: 'APPROVED',
      },
      d,
    );
    expect(signed).toEqual({ ok: true });

    // The approval is REAL — the resolution is recorded.
    expect(await resolutionsOf(roomId, 'dec_merge_1')).toHaveLength(1);
    // Nothing executed: no summon, no turn — a pr.merge has no executor until S2.6 (RT-005).
    expect(await summonsOf(roomId, 'sol')).toHaveLength(0);
    expect(await turnsOf(roomId, 'claude-main')).toBe(0);
    // The room says exactly what happened and no more — it must NOT imply a merge occurred.
    expect(await systemSays(roomId, 'No executor exists yet, so nothing was performed')).toBe(true);
    expect(await systemSays(roomId, 'merged')).toBe(false);
  });
});
