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
import { budgetFor, downgradeInterrupt } from '../src/interrupts.js';

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

/** Every interrupt.raised in a room, from ALL raisers — for asserting who could and could not appear. */
async function allRaisedInRoom(
  roomId: string,
): Promise<
  Array<{ raised_by: string; addressed_to: string; about_kind: string; urgency: string }>
> {
  const { rows } = await pool.query<{
    raised_by: string;
    addressed_to: string;
    about_kind: string;
    urgency: string;
  }>(
    `SELECT payload ->> 'raised_by' AS raised_by,
            payload ->> 'addressed_to' AS addressed_to,
            payload ->> 'about_kind' AS about_kind,
            payload ->> 'urgency' AS urgency
       FROM events
      WHERE room_id = $1 AND event_type = 'interrupt.raised'
      ORDER BY seq`,
    [roomId],
  );
  return rows;
}
/** Every decision_id minted in a room — the co-sign fact a raised hand must never produce. */
async function decisionIds(roomId: string): Promise<string[]> {
  const { rows } = await pool.query<{ decision_id: string }>(
    "SELECT payload ->> 'decision_id' AS decision_id FROM events WHERE room_id = $1 AND event_type = 'decision' ORDER BY seq",
    [roomId],
  );
  return rows.map((r) => r.decision_id);
}

