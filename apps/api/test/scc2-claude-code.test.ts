import { afterAll, describe, expect, it } from 'vitest';
import {
  startTestServer,
  testPool,
  uniqueRoomId,
  httpCreateRoom,
  type TestServer,
} from './support.js';
import { issueCredential } from '../src/credentials.js';

/**
 * ═══ SCC-2 — CLAUDE CODE THROUGH THE DOOR ═══
 *
 * claude-code is a CONNECTED member now: it authenticates through the S2.1b door with a member
 * credential, and its consequential asks are ruled on against the mandate Prince authored (transcribed
 * into mandates/claude-code.json). It edits files in its own workspace OUTSIDE the fabric — RT-005, still
 * open, not this slice's to close. What this slice proves is participation and requests: three verdicts
 * against the real mandate, read + speak, and one real cycle where CC asks before a protected action and
 * WAITS. ASSERT THE MECHANISM: the reason code, the mandate hash, and — for a wait — that CC was refused
 * progress by a named rule, not that progress happened not to occur.
 */

const pool = testPool();
const rooms: string[] = [];
const creds: string[] = [];
function room(prefix: string): string {
  const id = uniqueRoomId(prefix);
  rooms.push(id);
  return id;
}
async function cred(memberId: string): Promise<string> {
  const issued = await issueCredential(pool, memberId, 'scc2-test');
  creds.push(issued.id);
  return issued.token;
}

afterAll(async () => {
  for (const id of creds) await pool.query('DELETE FROM member_credentials WHERE id = $1', [id]);
  for (const id of rooms) {
    await pool.query('DELETE FROM events WHERE room_id = $1', [id]);
    await pool.query('DELETE FROM room_members WHERE room_id = $1', [id]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [id]);
  }
  await pool.end();
});

interface Body {
  decision?: string;
  reason_code?: string;
  effective_mandate_hash?: string | null;
  required_signer?: string | null;
  decision_id?: string | null;
  status?: string;
  resolution?: string | null;
  signed_by?: string | null;
  code?: string;
  events?: Array<{ event_type: string; actor_id: string; payload: Record<string, unknown> }>;
}
async function jsonBody(res: Response): Promise<Body> {
  return (await res.json()) as Body;
}
async function postAction(
  server: TestServer,
  roomId: string,
  token: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${server.httpBase}/rooms/${roomId}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe('SCC-2 Phase 1 — the mandate: three verdicts against the real claude-code document', () => {
  it('an in-scope action ALLOWS', async () => {
    const server = await startTestServer();
    const roomId = room('scc2-allow');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    const token = await cred('claude-code');
    try {
      const r = await jsonBody(
        await postAction(server, roomId, token, { action: 'pr.review', resource: 'repo:x#1' }),
      );
      expect(r.decision).toBe('ALLOW');
      expect(r.reason_code).toBe('ALLOWED_IN_SCOPE');
      expect(r.effective_mandate_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    } finally {
      await server.close();
    }
  });

  it('a protected action CO_SIGNS, with Prince named', async () => {
    const server = await startTestServer();
    const roomId = room('scc2-cosign');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    const token = await cred('claude-code');
    try {
      const r = await jsonBody(
        await postAction(server, roomId, token, { action: 'pr.merge', resource: 'repo:x#1' }),
      );
      expect(r.decision).toBe('CO_SIGN');
      expect(r.reason_code).toBe('PROTECTED_ACTION');
      expect(r.required_signer).toBe('principal:prince');
      expect(r.effective_mandate_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    } finally {
      await server.close();
    }
  });

  it('an unscoped action BLOCKS, deny-by-default', async () => {
    const server = await startTestServer();
    const roomId = room('scc2-block');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    const token = await cred('claude-code');
    try {
      const r = await jsonBody(
        await postAction(server, roomId, token, { action: 'secrets.read', resource: 'vault:x' }),
      );
      expect(r.decision).toBe('BLOCK');
      expect(r.reason_code).toBe('OUT_OF_SCOPE');
      expect(r.effective_mandate_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    } finally {
      await server.close();
    }
  });
});
