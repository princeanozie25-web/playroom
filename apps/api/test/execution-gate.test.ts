import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentAdapter, AgentTurnChunk } from '@playroom/shared';
import { Mandate, signMandate } from '@playroom/fabric';
import { admitMember, createRoom } from '../src/events.js';
import { executeCommand, type CommandDeps } from '../src/commands/index.js';
import { resetMandateCache } from '../src/mandates.js';
import { RoomBus } from '../src/bus.js';
import { testPool, uniqueRoomId } from './support.js';

/**
 * ═══ C1 — THE EXECUTION GATE, THROUGH THE GOVERNED REQUEST PATH ═══
 *
 * The pure decision table (tests/fabric/evaluate.test.ts) proves the gate's LOGIC. This proves its
 * REACH: a host op (`fs.*`/`git.*`/`shell.*`) travels the SAME `executeCommand` → `requestAction` →
 * `evaluate` gateway every abstract action does — the resource, inert until now, flows to the gate and
 * decides the verdict — and it still executes NOTHING (RT-005): an ALLOW writes no decision event and
 * runs no side effect. A Local Node (C2) is what would run the op on this ALLOW under a revocable lease.
 *
 * The shipped `claude-code.json` carries no host policy (activating it in prod is a re-sign step Prince
 * runs with the real key). Here it is granted host policy in a TEMP mandate dir, re-signed with a
 * throwaway key under `PLAYROOM_MANDATE_PUBKEY` — the same authentic-under-an-override discipline the
 * co-sign test uses — so authority still flows only from a signature, never from an edited file.
 */

const MANDATES_DIR = resolve(import.meta.dirname, '../../../mandates');
const pool = testPool();
const rooms: string[] = [];

// The host policy granted to claude-code for the duration — the shape Prince adds to the shipped mandate
// on re-sign: reads anywhere, writes confined to the workspace, feature pushes free, main protected, one
// allowlisted command. Everything else is BLOCK (fs/git) or CO_SIGN (shell).
const HOST_SCOPE = [
  { action: 'fs.read', resource: '**' },
  { action: 'fs.write', resource: 'workspace/**' },
  { action: 'git.push', resource: 'refs/heads/feature/*' },
  { action: 'shell.exec', resource: 'npm test' },
];
const HOST_PROTECTED = [{ action: 'git.push', resource: 'refs/heads/main' }];