describe('SCC-3 Phase 3 — adversarial: the hand cannot become a decision, a demand, or a refund', () => {
  it('spam holds: the budget binds, refusals are legible, and NOT ONE decision event is created', async () => {
    const server = await startTestServer();
    const roomId = room('scc3-spam');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    const token = await cred('claude-code');
    try {
      await resetInterruptBudget('claude-code');
      // Twenty hands as fast as they will go. Six land; fourteen are refused by budget. Nothing here
      // touches the decision table — a raised hand is never a co-sign, no matter how many are thrown.
      let ok = 0;
      let refused = 0;
      for (let i = 0; i < 20; i++) {
        const r = await postHand(server, roomId, token, {
          urgency: 'blocker',
          reason: `spam ${i}`,
          client_msg_id: `spam-${i}`,
        });
        if (r.status === 201) ok++;
        else if (r.status === 429) {
          refused++;
          expect((await handBody(r)).code).toBe('interrupt_budget_exhausted');
        }
      }
      // Denominator: 6 landed + 14 refused = 20 asked. The budget held; the refusals named themselves.
      expect(ok).toBe(6);
      expect(refused).toBe(14);
      expect(await raisedEvents(roomId, 'claude-code')).toHaveLength(6);
      expect(await decisionEventCount(roomId)).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('a hand cannot be raised AS or AT another member — cross-member is not expressible at the door', async () => {
    const server = await startTestServer();
    const roomId = room('scc3-cross');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    const token = await cred('claude-code');
    try {
      await resetInterruptBudget('claude-code');
      // The body TRIES to raise as prince, at claude-main, about sol, for ada. Every one of those fields
      // is ignored: the door reads only urgency and reason. raised_by is the credential's member and
      // addressed_to is that member's principal's humans — DERIVED, never claimed.
      const res = await postHand(server, roomId, token, {
        urgency: 'blocker',
        reason: 'try to point this elsewhere',
        raised_by: 'prince',
        addressed_to: 'claude-main',
        subject: 'sol',
        member: 'ada',
        for: 'bo',
      });
      expect(res.status).toBe(201);
      const all = await allRaisedInRoom(roomId);
      expect(all).toHaveLength(1);
      expect(all[0].raised_by).toBe('claude-code'); // NOT prince
      expect(all[0].addressed_to).toBe('prince'); // NOT claude-main — the raiser's own principal's human
      // Nothing was raised by, or addressed to, any of the names the body tried to smuggle in.
      expect(all.some((r) => r.raised_by !== 'claude-code')).toBe(false);
      expect(all.some((r) => r.addressed_to === 'claude-main')).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('a hostile or oversized reason is schema-rejected BEFORE anything is written', async () => {
    const server = await startTestServer();
    const roomId = room('scc3-hostile');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    const token = await cred('claude-code');
    try {
      await resetInterruptBudget('claude-code');
      const bad: unknown[] = [
        { urgency: 'blocker', reason: 'x'.repeat(1001) }, // oversized
        { urgency: 'blocker', reason: '' }, // empty
        { urgency: 'blocker' }, // missing reason
        { urgency: 'blocker', reason: 42 }, // non-string
        { urgency: 'DECISION', reason: 'a hand is never a decision' }, // forbidden urgency
        { urgency: 'panic', reason: 'unknown urgency' }, // unknown urgency
        { reason: 'no urgency at all' }, // missing urgency
      ];
      for (const body of bad) {
        const r = await postHand(server, roomId, token, body);
        expect(r.status).toBe(400);
        expect((await handBody(r)).code).toBe('interrupt_malformed');
      }
      // NOTHING WAS WRITTEN by any rejected request — the schema gate is before the construction site.
      expect(await raisedEvents(roomId, 'claude-code')).toHaveLength(0);
      expect(await decisionEventCount(roomId)).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('an agent cannot lift its own ceiling, nor lower (refund) an interrupt it raised', async () => {
    const server = await startTestServer();
    const roomId = room('scc3-refund');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    const token = await cred('claude-code');
    try {
      await resetInterruptBudget('claude-code');
      // Spend the whole budget, then confirm the ceiling is the MANDATE's and unliftable by the agent:
      // it is still 6, and a further raise is still refused. There is no command that widens a mandate.
      for (let i = 0; i < 6; i++) {
        expect(
          (
            await postHand(server, roomId, token, {
              urgency: 'blocker',
              reason: `c ${i}`,
              client_msg_id: `ceil-${i}`,
            })
          ).status,
        ).toBe(201);
      }
      const budget = await budgetFor(pool, 'claude-code');
      expect(budget.limit).toBe(6); // read from the immutable mandate, not a runtime-writable counter
      expect(budget.remaining).toBe(0);
      expect(
        (
          await postHand(server, roomId, token, {
            urgency: 'blocker',
            reason: 'over the top',
            client_msg_id: 'ceil-6',
          })
        ).status,
      ).toBe(429);

      // And the raiser may NOT lower (refund) its own claim — only the member it is ADDRESSED TO may.
      // The first hand landed; claude-code is its raiser, prince its recipient.
      const mine = await pool.query<{ id: string }>(
        `SELECT id FROM interrupts WHERE room_id = $1 AND raised_by = 'claude-code' AND about_kind = 'hand' ORDER BY created_at LIMIT 1`,
        [roomId],
      );
      const handId = mine.rows[0].id;
      const asRaiser = await downgradeInterrupt(pool, handId, 'claude-code'); // the raiser tries to refund
      expect(asRaiser.ok).toBe(false);
      if (!asRaiser.ok) expect(asRaiser.failure).toBe('not_addressed_to_you');
      // The recipient CAN — the control belongs to whose attention was claimed, not to who claimed it.
      const asRecipient = await downgradeInterrupt(pool, handId, 'prince');
      expect(asRecipient.ok).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('to a reader who was not present, a raised hand and a pending co-sign are DIFFERENT FACTS', async () => {
    const server = await startTestServer();
    const roomId = room('scc3-distinct');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    const token = await cred('claude-code');
    try {
      await resetInterruptBudget('claude-code');
      // ONE room, BOTH facts. A raised hand (BLOCKER) and a co-sign (pr.merge → DECISION).
      expect(
        (
          await postHand(server, roomId, token, {
            urgency: 'blocker',
            reason: 'I need your call on the schema',
            client_msg_id: 'the-hand',
          })
        ).status,
      ).toBe(201);
      const cosign = await postAction(server, roomId, token, {
        action: 'pr.merge',
        resource: 'repo:x#1',
      });
      expect(cosign.decision).toBe('CO_SIGN');
      const decId = cosign.decision_id as string;

      // THE READER'S VIEW — the raw interrupt.raised facts. The two are told apart by about_kind and by
      // urgency, with no need to have been in the room:
      const all = await allRaisedInRoom(roomId);
      const hand = all.find((r) => r.about_kind === 'hand');
      const forCosign = all.find((r) => r.about_kind === 'decision');
      expect(hand).toBeTruthy();
      expect(hand!.urgency).toBe('BLOCKER'); // a raised hand
      expect(forCosign).toBeTruthy();
      expect(forCosign!.urgency).toBe('DECISION'); // a co-sign

      // AND THE DECIDING DIFFERENCE: exactly ONE decision event exists, and it is the co-sign's — the hand
      // produced none. A reader matches the DECISION interrupt to a real decision_id; the hand matches
      // nothing in the decision table.
      const decs = await decisionIds(roomId);
      expect(decs).toEqual([decId]);
      expect(decs).toHaveLength(1); // the hand did NOT mint a second one
    } finally {
      await server.close();
    }
  });
});
