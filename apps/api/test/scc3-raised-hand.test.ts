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
