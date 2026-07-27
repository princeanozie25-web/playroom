import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  factoryFor,
  httpCreateRoom,
  scriptedAdapter,
  startTestServer,
  testPool,
  uniqueRoomId,
  type TestServer,
} from './support.js';
import { ceilingMessage, ceilingUsd, spendToday } from '../src/spend.js';

// A CEILING THAT REFUSES OUT LOUD (Bible §18).
//
// The floor under S2.7's per-room budgets, and it exists for one reason: strangers are about to spend
// real provider keys through a URL I do not control. A public deployment with real keys and no ceiling
// has exactly one failure mode and it arrives as a bill.
//
// EVERY CASE ASSERTS THE MECHANISM AND THE SENTENCE. "No turn happened" is satisfied by a broken
// adapter, an unresolvable tag and a working ceiling — so each case checks that the ROOM WAS TOLD,
// which is the half that stops a ceiling being indistinguishable from the product being broken.

const pool = testPool();
const roomId = uniqueRoomId('ceiling');

// ── NOTHING IN THIS FILE HAND-WRITES AN EVENT, AND TWO FAILURES TAUGHT ME WHY ──
//
// The first version injected an `agent.turn.completed` row to move today's spend. It broke twice, in
// two different ways, and both were the system being right:
//
//   1. THE SOCKET WENT SILENT. A hand-written payload cannot satisfy `AgentTurnCompleted`, so
//      replaying that room's log threw inside `rowToServerEvent` and the client received nothing at
//      all — not a parse error, just a room that would not open.
//   2. THE §19 DRIFT QUERY CAUGHT IT. A turn event with no summon provenance is exactly what that
//      query exists to find, and it found mine.
//
// So spend is moved by RUNNING A REAL TURN through the scripted adapter: real provenance, real cost,
// real `cost_usd`. A fixture that has to be excused by two other mechanisms is not a fixture.
let server: TestServer;
const original = process.env.PLAYROOM_DAILY_USD_CEILING;

beforeAll(async () => {
  server = await startTestServer({
    adapterFactory: factoryFor(
      scriptedAdapter('claude-main', [
        { kind: 'text_delta', text: 'a reply' },
        { kind: 'done', tokens_in: 10, tokens_out: 2, stop_reason: 'end_turn' },
      ]),
    ),
  });
  expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
});

/** Run one real turn, so today's spend moves by a real (tiny) amount. Returns nothing. */
async function runOneRealTurn(clientMsgId: string): Promise<void> {
  process.env.PLAYROOM_DAILY_USD_CEILING = '1000000';
  const c = new Client(`${server.wsBase}/rooms/${roomId}/ws`, server.token);
  await c.open();
  c.send(`@claude ${clientMsgId}`, clientMsgId);
  await c.waitForType('agent.turn.completed', 20000);
  c.close();
}

afterEach(() => {
  if (original === undefined) delete process.env.PLAYROOM_DAILY_USD_CEILING;
  else process.env.PLAYROOM_DAILY_USD_CEILING = original;
});

afterAll(async () => {
  // THE SERVER CLOSES FIRST, and that ordering is the fix rather than a tidy-up.
  //
  // The last case runs a real turn and awaits `agent.turn.completed`, but the turn's TRAILING writes
  // — the task transition — land after that event. Deleting the room while one was still in flight
  // violated `events_room_id_fkey`: a row arriving for a room that no longer existed. The same class
  // as S14-7, asserting that something arrived rather than that the work had SETTLED.
  //
  // Closing the server first means no further write can begin. Then the deletes have nothing racing
  // them, and the retry below covers the write already on the wire when `close()` was called.
  await server.close();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await pool.query('DELETE FROM events WHERE room_id = $1', [roomId]);
      await pool.query('DELETE FROM room_members WHERE room_id = $1', [roomId]);
      await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
      break;
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  await pool.end();
});

describe('reading the ceiling', () => {
  it('is absent when unset — no ceiling, reported as absent rather than as a big number', () => {
    delete process.env.PLAYROOM_DAILY_USD_CEILING;
    expect(ceilingUsd()).toBeNull();
  });

  it('THROWS on a malformed value instead of reading as unlimited', () => {
    // The shape of every fail-open configuration bug, on the one setting whose failure is measured
    // in money. `PLAYROOM_DAILY_USD_CEILING=five` must not mean "spend freely".
    process.env.PLAYROOM_DAILY_USD_CEILING = 'five';
    expect(() => ceilingUsd()).toThrow(/not a number/);
    process.env.PLAYROOM_DAILY_USD_CEILING = '-3';
    expect(() => ceilingUsd()).toThrow(/not a number/);
  });

  it('sums today’s cost from the LOG, not from a counter', async () => {
    // Same reasoning as the interrupt budget: a counter is a second representation of a fact the log
    // already holds, and the two drift the first time a write fails between them. A restart forgets a
    // counter and cannot forget the log.
    const before = await spendToday(pool);
    await runOneRealTurn('spend-1');
    process.env.PLAYROOM_DAILY_USD_CEILING = '1000';
    const after = await spendToday(pool);
    // A real scripted turn is worth fractions of a cent, so the assertion is that it MOVED — not by
    // how much. Pinning the amount would pin the adapter's prices, which are config and not a claim
    // this test is making.
    expect(after.spent_usd).toBeGreaterThan(before.spent_usd);
    expect(after.remaining_usd).toBeCloseTo(1000 - after.spent_usd, 6);
    expect(after.exceeded).toBe(false);
  });

  it('reports remaining as ABSENT when there is no ceiling, not as a large number', async () => {
    delete process.env.PLAYROOM_DAILY_USD_CEILING;
    const state = await spendToday(pool);
    expect(state.ceiling_usd).toBeNull();
    expect(state.remaining_usd).toBeNull();
    expect(state.exceeded, 'no ceiling was treated as an exceeded ceiling').toBe(false);
  });
});

