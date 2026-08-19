import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Mandate, signMandate } from '@playroom/fabric';
import { admitMember } from '../src/events.js';
import { resetMandateCache } from '../src/mandates.js';
import { issueCredential, revokeCredential } from '../src/credentials.js';
import { leaseAllows } from '../src/leases.js';
import {
  testPool,
  uniqueRoomId,
  httpCreateRoom,
  startTestServer,
  type TestServer,
} from './support.js';

/**
 * ═══ C2 — THE LOCAL NODE LEASE, THROUGH THE HTTP DOORS (ADR-013) ═══
 *
 * C1 makes a host op pass a policy check; C2 makes execution of that op require a live LEASE. This proves
 * the rail end to end over the real routes: a member issues a lease, the node runs host ops under it through
 * /rooms/:id/node-ops, and — the acceptance test — REVOKING the lease refuses the node's very next op
 * ("a revoked lease stops local work mid-flight"). Also proven: the heartbeat liveness (a stalled node's
 * lease dies, and a heartbeat revives it — reconnect), the per-lease capability scope (a lease narrower than
 * the mandate), the granting-credential cascade, and that only a host op on a lease reaches the door.
 *
 * claude-code is granted host policy in a TEMP mandate dir, re-signed under PLAYROOM_MANDATE_PUBKEY — the same
 * authentic-under-an-override discipline the co-sign and gate tests use.
 */

const MANDATES_DIR = resolve(import.meta.dirname, '../../../mandates');
const pool = testPool();

const HOST_SCOPE = [
  { action: 'fs.read', resource: '**' },
  { action: 'fs.write', resource: 'workspace/**' },
  { action: 'git.push', resource: 'refs/heads/feature/*' },
  { action: 'shell.exec', resource: 'npm test' },
];
const HOST_PROTECTED = [{ action: 'git.push', resource: 'refs/heads/main' }];

async function withHostMandate<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'playroom-node-'));
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

