import { afterAll, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AgentAdapter, AgentTurnChunk } from '@playroom/shared';
import {
  startTestServer,
  testPool,
  uniqueRoomId,
  httpCreateRoom,
  type TestServer,
} from './support.js';
import { issueCredential } from '../src/credentials.js';
import { executeCommand, type CommandDeps } from '../src/commands/index.js';
import { RoomBus } from '../src/bus.js';
import { DECISION_POLL_HINT_MS } from '../src/decisions.js';

/**
 * ═══ SCC-3 — THE RAISED HAND AND THE WAIT ═══
 *
 * SCC-2 found the loop's two honest limits. SCC2-N1: claude-code could ESCALATE a decision (ask for a
 * protected action) but could not raise a BARE HAND — the only route to Prince's attention ran through
 * requesting something consequential. SCC2-N2: a wait had no notification and no guidance. This slice
 * closes both.
 *
 * THE ANTI-GOAL, ASSERTED, not asserted-around: a raised hand is NOT a decision. It mints no decision
 * event, it cannot be resolved by a signature, and it is a DIFFERENT FACT in the log — about_kind
 * 'hand', never 'decision'. ASSERT THE MECHANISM: which rule refused, by reason code; that the decision
 * table is untouched; that the budget bound it. Never "a decision happened not to be created".
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
  const issued = await issueCredential(pool, memberId, 'scc3-test');
  creds.push(issued.id);
  return issued.token;
}

afterAll(async () => {
  for (const id of creds) await pool.query('DELETE FROM member_credentials WHERE id = $1', [id]);
  for (const id of rooms) {
    await pool.query('DELETE FROM interrupts WHERE room_id = $1', [id]);
    await pool.query('DELETE FROM events WHERE room_id = $1', [id]);
    await pool.query('DELETE FROM room_members WHERE room_id = $1', [id]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [id]);
  }
  await pool.end();
});

interface HandBody {
  raised?: boolean;
  interrupts?: Array<{
    interrupt_id: string;
    addressed_to: string;
    budget_remaining: number | null;
  }>;
  code?: string;
  message?: string;
  budget?: { limit: number | null; spent: number; remaining: number | null };
}
async function postHand(
  server: TestServer,
  roomId: string,
  token: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${server.httpBase}/rooms/${roomId}/interrupts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}
async function handBody(res: Response): Promise<HandBody> {
  return (await res.json()) as HandBody;
}

/** Every interrupt.raised event this member raised in this room, newest facts folded into a row view. */
async function raisedEvents(
  roomId: string,
  raisedBy: string,
): Promise<
  Array<{
    urgency: string;
    about_kind: string;
    about_id: string;
    addressed_to: string;
    summary: string;
    budget_remaining: number | null;
  }>
