import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admitToRoom,
  Client,
  factoryFor,
  httpCreateRoom,
  scriptedAdapter,
  startTestServer,
  testPool,
  uniqueRoomId,
  type TestServer,
} from './support.js';
import { appendRoomSummary } from '../src/events.js';
import { roomSpend, spendToday } from '../src/spend.js';

/**
 * ═══ S1.6 — THE PER-ROOM BUDGET METER ═══
 *
 * A member can see what a room has spent, accruing, before they ever hit the ceiling. The number is
 * a SUM of cost already logged — turns and summaries — scoped to one room, and it is a DIFFERENT
 * thing from the daily ceiling: per-room versus global, cumulative versus today, informs versus
 * refuses (item 13). This suite proves the server half: the sum is per-room, it counts both kinds of
 * spend, and `hello` carries it so the client can render it the instant a room opens.
 */

const pool = testPool();
const roomA = uniqueRoomId('meter-a');
const roomB = uniqueRoomId('meter-b');
let server: TestServer;

beforeAll(async () => {
  server = await startTestServer({
    adapterFactory: factoryFor(
      scriptedAdapter('claude-main', [
        { kind: 'text_delta', text: 'a reply' },
        { kind: 'done', tokens_in: 10, tokens_out: 20, stop_reason: 'end_turn' },
      ]),
    ),
  });
  expect((await httpCreateRoom(server.httpBase, roomA, server.token)).status).toBe(201);
  expect((await httpCreateRoom(server.httpBase, roomB, server.token)).status).toBe(201);
  await admitToRoom(roomA, 'claude-main');
  await admitToRoom(roomB, 'claude-main');
});

afterAll(async () => {
  await server.close();
  for (const room of [roomA, roomB]) {
    await pool.query('DELETE FROM events WHERE room_id = $1', [room]);
    await pool.query('DELETE FROM room_members WHERE room_id = $1', [room]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [room]);
  }
  await pool.end();
});

/** Run one real (scripted) turn in a room, so its spend moves by a real amount. */
async function runTurn(room: string, clientMsgId: string): Promise<void> {
  const c = new Client(`${server.wsBase}/rooms/${room}/ws`, server.token);
  await c.open();
  c.send(`@claude ${clientMsgId}`, clientMsgId);
  await c.waitForType('agent.turn.completed', 20000);
  c.close();
}

/** Sum a room's completed-turn cost straight from the log — the number the meter should equal. */
async function turnCostOf(room: string): Promise<number> {
  const { rows } = await pool.query<{ spent: string | null }>(
    `SELECT sum(cost_usd) AS spent FROM events
      WHERE room_id = $1 AND event_type = 'agent.turn.completed' AND cost_usd IS NOT NULL`,
    [room],
  );
  return Number(rows[0].spent ?? 0);
}

describe('roomSpend: a sum of this room, and only this room', () => {
  it('counts the room’s turns, excludes another room’s entirely', async () => {
    await runTurn(roomA, 'a1');
    await runTurn(roomA, 'a2');
    await runTurn(roomB, 'b1');

    const aTurns = await turnCostOf(roomA);
    const bTurns = await turnCostOf(roomB);
    expect(aTurns).toBeGreaterThan(0);
    expect(bTurns).toBeGreaterThan(0);

    // The meter for A is A's spend, not the deployment's. B's turn is invisible to it.
    expect(await roomSpend(pool, roomA)).toBeCloseTo(aTurns, 6);
    expect(await roomSpend(pool, roomB)).toBeCloseTo(bTurns, 6);

    // And DISTINCT from the daily ceiling's number, which is global: today's total is at least both
    // rooms' spend together, so it is strictly more than either room's meter.
    const today = await spendToday(pool);
    expect(today.spent_usd).toBeGreaterThanOrEqual(aTurns + bTurns - 1e-9);
    expect(today.spent_usd).toBeGreaterThan(aTurns);
  });

  it('counts a room.summary’s cost too — every model call the room caused (item 8)', async () => {
    const before = await roomSpend(pool, roomA);
    const summaryCost = 0.005;
    // A summary row with a real cost, at a coverage point that cannot collide with a real fold.
    const ev = await appendRoomSummary(pool, roomA, {
      summary_id: 'sum_meter_test',
      covers_through_seq: 999_000_001,
      covers_message_count: 1,
      text: 'a folded summary',
      tokens_in: 100,
      tokens_out: 10,
      cost_usd: summaryCost,
      prompt_hash: null,
    });
    expect(ev).not.toBeNull();
    expect(await roomSpend(pool, roomA)).toBeCloseTo(before + summaryCost, 6);
  });
});

describe('hello carries the baseline, so the meter is right the instant the room opens', () => {
  it('the hello frame’s room_spent_usd equals roomSpend for that room', async () => {
    const expected = await roomSpend(pool, roomA);
    expect(expected).toBeGreaterThan(0);
    const c = new Client(`${server.wsBase}/rooms/${roomA}/ws`, server.token);
    await c.open();
    // hello lands on open; give the frame a moment if it has not been recorded yet.
    const deadline = Date.now() + 5000;
    while (c.helloSpend === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(c.helloSpend).toBeCloseTo(expected, 6);
    c.close();
  });

  it('a fresh room’s baseline is zero — nothing to show until something is spent', async () => {
    const empty = uniqueRoomId('meter-empty');
    expect((await httpCreateRoom(server.httpBase, empty, server.token)).status).toBe(201);
    try {
      const c = new Client(`${server.wsBase}/rooms/${empty}/ws`, server.token);
      await c.open();
      const deadline = Date.now() + 5000;
      while (c.helloSpend === undefined && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(c.helloSpend).toBe(0);
      c.close();
    } finally {
      await pool.query('DELETE FROM events WHERE room_id = $1', [empty]);
      await pool.query('DELETE FROM room_members WHERE room_id = $1', [empty]);
      await pool.query('DELETE FROM rooms WHERE id = $1', [empty]);
    }
  });
});