/** A claude-code credential (the node's owner) + a room it is admitted to. */
async function nodeSetup(
  server: TestServer,
  prefix: string,
): Promise<{ roomId: string; cred: string }> {
  const roomId = uniqueRoomId(prefix);
  rooms.push(roomId);
  expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
  await admitMember(pool, roomId, 'claude-code'); // roster_only — the node's member must be in the room
  const issued = await issueCredential(pool, 'claude-code', 'node lease test');
  creds.push(issued.id);
  return { roomId, cred: issued.token };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

/** For bodyless POSTs (revoke, heartbeat): no content-type, so the JSON parser is not invoked on an empty body. */
function authOnly(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function issueLeaseHttp(
  base: string,
  cred: string,
  capabilities: string[],
): Promise<{ lease_token: string; lease_id: string }> {
  const res = await fetch(`${base}/leases`, {
    method: 'POST',
    headers: bearer(cred),
    body: JSON.stringify({ capabilities, workspace: 'test' }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { lease_token: string; lease_id: string };
}

async function nodeOp(
  base: string,
  leaseToken: string,
  roomId: string,
  action: string,
  resource: string,
): Promise<Response> {
  return fetch(`${base}/rooms/${roomId}/node-ops`, {
    method: 'POST',
    headers: bearer(leaseToken),
    body: JSON.stringify({ action, resource }),
  });
}

describe('leaseAllows — the capability scope match (pure)', () => {
  it('an exact type, a namespace prefix, and the wildcard all match; nothing else does', () => {
    expect(leaseAllows(['shell.exec'], 'shell.exec')).toBe(true); // exact
    expect(leaseAllows(['fs.'], 'fs.write')).toBe(true); // prefix
    expect(leaseAllows(['fs.'], 'fs.read')).toBe(true);
    expect(leaseAllows(['*'], 'git.push')).toBe(true); // wildcard
    expect(leaseAllows(['fs.'], 'git.push')).toBe(false); // wrong namespace
    expect(leaseAllows(['shell.exec'], 'shell.execute')).toBe(false); // exact is exact, not a prefix
    expect(leaseAllows([], 'fs.write')).toBe(false); // empty grants nothing
  });
});

describe('C2 — the local node lease (ADR-013)', () => {
  it('a host op under a live lease is ALLOWed; the same op is refused after the lease is revoked', async () => {
    await withHostMandate(async () => {
      const server = await startTestServer();
      try {
        const { roomId, cred } = await nodeSetup(server, 'node-revoke');
        const { lease_token, lease_id } = await issueLeaseHttp(server.httpBase, cred, [
          'fs.',
          'git.',
        ]);

        // LIVE: a write in the workspace is ALLOWed through the node door.
        const before = await nodeOp(
          server.httpBase,
          lease_token,
          roomId,
          'fs.write',
          'workspace/a.ts',
        );
        expect(before.status).toBe(200);
        expect(((await before.json()) as { decision: string }).decision).toBe('ALLOW');

        // THE STOP CONTROL: the owner revokes the lease.
        const rev = await fetch(`${server.httpBase}/leases/${lease_id}/revoke`, {
          method: 'POST',
          headers: authOnly(cred),
        });
        expect(rev.status).toBe(200);
        expect(((await rev.json()) as { revoked: boolean }).revoked).toBe(true);

        // THE ACCEPTANCE TEST: the very next op — identical — is refused, before the gate ever runs.
        const after = await nodeOp(
          server.httpBase,
          lease_token,
          roomId,
          'fs.write',
          'workspace/a.ts',
        );
        expect(after.status).toBe(401);
        expect(((await after.json()) as { code: string }).code).toBe('lease_invalid');
      } finally {
        await server.close();
      }
    });
  });

  it('the gate still decides under a live lease — confinement, protection and shell all hold', async () => {
    await withHostMandate(async () => {
      const server = await startTestServer();
      try {
        const { roomId, cred } = await nodeSetup(server, 'node-gate');
        const { lease_token } = await issueLeaseHttp(server.httpBase, cred, [
          'fs.',
          'git.',
          'shell.exec',
        ]);
        const decide = async (action: string, resource: string) => {
          const r = await nodeOp(server.httpBase, lease_token, roomId, action, resource);
          expect(r.status).toBe(200);
          return (await r.json()) as { decision: string; reason_code: string };
        };
        expect(await decide('fs.write', 'workspace/x.ts')).toMatchObject({ decision: 'ALLOW' });
        expect(await decide('fs.write', '/etc/passwd')).toMatchObject({
          decision: 'BLOCK',
          reason_code: 'RESOURCE_OUT_OF_SCOPE',
        });
        expect(await decide('git.push', 'refs/heads/main')).toMatchObject({
          decision: 'CO_SIGN',
          reason_code: 'PROTECTED_ACTION',
        });
        expect(await decide('shell.exec', 'npm test')).toMatchObject({ decision: 'ALLOW' });
        expect(await decide('shell.exec', 'rm -rf /')).toMatchObject({
          decision: 'CO_SIGN',
          reason_code: 'SHELL_NOT_ALLOWLISTED',
        });
      } finally {
        await server.close();
      }
    });
  });

  it('the lease capability scope narrows the mandate — an fs-only lease cannot even propose shell', async () => {
    await withHostMandate(async () => {
      const server = await startTestServer();
      try {
        const { roomId, cred } = await nodeSetup(server, 'node-scope');
        const { lease_token } = await issueLeaseHttp(server.httpBase, cred, ['fs.']);
        // fs is allowed → reaches the gate → ALLOW.
        expect(
          (await nodeOp(server.httpBase, lease_token, roomId, 'fs.write', 'workspace/x.ts')).status,
        ).toBe(200);
        // shell is NOT in the lease → refused BEFORE the gate, even though npm test would have been allowed.
        const shell = await nodeOp(server.httpBase, lease_token, roomId, 'shell.exec', 'npm test');
        expect(shell.status).toBe(403);
        expect(((await shell.json()) as { code: string }).code).toBe('lease_out_of_scope');
      } finally {
        await server.close();
      }
    });
  });

  it('a stalled node loses its lease when the heartbeat lapses, and a heartbeat revives it (reconnect)', async () => {
    await withHostMandate(async () => {
      const server = await startTestServer();
      try {
        const { roomId, cred } = await nodeSetup(server, 'node-beat');
        const { lease_token, lease_id } = await issueLeaseHttp(server.httpBase, cred, ['fs.']);
        // Simulate a node that stopped pinging: force the heartbeat deadline into the past.
        await pool.query(
          `UPDATE leases SET heartbeat_deadline = now() - interval '1 minute' WHERE lease_id = $1`,
          [lease_id],
        );
        const stale = await nodeOp(
          server.httpBase,
          lease_token,
          roomId,
          'fs.write',
          'workspace/x.ts',
        );
        expect(stale.status).toBe(401); // not live — the deadline lapsed

        // The node reconnects and heartbeats → the lease revives (still within absolute expiry, not revoked).
        const beat = await fetch(`${server.httpBase}/leases/heartbeat`, {
          method: 'POST',
          headers: authOnly(lease_token),
        });
        expect(beat.status).toBe(200);
        const revived = await nodeOp(
          server.httpBase,
          lease_token,
          roomId,
          'fs.write',
          'workspace/x.ts',
        );
        expect(revived.status).toBe(200);
      } finally {
        await server.close();
      }
    });
  });

  it('revoking the granting credential cascades to the lease — the node stops too', async () => {
    await withHostMandate(async () => {
      const server = await startTestServer();
      try {
        const { roomId, cred } = await nodeSetup(server, 'node-cascade');
        const { lease_token } = await issueLeaseHttp(server.httpBase, cred, ['fs.']);
        expect(
          (await nodeOp(server.httpBase, lease_token, roomId, 'fs.write', 'workspace/x.ts')).status,
        ).toBe(200);
        // A second live credential for the SAME member, to observe the listing after the first is revoked.
        const observer = await issueCredential(pool, 'claude-code', 'node cascade observer');
        creds.push(observer.id);
        // Revoke the credential the lease was issued under (the operator's response to a leaked credential).
        await revokeCredential(pool, creds[0]);

        // The node's next op stops — the true gate.
        const after = await nodeOp(
          server.httpBase,
          lease_token,
          roomId,
          'fs.write',
          'workspace/x.ts',
        );
        expect(after.status).toBe(401);
        expect(((await after.json()) as { code: string }).code).toBe('lease_invalid');

        // And the two INFORMATIONAL surfaces agree — no lying "still live" signal after the cascade:
        // a heartbeat is refused, and the owner's listing shows the lease dead.
        const beat = await fetch(`${server.httpBase}/leases/heartbeat`, {
          method: 'POST',
          headers: authOnly(lease_token),
        });
        expect(beat.status).toBe(401);
        const list = await fetch(`${server.httpBase}/leases`, {
          headers: authOnly(observer.token),
        });
        expect(list.status).toBe(200);
        const { leases } = (await list.json()) as { leases: Array<{ live: boolean }> };
        expect(leases.every((l) => l.live === false)).toBe(true);
      } finally {
        await server.close();
      }
    });
  });

  it('the node door is for host ops only, and only with a lease', async () => {
    await withHostMandate(async () => {
      const server = await startTestServer();
      try {
        const { roomId, cred } = await nodeSetup(server, 'node-guard');
        const { lease_token } = await issueLeaseHttp(server.httpBase, cred, ['fs.', 'git.']);
        // An abstract action does not belong on this door.
        const abstract = await nodeOp(server.httpBase, lease_token, roomId, 'pr.merge', 'repo:x#1');
        expect(abstract.status).toBe(422);
        expect(((await abstract.json()) as { code: string }).code).toBe('not_a_host_op');
        // A plain credential (not a lease) cannot open the node door.
        const notLease = await nodeOp(server.httpBase, cred, roomId, 'fs.write', 'workspace/x.ts');
        expect(notLease.status).toBe(401);
        expect(((await notLease.json()) as { code: string }).code).toBe('lease_required');
      } finally {
        await server.close();
      }
    });
  });
});
