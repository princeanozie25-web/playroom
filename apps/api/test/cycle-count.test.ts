import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentTurnChunk } from '@playroom/shared';
import { admitToRoom, dropRoomQuiesced, testPool, uniqueRoomId } from './support.js';
import { RoomBus } from '../src/bus.js';
import { createRoom } from '../src/events.js';
import { executeCommand, type CommandDeps } from '../src/commands/index.js';

/**
 * ═══ S-CYCLE — A COUNT MUST MEAN WORK (SC-1) ═══
 *
 * SD-N1, from the live tier: one cycle in seven opened, incremented the counter, wrote its summon,
 * took no turn, hit its cap and told a phone it had finished the work it was set to run. §22b's
 * one-turn-per-member rule was enforced at the END of the summon path, downstream of the counter, so
 * a cycle that collided with a turn already in flight was counted and then quietly did nothing.
 *
 * Everything the loop bounds itself with is a count — `max_cycles`, the attendance dial. A counter
 * that can count nothing makes every bound above it softer than it reads, and it made the
 * notification channel wrong on its first unattended run.
 *
 * ── WHAT THIS ASSERTS ────────────────────────────────────────────────────────────────
 *
 * The collision itself, and the MECHANISM that stopped it: the cycle is deferred before anything is
 * written, the room is told which rule fired, and the order stays ACTIVE — not counted, not evented,
 * and above all not terminal. A test that only checked "the number stayed put" would pass just as
 * happily if the cycle had opened and been abandoned, which is the bug.
 */

const pool = testPool();
const rooms: string[] = [];

/** A turn that will not finish until the test lets it — so a collision is deterministic, not timed. */
function heldAdapter(id: string, gate: Promise<void>): AgentAdapter {
  return {
    id,
    async *stream(): AsyncGenerator<AgentTurnChunk> {
      yield { kind: 'text_delta', text: 'thinking' };
      await gate;
      yield { kind: 'done', tokens_in: 5, tokens_out: 3, stop_reason: 'end_turn' };
    },
  };
}

let deps: CommandDeps;
let release: () => void;
let gate: Promise<void>;

beforeEach(() => {
  gate = new Promise<void>((r) => {
    release = r;
  });
  deps = {
    pool,
    bus: new RoomBus(),
    log: { info() {}, warn() {}, error() {} },
    adapterFactory: (id) => heldAdapter(id, gate),
    execute: (ctx, command) => executeCommand(ctx, command, deps),
  };
});

afterEach(async () => {
  release();
  await new Promise((r) => setTimeout(r, 200));
  for (const room of rooms) await dropRoomQuiesced(pool, room);
  rooms.length = 0;
});

afterAll(async () => {
  await pool.end();
});

async function newRoom(prefix: string): Promise<string> {
  const id = uniqueRoomId(prefix);
  rooms.push(id);
  await createRoom(pool, id, id, 'prince');
  await admitToRoom(id, 'claude-main', 'sol');
  return id;
}

async function makeOrder(roomId: string, maxCycles: number): Promise<string> {
  const created = await executeCommand(
    { actorId: 'prince', mode: 'human' },
    {
      kind: 'createOrder',
      roomId,
      clientMsgId: `oc-${roomId}`,
      triggerEventType: 'agent.turn.completed',
      triggerMember: 'sol',
      actionMember: 'claude-main',
      task: 'say one word',
      maxCycles,
      maxUnattendedCycles: 1,
      expiresAt: null,
    },
    deps,
  );
  if (!created.ok) throw new Error(`order not created: ${JSON.stringify(created)}`);
  return created.orderId!;
}

interface Row {
  status: string;
  cycle_count: number;
  unattended_count: number;
  open_cycle_seq: number | null;
}
async function orderRow(orderId: string): Promise<Row> {
  const { rows } = await pool.query<Row>(
    `SELECT status, cycle_count, unattended_count, open_cycle_seq
       FROM standing_orders WHERE id = $1`,
    [orderId],
  );
  return rows[0];
}

