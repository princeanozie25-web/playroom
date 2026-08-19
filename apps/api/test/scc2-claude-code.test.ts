import { afterAll, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_SIGNER_NOT_HUMAN, type AgentAdapter, type AgentTurnChunk } from '@playroom/shared';
import {
  startTestServer,
  testPool,
  uniqueRoomId,
  httpCreateRoom,
  admitToRoom,
  type TestServer,
} from './support.js';
import { issueCredential } from '../src/credentials.js';
import { RoomBus } from '../src/bus.js';
import { executeCommand, type CommandDeps } from '../src/commands/index.js';

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
    await admitToRoom(roomId, 'claude-code');
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
    await admitToRoom(roomId, 'claude-code');
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
    await admitToRoom(roomId, 'claude-code');
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
    await admitToRoom(roomId, 'claude-code');
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
    await admitToRoom(roomId, 'claude-code');
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
    await admitToRoom(roomId, 'claude-code');
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

async function getDecision(
  server: TestServer,
  roomId: string,
  token: string,
  decisionId: string,
): Promise<Response> {
  return fetch(`${server.httpBase}/rooms/${roomId}/decisions/${decisionId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}
// A CommandDeps for driving the human sign directly — there is no agent-signing frame, and CC has no
// resolve endpoint, so a signature is dispatched at the command. The stub adapter is never called: a
// pr.merge approval has no executor (S2.6), and this decision is not a summon.
function makeDeps(): CommandDeps {
  const stub: AgentAdapter = { id: 'stub', async *stream(): AsyncGenerator<AgentTurnChunk> {} };
  const deps: CommandDeps = {
    pool,
    bus: new RoomBus(),
    log: { info() {}, warn() {}, error() {} },
    adapterFactory: () => stub,
    execute: (cx, cmd) => executeCommand(cx, cmd, deps),
  };
  return deps;
}

describe('SCC-2 Phase 3 — one real cycle: pull, work, post, ask, WAIT', () => {
  it('CC pulls a brief, does real workspace work, posts a closeout, asks — and STOPS at CO_SIGN until Prince signs', async () => {
    const server = await startTestServer();
    const roomId = room('scc2-cycle');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    await admitToRoom(roomId, 'claude-code');
    const codeToken = await cred('claude-code');
    await resetInterruptBudget('claude-code');
    const workspace = join(tmpdir(), `scc2-workspace-${Date.now()}`);
    const shape: Record<string, number> = {};
    try {
      // Prince pins the brief.
      expect(
        (
          await postMsg(server, roomId, server.token, {
            body: 'BRIEF: review PR #7, and if it is good, merge it.',
          })
        ).status,
      ).toBe(201);

      // 1. PULL — CC reads the room and finds its brief.
      const t0 = Date.now();
      const hist = await jsonBody(await getHistory(server, roomId, codeToken));
      const brief = (hist.events ?? [])
        .filter((e) => e.event_type === 'message')
        .map((e) => e.payload.body)
        .find((b) => typeof b === 'string' && b.includes('BRIEF'));
      expect(brief).toBeTruthy();
      shape.pull_ms = Date.now() - t0;

      // 2. WORK — a small piece of REAL work in CC's own workspace, OUTSIDE the fabric. A real file write
      //    stands in for CC editing files / running commands. It is UNGOVERNED (RT-005): nothing here
      //    traverses the evaluator. The point of the cycle is the ask-and-wait, not the work.
      const w0 = Date.now();
      writeFileSync(workspace, 'reviewed pr-7: LGTM\n', 'utf8');
      shape.work_ms = Date.now() - w0;

      // 3. POST — CC posts a closeout MESSAGE. A message is NOT a receipt: it proves nothing about what
      //    happened, and the log must not read it as governance.
      const p0 = Date.now();
      expect(
        (
          await postMsg(server, roomId, codeToken, {
            body: 'Reviewed PR #7 in my workspace — looks good. Requesting merge.',
          })
        ).status,
      ).toBe(201);
      shape.post_ms = Date.now() - p0;

      // 4. ASK — CC requests the protected action through the door.
      const a0 = Date.now();
      const ask = await jsonBody(
        await postAction(server, roomId, codeToken, {
          action: 'pr.merge',
          resource: 'repo:playroom/playroom#pr-7',
        }),
      );
      shape.ask_ms = Date.now() - a0;

      // 5. THE PROOF: CO_SIGN, and CC STOPS. It was refused PROGRESS by a named rule — asserted by the
      //    reason code, the signer, and the mandate hash, not by "a merge happened not to occur". There is
      //    nothing for CC to do but wait; it does not retry, route around, escalate, or proceed on timeout.
      expect(ask.decision).toBe('CO_SIGN');
      expect(ask.reason_code).toBe('PROTECTED_ACTION');
      expect(ask.required_signer).toBe('principal:prince');
      expect(ask.effective_mandate_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      const decId = ask.decision_id as string;
      expect(decId).toBeTruthy();

      // CC polls: PENDING. This is the wait, made observable.
      expect((await jsonBody(await getDecision(server, roomId, codeToken, decId))).status).toBe(
        'pending',
      );

      // And CC CANNOT resolve it itself — an agent may never sign (checked against member KIND).
      const cantSign = await executeCommand(
        { actorId: 'claude-code', mode: 'connected' },
        {
          kind: 'signDecision',
          roomId,
          clientMsgId: 'cc-self',
          decisionId: decId,
          resolution: 'APPROVED',
        },
        makeDeps(),
      );
      expect(cantSign.ok).toBe(false);
      if (!cantSign.ok) expect(cantSign.refusal.code).toBe(ERROR_SIGNER_NOT_HUMAN);

      // 6. PRINCE SIGNS (the human in the loop).
      const w1 = Date.now();
      const signed = await executeCommand(
        { actorId: 'prince', mode: 'human' },
        {
          kind: 'signDecision',
          roomId,
          clientMsgId: 'prince-sign',
          decisionId: decId,
          resolution: 'APPROVED',
        },
        makeDeps(),
      );
      expect(signed.ok).toBe(true);
      shape.wait_ms = Date.now() - w1;

      // CC polls again: RESOLVED, with the signer named — the fate learned by asking, never pushed.
      const done = await jsonBody(await getDecision(server, roomId, codeToken, decId));
      expect(done.status).toBe('resolved');
      expect(done.resolution).toBe('APPROVED');
      expect(done.signed_by).toBe('prince');

      // 7. THE WALL-CLOCK SHAPE of the cycle (ms), for the report.
      console.log(
        `[scc2-cycle] pull=${shape.pull_ms} work=${shape.work_ms} post=${shape.post_ms} ask=${shape.ask_ms} wait=${shape.wait_ms}`,
      );
    } finally {
      rmSync(workspace, { force: true });
      await new Promise((r) => setTimeout(r, 200));
      await server.close();
    }
  });
});
