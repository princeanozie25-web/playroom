import { afterAll, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
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
  seq?: number;
  actor_id?: string;
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

async function getHistory(server: TestServer, roomId: string, token: string): Promise<Response> {
  return fetch(`${server.httpBase}/rooms/${roomId}/history`, {
    headers: { authorization: `Bearer ${token}` },
  });
}
async function postMsg(
  server: TestServer,
  roomId: string,
  token: string,
  bodyObj: unknown,
): Promise<Response> {
  return fetch(`${server.httpBase}/rooms/${roomId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(bodyObj),
  });
}
async function messageRows(roomId: string): Promise<{ actor_id: string; body: string }[]> {
  const { rows } = await pool.query<{ actor_id: string; body: string }>(
    "SELECT actor_id, payload ->> 'body' AS body FROM events WHERE room_id = $1 AND event_type = 'message' ORDER BY seq",
    [roomId],
  );
  return rows;
}
async function interruptCount(roomId: string, raisedBy: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM events WHERE room_id = $1 AND event_type = 'interrupt.raised' AND payload ->> 'raised_by' = $2",
    [roomId, raisedBy],
  );
  return Number(rows[0].n);
}
// The interrupt budget is GLOBAL per member per UTC day — reset today's count so a limit-binding test is
// deterministic regardless of other tests (a prior CO_SIGN in this file spends from the same budget).
async function resetInterruptBudget(memberId: string): Promise<void> {
  await pool.query(
    "DELETE FROM events WHERE event_type = 'interrupt.raised' AND payload ->> 'raised_by' = $1 AND ts >= date_trunc('day', now() AT TIME ZONE 'UTC')",
    [memberId],
  );
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

describe('SCC-2 Phase 2 — read and speak, and the interrupt', () => {
  it('a connected member READS the room transcript', async () => {
    const server = await startTestServer();
    const roomId = room('scc2-read');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    const codeToken = await cred('claude-code');
    try {
      // Prince pins a brief into the room; claude-code, a member, pulls it back through the read half.
      expect(
        (await postMsg(server, roomId, server.token, { body: 'BRIEF: review PR #1' })).status,
      ).toBe(201);
      const res = await getHistory(server, roomId, codeToken);
      expect(res.status).toBe(200);
      const bodies = ((await jsonBody(res)).events ?? [])
        .filter((e) => e.event_type === 'message')
        .map((e) => e.payload.body);
      expect(bodies).toContain('BRIEF: review PR #1');
    } finally {
      // Let postMessage's fire-and-forget summary maintenance settle before the pool closes.
      await new Promise((r) => setTimeout(r, 200));
      await server.close();
    }
  });

  it('a connected member SPEAKS, attributed to itself — the body cannot claim another author', async () => {
    const server = await startTestServer();
    const roomId = room('scc2-speak');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    const codeToken = await cred('claude-code');
    try {
      // The body tries to author as prince / claude-main. Both are ignored: the author is the CREDENTIAL's
      // member (claude-code), derived, never read from the wire — the same property the door has (D-2 is
      // rendered as "Claude Code (Prince)" at the surface; the record's actor_id is `claude-code`).
      const res = await postMsg(server, roomId, codeToken, {
        body: 'reviewed — one comment posted',
        author: 'prince',
        member: 'claude-main',
      });
      expect(res.status).toBe(201);
      expect((await jsonBody(res)).actor_id).toBe('claude-code');
      const mine = (await messageRows(roomId)).filter(
        (m) => m.body === 'reviewed — one comment posted',
      );
      expect(mine).toHaveLength(1);
      expect(mine[0].actor_id).toBe('claude-code'); // NOT prince, NOT claude-main
    } finally {
      // Let postMessage's fire-and-forget summary maintenance settle before the pool closes.
      await new Promise((r) => setTimeout(r, 200));
      await server.close();
    }
  });

  it('CC raises a DECISION interrupt via a protected request, and interrupts_per_day binds', async () => {
    const { lines, stream } = capture();
    const server = await startTestServer({ loggerStream: stream, logLevel: 'info' });
    const roomId = room('scc2-interrupt');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    const codeToken = await cred('claude-code');
    try {
      await resetInterruptBudget('claude-code');
      // interrupts_per_day is 6. Each protected request → CO_SIGN → one DECISION interrupt to Prince,
      // CHARGED TO claude-code. Seven requests: the first six interrupts land (CC CAN surface a decision);
      // the seventh is refused by budget. Every door response is still 200 CO_SIGN — a budget refusal
      // never undoes the decision.
      for (let i = 0; i < 7; i++) {
        const r = await jsonBody(
          await postAction(server, roomId, codeToken, {
            action: 'pr.merge',
            resource: `repo:x#${i}`,
          }),
        );
        expect(r.decision).toBe('CO_SIGN');
      }
      // THE LIMIT BINDS, by mechanism: exactly six interrupts landed, and the refusal names its reason.
      expect(await interruptCount(roomId, 'claude-code')).toBe(6);
      expect(lines.join('')).toContain('no budget left today');
      // FINDING SCC2-N1 (logged, not fixed): the ONLY interrupt CC can raise through the door is a DECISION
      // interrupt, as a side effect of a protected request. There is no door surface for a standalone
      // BLOCKER/FYI, so CC cannot surface a NON-decision concern ("blocked, need input") to Prince. The
      // loop can surface things that are decisions; it cannot yet raise a bare hand.
    } finally {
      await server.close();
    }
  });
});