async function count(roomId: string, eventType: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM events WHERE room_id = $1 AND event_type = $2`,
    [roomId, eventType],
  );
  return Number(rows[0].n);
}

async function systemNotices(roomId: string): Promise<string[]> {
  const { rows } = await pool.query<{ body: string }>(
    `SELECT payload ->> 'body' AS body FROM events
      WHERE room_id = $1 AND event_type = 'message' AND actor_id = 'system' ORDER BY seq`,
    [roomId],
  );
  return rows.map((r) => r.body);
}

/** Start a turn for the action member and leave it running, so the next trigger collides with it. */
async function holdATurn(roomId: string): Promise<void> {
  await executeCommand(
    { actorId: 'prince', mode: 'human' },
    { kind: 'postMessage', roomId, clientMsgId: `hold-${roomId}`, body: '@claude-main hold on' },
    deps,
  );
  // Wait for the turn to actually be in flight — the started row is the proof, and the §22b key is
  // taken in the same call. Polling the log rather than sleeping keeps this deterministic.
  const deadline = Date.now() + 15000;
  for (;;) {
    if ((await count(roomId, 'agent.turn.started')) >= 1) return;
    if (Date.now() > deadline) throw new Error('no turn started to collide with');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('a cycle that cannot take its turn does not open', () => {
  it('DEFERS: nothing counted, nothing evented, no summon, and the room is told why', async () => {
    const roomId = await newRoom('sc-collide');
    const orderId = await makeOrder(roomId, 1);
    await holdATurn(roomId);

    const summonsBefore = await count(roomId, 'summon');
    await executeCommand(
      { actorId: 'system', mode: 'system' },
      { kind: 'runOrders', roomId, member: 'sol', completedSeq: 999999, success: true },
      deps,
    );
    await new Promise((r) => setTimeout(r, 400));

    // ── THE COUNT ────────────────────────────────────────────────────────────────────
    const row = await orderRow(orderId);
    expect(row.cycle_count, 'a cycle was counted for a turn that never ran').toBe(0);
    expect(row.unattended_count).toBe(0);
    expect(await count(roomId, 'order.cycled'), 'a cycle was evented with no turn').toBe(0);

    // ── THE MECHANISM ────────────────────────────────────────────────────────────────
    // Nothing was written on the order's behalf: no summon, and therefore no task and no orphan for
    // a turn that was never going to happen.
    expect(await count(roomId, 'summon'), 'a doomed summon was written').toBe(summonsBefore);
    // The trigger is NOT consumed either — a deferral leaves the order exactly where it was, so the
    // next completed turn can still fire it. This is the difference between deferring and losing.
    expect(row.open_cycle_seq).toBeNull();

    // ── OUT LOUD, NAMING THE RULE ────────────────────────────────────────────────────
    const notices = await systemNotices(roomId);
    const said = notices.find((n) => /did not open a cycle/.test(n));
    expect(said, `no notice named the deferral:\n${notices.join('\n')}`).toBeDefined();
    expect(said).toMatch(/already replying/);
    expect(said).toMatch(/next completed turn/);

    // ── AND NOT TERMINAL ─────────────────────────────────────────────────────────────
    // The order's cap is 1. Under the defect this collision would have counted cycle 1, reached the
    // cap, and sent a FINISHED for work that never happened.
    expect(row.status, 'a collision resolved the order as finished').toBe('ACTIVE');
    expect(await count(roomId, 'order.status')).toBe(0);
    expect(await count(roomId, 'interrupt.raised')).toBe(0);
  });

  it('and the cycle it deferred still runs on the next trigger', async () => {
    const roomId = await newRoom('sc-after');
    const orderId = await makeOrder(roomId, 1);
    await holdATurn(roomId);

    await executeCommand(
      { actorId: 'system', mode: 'system' },
      { kind: 'runOrders', roomId, member: 'sol', completedSeq: 111, success: true },
      deps,
    );
    await new Promise((r) => setTimeout(r, 300));
    expect((await orderRow(orderId)).cycle_count).toBe(0);

    // The member finishes what it was doing, and a later trigger arrives.
    release();
    await new Promise((r) => setTimeout(r, 600));
    await executeCommand(
      { actorId: 'system', mode: 'system' },
      { kind: 'runOrders', roomId, member: 'sol', completedSeq: 222, success: true },
      deps,
    );

    const deadline = Date.now() + 20000;
    for (;;) {
      if ((await orderRow(orderId)).cycle_count >= 1) break;
      if (Date.now() > deadline) throw new Error('the deferred cycle never ran');
      await new Promise((r) => setTimeout(r, 100));
    }
    // ONE cycle, one turn — the deferral cost the loop nothing but the trigger it could not use.
    expect((await orderRow(orderId)).cycle_count).toBe(1);
    expect(await count(roomId, 'order.cycled')).toBe(1);
  });
});