async function withHostMandate<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'playroom-gate-'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  // A copy of every real mandate, re-signed with the throwaway key so the whole dir verifies under the
  // override; claude-code's copy also gains the host policy. The real mandates/ is never written.
  for (const f of readdirSync(MANDATES_DIR).filter((f) => f.endsWith('.json'))) {
    const raw = JSON.parse(readFileSync(join(MANDATES_DIR, f), 'utf8'));
    delete raw.sig; // drop the shipped signature; this copy is re-signed below with the test key
    if (raw.member === 'claude-code') {
      raw.host_scope = HOST_SCOPE;
      raw.host_protected = HOST_PROTECTED;
    }
    const sig = signMandate(Mandate.parse(raw), priv);
    writeFileSync(join(dir, f), JSON.stringify({ ...raw, sig }));
  }
  const prevDir = process.env.PLAYROOM_MANDATES_DIR;
  const prevPub = process.env.PLAYROOM_MANDATE_PUBKEY;
  process.env.PLAYROOM_MANDATES_DIR = dir;
  process.env.PLAYROOM_MANDATE_PUBKEY = pub;
  resetMandateCache(); // model the restart that a mandate change is (S2.2)
  try {
    return await fn();
  } finally {
    if (prevDir === undefined) delete process.env.PLAYROOM_MANDATES_DIR;
    else process.env.PLAYROOM_MANDATES_DIR = prevDir;
    if (prevPub === undefined) delete process.env.PLAYROOM_MANDATE_PUBKEY;
    else process.env.PLAYROOM_MANDATE_PUBKEY = prevPub;
    resetMandateCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

function inertAdapter(id: string): AgentAdapter {
  return {
    id,
    async *stream(): AsyncGenerator<AgentTurnChunk> {
      yield { kind: 'text_delta', text: 'x' };
      yield { kind: 'done', tokens_in: 1, tokens_out: 1, stop_reason: 'end_turn' };
    },
  };
}

function deps(): CommandDeps {
  const d: CommandDeps = {
    pool,
    bus: new RoomBus(),
    log: { info() {}, warn() {}, error() {} },
    adapterFactory: (id) => inertAdapter(id),
    execute: (ctx, command) => executeCommand(ctx, command, d),
  };
  return d;
}

/** Request a host op as claude-code (subject = self) through the real command gateway. */
function gate(roomId: string, action: string, resource: string) {
  return executeCommand(
    { actorId: 'claude-code', mode: 'connected' },
    {
      kind: 'requestAction',
      roomId,
      clientMsgId: `gate-${action}`,
      subject: 'claude-code',
      action,
      resource,
    },
    deps(),
  );
}

/** A room with claude-code admitted (its mandate is roster_only, so it must be a member to act). */
async function gateRoom(prefix: string): Promise<string> {
  const roomId = uniqueRoomId(prefix);
  rooms.push(roomId);
  await createRoom(pool, roomId, roomId, 'prince');
  await admitMember(pool, roomId, 'claude-code');
  return roomId;
}

afterEach(async () => {
  for (const r of rooms) {
    await pool.query('DELETE FROM interrupts WHERE room_id = $1', [r]);
    await pool.query('DELETE FROM events WHERE room_id = $1', [r]);
    await pool.query('DELETE FROM room_members WHERE room_id = $1', [r]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [r]);
  }
  rooms.length = 0;
});

afterAll(async () => {
  await pool.end();
});

describe('the execution gate, through the governed request path (C1)', () => {
  it('a write INSIDE the workspace is ALLOWed — and executes nothing, writing no decision event', async () => {
    await withHostMandate(async () => {
      const roomId = await gateRoom('gate-allow');
      const res = await gate(roomId, 'fs.write', 'workspace/src/foo.ts');
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('narrowing');
      expect(res.verdict.decision).toBe('ALLOW');
      expect(res.verdict.reason_code).toBe('ALLOWED_IN_SCOPE');
      // RT-005: an ALLOW records no decision event and runs no side effect — the fabric decided, nothing acted.
      expect(res.decisionId).toBeNull();
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM events WHERE room_id = $1 AND event_type = 'decision'`,
        [roomId],
      );
      expect(Number(rows[0].n)).toBe(0);
    });
  });

  it('a write OUTSIDE the workspace is BLOCKed as RESOURCE_OUT_OF_SCOPE — the resource is what refuses it', async () => {
    await withHostMandate(async () => {
      const roomId = await gateRoom('gate-confine');
      const res = await gate(roomId, 'fs.write', '/etc/passwd');
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('narrowing');
      expect(res.verdict.decision).toBe('BLOCK');
      expect(res.verdict.reason_code).toBe('RESOURCE_OUT_OF_SCOPE');
      // The SAME action type (fs.write) that was allowed above — only the resource differs. Proof the gate
      // matches the path, not merely the verb.
    });
  });

  it('a push to a protected ref (main) CO_SIGNs and names the principal — a decision awaits a human', async () => {
    await withHostMandate(async () => {
      const roomId = await gateRoom('gate-main');
      const res = await gate(roomId, 'git.push', 'refs/heads/main');
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('narrowing');
      expect(res.verdict.decision).toBe('CO_SIGN');
      expect(res.verdict.reason_code).toBe('PROTECTED_ACTION');
      expect(res.verdict.required_signer).toBe('principal:prince');
      expect(res.decisionId).toBeTruthy(); // a CO_SIGN writes a pollable decision
    });
  });

  it('a shell command off the allowlist CO_SIGNs (allowlist + co-sign the rest), never a raw shell', async () => {
    await withHostMandate(async () => {
      const roomId = await gateRoom('gate-shell');
      const res = await gate(roomId, 'shell.exec', 'rm -rf /');
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('narrowing');
      expect(res.verdict.decision).toBe('CO_SIGN');
      expect(res.verdict.reason_code).toBe('SHELL_NOT_ALLOWLISTED');
      expect(res.verdict.required_signer).toBe('principal:prince');
    });
  });

  it('an allowlisted command is ALLOWed', async () => {
    await withHostMandate(async () => {
      const roomId = await gateRoom('gate-npm');
      const res = await gate(roomId, 'shell.exec', 'npm test');
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('narrowing');
      expect(res.verdict.decision).toBe('ALLOW');
      expect(res.verdict.reason_code).toBe('ALLOWED_IN_SCOPE');
    });
  });

  it('a host op the mandate grants NOWHERE is BLOCKed OUT_OF_SCOPE — deny-by-default reaches host ops', async () => {
    await withHostMandate(async () => {
      const roomId = await gateRoom('gate-ungranted');
      const res = await gate(roomId, 'fs.delete', 'workspace/foo.ts');
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('narrowing');
      expect(res.verdict.decision).toBe('BLOCK');
      expect(res.verdict.reason_code).toBe('OUT_OF_SCOPE');
    });
  });

  it('the SHIPPED claude-code mandate grants no host op — the capability ships inert until a re-sign', async () => {
    // No withHostMandate here: the real mandates/ on disk, exactly as prod loads them. claude-code can
    // request-and-be-refused a host op, proving C1 changes nothing about production authority until Prince
    // adds host policy and re-signs. (A signed mandate is still required — the door already tests that.)
    const roomId = await gateRoom('gate-shipped');
    const res = await gate(roomId, 'fs.write', 'workspace/src/foo.ts');
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('narrowing');
    expect(res.verdict.decision).toBe('BLOCK');
    expect(res.verdict.reason_code).toBe('OUT_OF_SCOPE');
  });
});
