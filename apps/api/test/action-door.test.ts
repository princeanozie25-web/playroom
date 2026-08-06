import { afterAll, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { ERROR_CREDENTIAL_INVALID, ERROR_CREDENTIAL_REQUIRED } from '@playroom/shared';
import {
  startTestServer,
  testPool,
  uniqueRoomId,
  httpCreateRoom,
  type TestServer,
} from './support.js';
import { issueCredential, revokeCredential } from '../src/credentials.js';

/**
 * ═══ S2.1b — THE AUTHENTICATED DOOR (Phase 1: the door, identity derived) ═══
 *
 * The first inbound path from outside the api. It authenticates a MEMBER and carries no authority of its
 * own: the credential resolves to a member, the member to a principal and mandate, and the request is
 * ruled on against THAT mandate. Identity is DERIVED, never claimed — the body says what it wants, never
 * who it is. Revocation and expiry refuse, distinguishably in the LOG (collapsed on the wire per the
 * credentials.ts ruling), and none of them resembles a mandate refusal. The door is throttled. Nothing
 * executes. ASSERT THE MECHANISM: the reason code, the mandate hash, and WHICH check refused.
 */

const pool = testPool();
const rooms: string[] = [];
const creds: string[] = [];
function room(prefix: string): string {
  const id = uniqueRoomId(prefix);
  rooms.push(id);
  return id;
}

// A synthetic test credential for a member. `revoked` revokes it; `expiredHoursAgo` back-dates its
// expiry so `authenticate` rejects it — both real product paths, driven with test-only rows.
async function cred(
  memberId: string,
  opts: { expiredHoursAgo?: number; revoked?: boolean } = {},
): Promise<string> {
  const issued = await issueCredential(pool, memberId, 's21b-door-test');
  creds.push(issued.id);
  if (opts.expiredHoursAgo) {
    await pool.query(
      "UPDATE member_credentials SET expires_at = now() - ($2::numeric * interval '1 hour') WHERE id = $1",
      [issued.id, opts.expiredHoursAgo],
    );
  }
  if (opts.revoked) await revokeCredential(pool, issued.id);
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

interface DoorBody {
  decision?: string;
  reason_code?: string;
  effective_mandate_hash?: string | null;
  required_signer?: string | null;
  decision_id?: string | null;
  code?: string;
  message?: string;
  status?: string;
  resolution?: string | null;
  signed_by?: string | null;
}
async function jsonBody(res: Response): Promise<DoorBody> {
  return (await res.json()) as DoorBody;
}
async function postAction(
  server: TestServer,
  roomId: string,
  token: string | undefined,
  body: unknown,
): Promise<Response> {
  return fetch(`${server.httpBase}/rooms/${roomId}/actions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

interface DecisionPayload {
  subject: string;
  action: string;
  decision: string;
  reason_code: string;
  required_signer: string | null;
  effective_mandate_hash: string | null;
}
async function decisionRows(roomId: string): Promise<DecisionPayload[]> {
  const { rows } = await pool.query<{ payload: DecisionPayload }>(
    "SELECT payload FROM events WHERE room_id = $1 AND event_type = 'decision' ORDER BY seq",
    [roomId],
  );
  return rows.map((r) => r.payload);
}
function capture(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  return {
    lines,
    stream: new Writable({
      write(chunk: Buffer, _e, cb) {
        lines.push(chunk.toString());
        cb();
      },
    }),
  };
}

describe('S2.1b Phase 1 — the door: authenticated ingress, identity derived', () => {
  it('a valid credential makes a governed request and receives a verdict', async () => {
    const server = await startTestServer();
    const roomId = room('s21b-ok');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    const token = await cred('claude-main');
    try {
      const res = await postAction(server, roomId, token, {
        action: 'secrets.read',
        resource: 'vault:prod/db',
      });
      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      // THE VERDICT travels the wire — the mechanism, not the outcome. secrets.read is out of scope.
      expect(body.decision).toBe('BLOCK');
      expect(body.reason_code).toBe('OUT_OF_SCOPE');
      expect(body.effective_mandate_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    } finally {
      await server.close();
    }
  });

  it('identity is DERIVED from the credential — a body naming a different member does not win', async () => {
    const server = await startTestServer();
    const roomId = room('s21b-derive');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    const token = await cred('claude-main');
    try {
      // The body tries to claim it is sol / jerry. Every one of those is ignored: the subject is the
      // CREDENTIAL's member (claude-main), looked up, never read from the wire.
      const res = await postAction(server, roomId, token, {
        action: 'pr.merge',
        resource: 'repo:playroom/playroom#pr-1',
        subject: 'sol',
        member: 'sol',
        principal: 'principal:jerry',
      });
      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(body.decision).toBe('CO_SIGN');
      // The signer is claude-main's principal (prince), NOT jerry's — the body could not choose it.
      expect(body.required_signer).toBe('principal:prince');
      const rows = await decisionRows(roomId);
      expect(rows).toHaveLength(1);
      expect(rows[0].subject).toBe('claude-main'); // NOT 'sol'
    } finally {
      await server.close();
    }
  });

  it('a revoked credential is refused immediately, and reaches no evaluator', async () => {
    const server = await startTestServer();
    const roomId = room('s21b-revoked');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    const token = await cred('claude-main', { revoked: true });
    try {
      const res = await postAction(server, roomId, token, {
        action: 'pr.review',
        resource: 'repo:playroom/playroom#pr-1',
      });
      expect(res.status).toBe(401);
      expect((await jsonBody(res)).code).toBe(ERROR_CREDENTIAL_INVALID);
      // AN AUTH FAILURE IS NOT A MANDATE REFUSAL: nothing reached the evaluator, so no decision exists.
      expect(await decisionRows(roomId)).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('unknown / expired / revoked collapse to one WIRE code but are distinct in the OPERATOR log; none is a mandate refusal', async () => {
    const { lines, stream } = capture();
    const server = await startTestServer({ loggerStream: stream, logLevel: 'info' });
    const roomId = room('s21b-distinct');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    const revoked = await cred('claude-main', { revoked: true });
    const expired = await cred('claude-main', { expiredHoursAgo: 1 });
    const unknown = `prm_${'0'.repeat(64)}`; // well-formed shape, matches no row
    try {
      const rRev = await postAction(server, roomId, revoked, {
        action: 'pr.review',
        resource: 'r',
      });
      const rExp = await postAction(server, roomId, expired, {
        action: 'pr.review',
        resource: 'r',
      });
      const rUnk = await postAction(server, roomId, unknown, {
        action: 'pr.review',
        resource: 'r',
      });
      const rMissing = await postAction(server, roomId, undefined, {
        action: 'pr.review',
        resource: 'r',
      });
      // WIRE: the three real-but-bad tokens all return the SAME code — no leak that a token was ever real.
      expect(rRev.status).toBe(401);
      expect((await jsonBody(rRev)).code).toBe(ERROR_CREDENTIAL_INVALID);
      expect(rExp.status).toBe(401);
      expect((await jsonBody(rExp)).code).toBe(ERROR_CREDENTIAL_INVALID);
      expect(rUnk.status).toBe(401);
      expect((await jsonBody(rUnk)).code).toBe(ERROR_CREDENTIAL_INVALID);
      // A MISSING credential is its own code — a client never wired, not a token that failed.
      expect(rMissing.status).toBe(401);
      expect((await jsonBody(rMissing)).code).toBe(ERROR_CREDENTIAL_REQUIRED);
      // LOG: the operator CAN tell them apart — the distinction the wire deliberately withholds.
      const raw = lines.join('');
      expect(raw).toContain('"reason":"revoked"');
      expect(raw).toContain('"reason":"expired"');
      expect(raw).toContain('"reason":"unknown"');
      expect(raw).toContain('"reason":"missing"');
      // NONE resembles a mandate refusal: all are 401s, and NO decision event was written by any of them.
      expect(await decisionRows(roomId)).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('the door is throttled per credential, at the configured limit', async () => {
    const server = await startTestServer({ actionRateMax: 3, actionRateWindowMs: 60_000 });
    const roomId = room('s21b-throttle');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    const token = await cred('claude-main');
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await postAction(server, roomId, token, {
          action: 'pr.review',
          resource: `r-${i}`,
        });
        statuses.push(r.status);
      }
      // The limit is 3 per window: the first three pass, the fourth and fifth are throttled — a 429,
      // which is an AUTH-layer refusal, never mistakable for a mandate BLOCK (a 200 with a verdict).
      expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
      expect(statuses[3]).toBe(429);
      expect(statuses[4]).toBe(429);
    } finally {
      await server.close();
    }
  });
});