> {
  const { rows } = await pool.query<{
    urgency: string;
    about_kind: string;
    about_id: string;
    addressed_to: string;
    summary: string;
    budget_remaining: number | null;
  }>(
    `SELECT payload ->> 'urgency' AS urgency,
            payload ->> 'about_kind' AS about_kind,
            payload ->> 'about_id' AS about_id,
            payload ->> 'addressed_to' AS addressed_to,
            payload ->> 'summary' AS summary,
            (payload ->> 'budget_remaining')::int AS budget_remaining
       FROM events
      WHERE room_id = $1 AND event_type = 'interrupt.raised' AND payload ->> 'raised_by' = $2
      ORDER BY seq`,
    [roomId, raisedBy],
  );
  return rows;
}
/** Count of DECISION events in a room — the table a raised hand must never touch. */
async function decisionEventCount(roomId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM events WHERE room_id = $1 AND event_type = 'decision'",
    [roomId],
  );
  return Number(rows[0].n);
}
// The interrupt budget is GLOBAL per member per UTC day; clear today's raises so a limit-binding test is
// deterministic regardless of what else spent from claude-code's budget today.
async function resetInterruptBudget(memberId: string): Promise<void> {
  await pool.query(
    "DELETE FROM events WHERE event_type = 'interrupt.raised' AND payload ->> 'raised_by' = $1 AND ts >= date_trunc('day', now() AT TIME ZONE 'UTC')",
    [memberId],
  );
  await pool.query(
    "DELETE FROM events WHERE event_type = 'interrupt.downgraded' AND payload ->> 'raised_by' = $1 AND ts >= date_trunc('day', now() AT TIME ZONE 'UTC')",
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

describe('SCC-3 Phase 1 — the raised hand: a standalone interrupt that is not a decision', () => {
  it('a connected member raises a BLOCKER — a hand, addressed to Prince, charged to itself, NO decision', async () => {
    const server = await startTestServer();
    const roomId = room('scc3-blocker');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    const token = await cred('claude-code');
    try {
      await resetInterruptBudget('claude-code');
      const res = await postHand(server, roomId, token, {
        urgency: 'blocker',
        reason: 'Blocked on the auth design — need your call before I can proceed.',
      });
      expect(res.status).toBe(201);
      const body = await handBody(res);
      expect(body.raised).toBe(true);
      expect(body.interrupts).toHaveLength(1);
      expect(body.interrupts![0].addressed_to).toBe('prince'); // the raiser's principal's human

      // THE FACT IN THE LOG: a hand, blocking, from claude-code to prince — and its about_kind is 'hand',
      // NEVER 'decision'. This is the anti-goal, asserted by the field the reader sees.
      const evs = await raisedEvents(roomId, 'claude-code');
      expect(evs).toHaveLength(1);
      expect(evs[0].urgency).toBe('BLOCKER');
      expect(evs[0].about_kind).toBe('hand');
      expect(evs[0].addressed_to).toBe('prince');
      expect(evs[0].summary).toContain('Blocked on the auth design');
      expect(evs[0].budget_remaining).toBe(5); // 6 - 1

      // NO DECISION EVENT, asserted by mechanism: the decision table is untouched. requestAction was
      // never called; there is nothing to sign.
      expect(await decisionEventCount(roomId)).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('an FYI raises a hand that costs nothing — silence is free, and so is an FYI', async () => {
    const server = await startTestServer();
    const roomId = room('scc3-fyi');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    const token = await cred('claude-code');
    try {
      await resetInterruptBudget('claude-code');
      const res = await postHand(server, roomId, token, {
        urgency: 'fyi',
        reason: 'Heads up — the deploy step is slow today, no action needed.',
      });
      expect(res.status).toBe(201);
      const evs = await raisedEvents(roomId, 'claude-code');
      expect(evs).toHaveLength(1);
      expect(evs[0].urgency).toBe('FYI');
      expect(evs[0].about_kind).toBe('hand');
      // FYI costs nothing: the snapshot shows the FULL budget still there (6), not 5.
      expect(evs[0].budget_remaining).toBe(6);
      expect(await decisionEventCount(roomId)).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('the daily budget binds a hand, and the exhausted refusal names itself', async () => {
    const { lines, stream } = capture();
    const server = await startTestServer({ loggerStream: stream, logLevel: 'info' });
    const roomId = room('scc3-budget');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    const token = await cred('claude-code');
    try {
      await resetInterruptBudget('claude-code');
      // interrupts_per_day is 6. Six BLOCKER hands (each unique client_msg_id, each costs one) land; the
      // seventh is refused BY BUDGET. Every count reports its denominator: 6 raised of 7 asked.
      for (let i = 0; i < 6; i++) {
        const r = await postHand(server, roomId, token, {
          urgency: 'blocker',
          reason: `blocker ${i}`,
          client_msg_id: `hand-${i}`,
        });
        expect(r.status).toBe(201);
      }
      const seventh = await postHand(server, roomId, token, {
        urgency: 'blocker',
        reason: 'blocker 6',
        client_msg_id: 'hand-6',
      });
      // THE LIMIT BINDS, by mechanism: the seventh is refused, the refusal NAMES ITSELF, and it is
      // distinguishable from a malformed refusal (400 interrupt_malformed) — this is 429, its own code.
      expect(seventh.status).toBe(429);
      const body = await handBody(seventh);
      expect(body.code).toBe('interrupt_budget_exhausted');
      expect(body.budget?.remaining).toBe(0);
      // Exactly six hands landed of seven asked (denominator stated).
      expect(await raisedEvents(roomId, 'claude-code')).toHaveLength(6);
      // And still: not one decision event was created by any of this.
      expect(await decisionEventCount(roomId)).toBe(0);
      expect(lines.join('')).toContain('no budget left today');
    } finally {
      await server.close();
    }
  });

  it('a hand retried with the same client_msg_id claims attention ONCE — idempotent, not double-charged', async () => {
    const server = await startTestServer();
    const roomId = room('scc3-idem');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    const token = await cred('claude-code');
    try {
      await resetInterruptBudget('claude-code');
      const first = await postHand(server, roomId, token, {
        urgency: 'blocker',
        reason: 'blocked — retried below',
        client_msg_id: 'hand-retry',
      });
      expect(first.status).toBe(201);
      // A network retry: identical body, identical client_msg_id. The uniqueness index dedups — one claim.
      const retry = await postHand(server, roomId, token, {
        urgency: 'blocker',
        reason: 'blocked — retried below',
        client_msg_id: 'hand-retry',
      });
      expect(retry.status).toBe(201);
      expect(await raisedEvents(roomId, 'claude-code')).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});

interface DecisionBody {
  decision?: string;
  decision_id?: string | null;
  status?: string;
  resolution?: string | null;
  signed_by?: string | null;
  poll_after_ms?: number | null;
}
async function postAction(
  server: TestServer,
  roomId: string,
  token: string,
  body: unknown,
): Promise<DecisionBody> {
  const res = await fetch(`${server.httpBase}/rooms/${roomId}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return (await res.json()) as DecisionBody;
}
async function getDecision(
  server: TestServer,
  roomId: string,
  token: string,
  decisionId: string,
): Promise<DecisionBody> {
  const res = await fetch(`${server.httpBase}/rooms/${roomId}/decisions/${decisionId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return (await res.json()) as DecisionBody;
}
// A CommandDeps for driving Prince's signature directly — an agent has no resolve endpoint and may never
// sign, so a signature is dispatched at the command (the same shape SCC-2 used). The stub adapter is
// never called: a pr.merge approval has no executor (S2.6).
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

describe('SCC-3 Phase 2 — waiting well: an honest backoff hint, never a callback', () => {
  it('a CO_SIGN hands back a poll hint; an ALLOW carries none — a number to wait, not a connection', async () => {
    const server = await startTestServer();
    const roomId = room('scc3-hint');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    const token = await cred('claude-code');
    try {
      await resetInterruptBudget('claude-code');
      // A protected ask → CO_SIGN → the response carries the interval to wait before the first poll.
      const cosign = await postAction(server, roomId, token, {
        action: 'pr.merge',
        resource: 'repo:x#1',
      });
      expect(cosign.decision).toBe('CO_SIGN');
      expect(cosign.poll_after_ms).toBe(DECISION_POLL_HINT_MS);
      expect(cosign.poll_after_ms).toBeGreaterThan(2000); // honest human time, not a 2s machine retry
      // An in-scope ALLOW has no decision to poll, so it offers no hint.
      const allow = await postAction(server, roomId, token, {
        action: 'pr.review',
        resource: 'repo:x#1',
      });
      expect(allow.decision).toBe('ALLOW');
      expect(allow.poll_after_ms).toBeNull();
    } finally {
      await server.close();
    }
  });

  it('a PENDING decision poll carries the hint; a RESOLVED one carries none and names the signer', async () => {
    const server = await startTestServer();
    const roomId = room('scc3-poll');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    const token = await cred('claude-code');
    try {
      await resetInterruptBudget('claude-code');
      const cosign = await postAction(server, roomId, token, {
        action: 'pr.merge',
        resource: 'repo:playroom#pr-9',
      });
      const decId = cosign.decision_id as string;
      expect(decId).toBeTruthy();

      // WHILE PENDING: the poll offers the honest interval — the caller may honour it.
      const pending = await getDecision(server, roomId, token, decId);
      expect(pending.status).toBe('pending');
      expect(pending.poll_after_ms).toBe(DECISION_POLL_HINT_MS);

      // Prince signs (the human in the loop).
      const signed = await executeCommand(
        { actorId: 'prince', mode: 'human' },
        {
          kind: 'signDecision',
          roomId,
          clientMsgId: 'scc3-sign',
          decisionId: decId,
          resolution: 'APPROVED',
        },
        makeDeps(),
      );
      expect(signed.ok).toBe(true);

      // ONCE RESOLVED: reads resolved with the signer named (unchanged from SCC-2), and offers NO further
      // poll — continuing would be the spin this closes.
      const done = await getDecision(server, roomId, token, decId);
      expect(done.status).toBe('resolved');
      expect(done.resolution).toBe('APPROVED');
      expect(done.signed_by).toBe('prince');
      expect(done.poll_after_ms).toBeNull();
    } finally {
      await server.close();
    }
  });

  it('no code path in the api opens an outbound connection to a caller — grep-proven, with a denominator', () => {
    // THE PROPERTY THAT MAKES A LAPTOP MEMBER SAFE: Playroom never initiates a connection to a caller. A
    // backoff hint is a number in a body, not a webhook, not a push, not a long-poll holding a socket
    // open. Asserted by mechanism: no source file under apps/api/src uses a client-dial primitive. The
    // pg Pool dials Postgres (not a caller) and @fastify/websocket is a SERVER; neither is here.
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith('.ts')) files.push(p);
      }
    };
    walk(srcDir);
    const OUTBOUND = [
      /\bfetch\s*\(/,
      /new\s+WebSocket\b/,
      /\bhttps?\.request\s*\(/,
      /\bnet\.(?:connect|createConnection)\s*\(/,
      /\bcreateConnection\s*\(/,
      /\bundici\b/,
      /\baxios\b/,
      /\bgot\s*\(/,
      /\bdgram\b/,
    ];
    const hits: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const rx of OUTBOUND) if (rx.test(text)) hits.push(`${f} :: ${rx}`);
    }
    // DENOMINATOR STATED: every source file × every dial primitive, zero hits.
    expect(files.length).toBeGreaterThan(30);
    expect(hits).toEqual([]);
  });
});
