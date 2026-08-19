import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Mandate, signMandate } from '@playroom/fabric';
import { admitMember } from '../src/events.js';
import { resetMandateCache } from '../src/mandates.js';
import { issueCredential } from '../src/credentials.js';
import {
  testPool,
  uniqueRoomId,
  httpCreateRoom,
  startTestServer,
  type TestServer,
} from './support.js';

/**
 * ═══ C3 — AUTHORITY THAT DEPENDS ON HISTORY, THROUGH THE NODE DOOR (ADR-014) ═══
 *
 * The Drift rail: "Drift cannot open a PR until tests pass." A push to `main` is a `host_protected` grant
 * gated on `requires: [tests_passed]`. The node-op gate assembles the room's facts from the check log and
 * hands them to the pure evaluator, so the push reads CONDITION_UNMET until a passing `tests` check is
 * reported — then resolves to CO_SIGN. The fact is ESTABLISHED (a node reports it under its lease, recorded
 * with provenance), never claimed in the op body.
 */

const MANDATES_DIR = resolve(import.meta.dirname, '../../../mandates');
const pool = testPool();

// claude-code may push feature branches freely and run `npm test`; a push to `main` is protected AND
// conditional on the tests having passed.
const HOST_SCOPE = [
  { action: 'git.push', resource: 'refs/heads/feature/*' },
  { action: 'shell.exec', resource: 'npm test' },
];
const HOST_PROTECTED = [
  { action: 'git.push', resource: 'refs/heads/main', requires: ['tests_passed'] },
];

async function withHostMandate<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'playroom-c3-'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  for (const f of readdirSync(MANDATES_DIR).filter((f) => f.endsWith('.json'))) {
    const raw = JSON.parse(readFileSync(join(MANDATES_DIR, f), 'utf8'));
    delete raw.sig;
    if (raw.member === 'claude-code') {
      raw.host_scope = HOST_SCOPE;
      raw.host_protected = HOST_PROTECTED;
    }
    writeFileSync(
      join(dir, f),
      JSON.stringify({ ...raw, sig: signMandate(Mandate.parse(raw), priv) }),
    );
  }
  const prevDir = process.env.PLAYROOM_MANDATES_DIR;
  const prevPub = process.env.PLAYROOM_MANDATE_PUBKEY;
  process.env.PLAYROOM_MANDATES_DIR = dir;
  process.env.PLAYROOM_MANDATE_PUBKEY = pub;
  resetMandateCache();
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

const rooms: string[] = [];
const creds: string[] = [];

afterEach(async () => {
  for (const r of rooms) {
    await pool.query('DELETE FROM room_checks WHERE room_id = $1', [r]);
    await pool.query('DELETE FROM interrupts WHERE room_id = $1', [r]);
    await pool.query('DELETE FROM events WHERE room_id = $1', [r]);
    await pool.query('DELETE FROM room_members WHERE room_id = $1', [r]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [r]);
  }
  rooms.length = 0;
  for (const id of creds) {
    await pool.query('DELETE FROM leases WHERE credential_id = $1', [id]);
    await pool.query('DELETE FROM member_credentials WHERE id = $1', [id]);
  }
  creds.length = 0;
});

afterAll(async () => {
  await pool.end();
});

const auth = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });

async function setup(server: TestServer): Promise<{ roomId: string; lease: string; cred: string }> {
  const roomId = uniqueRoomId('c3');
  rooms.push(roomId);
  expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
  await admitMember(pool, roomId, 'claude-code');
  const issued = await issueCredential(pool, 'claude-code', 'c3 test');
  creds.push(issued.id);
  const res = await fetch(`${server.httpBase}/leases`, {
    method: 'POST',
    headers: auth(issued.token),
    body: JSON.stringify({ capabilities: ['git.', 'shell.exec'], workspace: 'c3' }),
  });
  expect(res.status).toBe(201);
  const { lease_token } = (await res.json()) as { lease_token: string };
  return { roomId, lease: lease_token, cred: issued.token };
}

function pushMain(server: TestServer, lease: string, roomId: string) {
  return fetch(`${server.httpBase}/rooms/${roomId}/node-ops`, {
    method: 'POST',
    headers: auth(lease),
    body: JSON.stringify({ action: 'git.push', resource: 'refs/heads/main' }),
  });
}