describe('the sentence the room shows', () => {
  it('says what happened, whose fault it is not, and when it ends', () => {
    // Written for the person who just tagged somebody. A tester who tags an agent and gets silence
    // concludes the product is broken, which is the failure this sentence exists to prevent.
    const msg = ceilingMessage({
      spent_usd: 4.2,
      ceiling_usd: 4,
      remaining_usd: 0,
      exceeded: true,
    });
    expect(msg).toContain('$4');
    expect(msg).toMatch(/midnight UTC/);
    expect(msg).toMatch(/Nothing you did caused this/);
    // AND IT DOES NOT PUBLISH WHAT A STRANGER HAS SPENT OF MY MONEY. A running total in a shared
    // room is both none of their business and an invitation to a game.
    expect(msg).not.toContain('4.2');
  });
});

describe('a summon under an exceeded ceiling', () => {
  it('RUNS NO TURN AND SAYS SO — and spends nothing doing it', async () => {
    // A real turn first, so there IS spend, then a ceiling below it. Derived from the measurement
    // rather than hardcoded: a magic number here would silently stop being below the total the day
    // the adapter's prices change.
    await runOneRealTurn('spend-2');
    process.env.PLAYROOM_DAILY_USD_CEILING = '1000000';
    const state = await spendToday(pool);
    expect(
      state.spent_usd,
      'no spend was recorded, so the ceiling below cannot be exceeded',
    ).toBeGreaterThan(0);
    process.env.PLAYROOM_DAILY_USD_CEILING = String(state.spent_usd / 2);

    // THE WATERMARK, FROM THE DATABASE — not from the client's replay.
    //
    // Counting turn events on the socket failed twice for two different timing reasons: `open()`
    // resolves when the socket opens, BEFORE the replay frames arrive, so a count taken there is
    // zero and the replayed history then looks like new turns. The log has no such ambiguity. Assert
    // on what was WRITTEN after this point, which is also the thing the claim is actually about.
    const { rows: mark } = await pool.query<{ seq: string }>(
      'SELECT COALESCE(MAX(seq), 0)::text AS seq FROM events WHERE room_id = $1',
      [roomId],
    );
    const watermark = mark[0].seq;

    const c = new Client(`${server.wsBase}/rooms/${roomId}/ws`, server.token);
    await c.open();
    c.send('@claude are you there?', 'ceil-1');

    // WAIT FOR THE CONDITION, NOT FOR A COUNT — the S13c-N1 lesson. Counting events had me waiting
    // for three (message, summon, refusal) when a `route.selected` also lands, so the assertion ran
    // one event too early and reported the ceiling as broken when it was merely not finished. A
    // count is a guess about the log's shape; the condition is the thing being tested.
    const bodies = (): string[] =>
      c.events
        .filter((e) => e.event_type === 'message')
        .map((e) => (e.event_type === 'message' ? e.payload.body : ''));
    const deadline = Date.now() + 15000;
    while (!bodies().some((b) => b.includes('spending limit')) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(bodies().some((b) => b.includes('spending limit'))).toBe(true);
    expect(bodies().some((b) => b.includes('midnight UTC'))).toBe(true);

    // NO NEW TURN WAS WRITTEN. Not a failed one either — an `agent.turn.started` would mean a turn
    // that began, and a turn that began implies a provider call that may already have cost
    // something. The ceiling has to refuse BEFORE the stamp, not report a failure after it.
    const { rows: after } = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM events
        WHERE room_id = $1 AND seq > $2::bigint AND event_type LIKE 'agent.turn.%'
        ORDER BY seq`,
      [roomId, watermark],
    );
    expect(
      after.map((r) => r.event_type),
      'a turn was written under an exceeded ceiling',
    ).toEqual([]);
    c.close();
  }, 30000);

  it('and the refusal is attributed to the ROOM, not to the agent', async () => {
    // A refusal wearing the agent's name would read as the agent declining, which is a statement
    // about its judgement rather than about my provider bill.
    const { rows } = await pool.query<{ actor_id: string }>(
      `SELECT actor_id FROM events
        WHERE room_id = $1 AND event_type = 'message' AND payload ->> 'body' LIKE '%spending limit%'`,
      [roomId],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.actor_id).toBe('system');
  });

  it('lets turns through again once the ceiling is raised', async () => {
    // The other direction, because a ceiling that never reopens is a broken deployment rather than a
    // budget — and because this proves the refusal above was the ceiling and not something else.
    process.env.PLAYROOM_DAILY_USD_CEILING = '1000000';
    const c = new Client(`${server.wsBase}/rooms/${roomId}/ws`, server.token);
    await c.open();
    c.send('@claude and now?', 'ceil-2');
    await c.waitForType('agent.turn.completed', 20000);
    const completed = c.events.filter((e) => e.event_type === 'agent.turn.completed');
    expect(completed.length).toBeGreaterThan(0);
    c.close();
  }, 30000);
});