function reportCheck(
  server: TestServer,
  token: string,
  roomId: string,
  name: string,
  passed: boolean,
) {
  return fetch(`${server.httpBase}/rooms/${roomId}/checks`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ name, passed }),
  });
}

async function verdictOf(res: Response): Promise<{ decision: string; reason_code: string }> {
  expect(res.status).toBe(200);
  return (await res.json()) as { decision: string; reason_code: string };
}

describe('C3 — the Drift rail: no push to main until tests pass (ADR-014)', () => {
  it('a push to main is CONDITION_UNMET until a passing check is reported, then CO_SIGN', async () => {
    await withHostMandate(async () => {
      const server = await startTestServer();
      try {
        const { roomId, lease } = await setup(server);

        // Before any check: the fact tests_passed does not hold -> the gate refuses "not yet".
        expect(await verdictOf(await pushMain(server, lease, roomId))).toMatchObject({
          decision: 'BLOCK',
          reason_code: 'CONDITION_UNMET',
        });

        // The node runs the tests (a governed op, allowlisted) and REPORTS the result under its lease.
        expect((await reportCheck(server, lease, roomId, 'tests', true)).status).toBe(201);

        // Now the fact holds -> the push resolves to its underlying verdict: a protected ref, so CO_SIGN.
        expect(await verdictOf(await pushMain(server, lease, roomId))).toMatchObject({
          decision: 'CO_SIGN',
          reason_code: 'PROTECTED_ACTION',
        });
      } finally {
        await server.close();
      }
    });
  });

  it('a FAILING check does not open the gate, and the LATEST report wins', async () => {
    await withHostMandate(async () => {
      const server = await startTestServer();
      try {
        const { roomId, lease } = await setup(server);
        expect((await reportCheck(server, lease, roomId, 'tests', false)).status).toBe(201);
        expect(await verdictOf(await pushMain(server, lease, roomId))).toMatchObject({
          reason_code: 'CONDITION_UNMET',
        });

        // A later passing report flips the fact on...
        expect((await reportCheck(server, lease, roomId, 'tests', true)).status).toBe(201);
        expect(await verdictOf(await pushMain(server, lease, roomId))).toMatchObject({
          decision: 'CO_SIGN',
        });

        // ...and a still-later failing report flips it back off — a regression re-closes the gate.
        expect((await reportCheck(server, lease, roomId, 'tests', false)).status).toBe(201);
        expect(await verdictOf(await pushMain(server, lease, roomId))).toMatchObject({
          reason_code: 'CONDITION_UNMET',
        });
      } finally {
        await server.close();
      }
    });
  });

  it('only a live lease may report a check — a plain credential cannot fabricate a fact', async () => {
    await withHostMandate(async () => {
      const server = await startTestServer();
      try {
        const { roomId, cred } = await setup(server);
        const res = await reportCheck(server, cred, roomId, 'tests', true); // cred is a prm_, not a lease
        expect(res.status).toBe(401);
        expect(((await res.json()) as { code: string }).code).toBe('lease_required');
      } finally {
        await server.close();
      }
    });
  });

  it('a lease may not report a check into a room its member does not belong to (cross-room guard)', async () => {
    await withHostMandate(async () => {
      const server = await startTestServer();
      try {
        const { lease } = await setup(server); // lease's member is claude-code, a member of room A only

        // Room B exists, but claude-code is NOT admitted to it. A lease carries no room binding, so nothing
        // but the roster stops it reaching B's check log — this is that guard.
        const roomB = uniqueRoomId('c3-other');
        rooms.push(roomB);
        expect((await httpCreateRoom(server.httpBase, roomB, server.token)).status).toBe(201);

        // The live lease is refused at B's checks door — 404, the same room-not-found silence used elsewhere,
        // so a check-report is no membership oracle.
        expect((await reportCheck(server, lease, roomB, 'tests', true)).status).toBe(404);

        // And no fact was written into B — a gate B's own members wait on cannot be opened from outside.
        const { rows } = await pool.query('SELECT 1 FROM room_checks WHERE room_id = $1', [roomB]);
        expect(rows.length).toBe(0);
      } finally {
        await server.close();
      }
    });
  });
});
