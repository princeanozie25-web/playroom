import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentTurnChunk } from '@playroom/shared';
import { testPool, uniqueRoomId } from './support.js';
import { RoomBus } from '../src/bus.js';
import { createRoom } from '../src/events.js';
import { executeCommand, type CommandDeps } from '../src/commands/index.js';

/**
 * ═══ S-LOOP — LIMITS AND ATTENDANCE: every self-stop is named, and out loud ═══
 *
 * A standing order runs unattended, so the only safe loop is one that stops itself before it becomes
 * a problem — and stops LOUDLY, moving to a named state, writing the reason as a sentence, and
 * claiming its owner's attention through an interrupt (S1.4). Four self-stops, two terminal and two
 * resumable, plus the two resets that make the attendance dial mean "nobody is watching":
 *
 *   MAX CYCLES  (terminal)  the count the creator set is reached — the fired cycle was the last.
 *   EXPIRY      (terminal)  the wall-clock deadline passed — no cycle runs.
 *   CEILING     (pause)     the daily spend ceiling is reached — no cycle runs; resume after reset.
 *   ATTENDANCE  (pause)     it ran its unattended budget of cycles; a message or a resume clears it.
 */

const pool = testPool();
const rooms: string[] = [];

/** A plain replier — no emitted summon, so each fired cycle is exactly one summon deep. */
function replier(id: string): AgentAdapter {
  return {
    id,
    async *stream(): AsyncGenerator<AgentTurnChunk> {
      yield { kind: 'text_delta', text: `draft from ${id}` };
      yield { kind: 'done', tokens_in: 5, tokens_out: 3, stop_reason: 'end_turn' };
    },
  };
}

let deps: CommandDeps;
beforeEach(() => {
  deps = {
    pool,
    bus: new RoomBus(),
    log: { info() {}, warn() {}, error() {} },
    adapterFactory: (id) => replier(id),
    execute: (ctx, command) => executeCommand(ctx, command, deps),
  };
});

/** Interrupt events are global by member, so a clean slate keeps a raiser's budget out of the way. */
async function clearSpend(): Promise<void> {
  await pool.query(
    "DELETE FROM events WHERE event_type IN ('interrupt.raised', 'interrupt.downgraded')",
  );
}

/**
 * Tear a room down, resilient to a turn still writing. A fired cycle's turn can commit an event
 * AFTER its room's events were deleted but BEFORE the room row is; that stray row would fail the
 * `rooms` FK and, worse, leave a summon-less turn that the GLOBAL §19 drift query counts as unrooted.
 * So: delete children, then delete events-then-room together, retrying if a late write slips in.
 */
async function dropRoom(room: string): Promise<void> {
  await pool.query('DELETE FROM interrupts WHERE room_id = $1', [room]);
  await pool.query('DELETE FROM standing_orders WHERE room_id = $1', [room]);
  await pool.query('DELETE FROM room_members WHERE room_id = $1', [room]);
  for (let attempt = 0; attempt < 5; attempt++) {
    await pool.query('DELETE FROM events WHERE room_id = $1', [room]);
    try {
      await pool.query('DELETE FROM rooms WHERE id = $1', [room]);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200)); // a turn is mid-write; let it land, then re-delete
    }
  }
  await pool.query('DELETE FROM events WHERE room_id = $1', [room]);
  await pool.query('DELETE FROM rooms WHERE id = $1', [room]);
}

afterEach(async () => {
  for (const room of rooms) await dropRoom(room);
  rooms.length = 0;
  await clearSpend();
});

afterAll(async () => {
  await pool.end();
});

interface OrderLimits {
  maxCycles?: number | null;
  maxUnattended?: number;
  expiresAt?: string | null;
}

async function makeOrder(
  prefix: string,
  limits: OrderLimits = {},
): Promise<{ roomId: string; orderId: string }> {
  const roomId = uniqueRoomId(prefix);
  rooms.push(roomId);
  await createRoom(pool, roomId, roomId, 'prince');
  const created = await executeCommand(
    { actorId: 'prince', mode: 'human' },
    {
      kind: 'createOrder',
      roomId,
      clientMsgId: `oc-${prefix}`,
      triggerEventType: 'agent.turn.completed',
      triggerMember: 'sol', // sol's completion fires the order
      actionMember: 'claude-main', // and it summons claude-main
      maxCycles: limits.maxCycles ?? null,
      maxUnattendedCycles: limits.maxUnattended ?? 3,
      expiresAt: limits.expiresAt ?? null,
    },
    deps,
  );
  if (!created.ok) throw new Error('order not created');
  return { roomId, orderId: created.orderId! };
}

/** Simulate a completed turn arriving at the runner (the post-completion seam agent.ts dispatches). */
async function fireTrigger(roomId: string, member: string, seq: number): Promise<void> {
  await executeCommand(
    { actorId: 'system', mode: 'system' },
    { kind: 'runOrders', roomId, member, completedSeq: seq, success: true },
    deps,
  );
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 15000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function cycleCount(roomId: string, orderId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM events WHERE room_id = $1 AND event_type = 'order.cycled' AND payload ->> 'order_id' = $2`,
    [roomId, orderId],
  );
  return Number(rows[0].n);
}

async function order(
  roomId: string,
  orderId: string,
): Promise<{ status: string; pause_reason: string | null; unattended_count: number }> {
  const { rows } = await pool.query<{
    status: string;
    pause_reason: string | null;
    unattended_count: number;
  }>(
    `SELECT status, pause_reason, unattended_count FROM standing_orders WHERE id = $1 AND room_id = $2`,
    [orderId, roomId],
  );
  return rows[0];
}

async function turnsOf(roomId: string, member: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM events WHERE room_id = $1 AND event_type = 'agent.turn.completed' AND adapter_id = $2`,
    [roomId, member],
  );
  return Number(rows[0].n);
}

interface InterruptPayload {
  urgency: string;
  raised_by: string;
  addressed_to: string;
  about_kind: string;
  about_id: string;
  summary: string;
}

async function orderInterrupts(roomId: string): Promise<InterruptPayload[]> {
  const { rows } = await pool.query<{ payload: InterruptPayload }>(
    `SELECT payload FROM events
      WHERE room_id = $1 AND event_type = 'interrupt.raised' AND payload ->> 'about_kind' = 'order'
      ORDER BY seq`,
    [roomId],
  );
  return rows.map((r) => r.payload);
}

describe('max cycles is a terminus', () => {
  it('fires exactly the count set, then LIMIT_REACHED refuses the next trigger', async () => {
    const { roomId, orderId } = await makeOrder('lim-cycles', { maxCycles: 2 });

    await fireTrigger(roomId, 'sol', 1000);
    await until(
      () => cycleCount(roomId, orderId),
      (n) => n >= 1,
    );
    expect((await order(roomId, orderId)).status).toBe('ACTIVE'); // one of two — not done yet

    await fireTrigger(roomId, 'sol', 2000);
    await until(
      () => order(roomId, orderId).then((o) => o.status),
      (s) => s === 'LIMIT_REACHED',
    );
    const o = await order(roomId, orderId);
    expect(o.status).toBe('LIMIT_REACHED');
    expect(o.pause_reason).toMatch(/2 cycles/);
    expect(await cycleCount(roomId, orderId)).toBe(2);

    // A further trigger cannot open a cycle on a terminal order.
    await fireTrigger(roomId, 'sol', 3000);
    await new Promise((r) => setTimeout(r, 200));
    expect(await cycleCount(roomId, orderId)).toBe(2);
  });
});

describe('a passed expiry stops it before a cycle runs', () => {
  it('EXPIRES on the next trigger and fires no cycle', async () => {
    const { roomId, orderId } = await makeOrder('lim-expiry', {
      expiresAt: '2020-01-01T00:00:00.000Z', // long past
    });

    await fireTrigger(roomId, 'sol', 1000);
    await until(
      () => order(roomId, orderId).then((o) => o.status),
      (s) => s === 'EXPIRED',
    );
    expect((await order(roomId, orderId)).status).toBe('EXPIRED');
    expect(await cycleCount(roomId, orderId)).toBe(0); // pre-open gate: nothing fired
    expect(await turnsOf(roomId, 'claude-main')).toBe(0);
  });
});

describe('the daily ceiling pauses it, out loud', () => {
  it('a reached ceiling refuses the cycle and pauses — resumable, no turn run', async () => {
    const prev = process.env.PLAYROOM_DAILY_USD_CEILING;
    process.env.PLAYROOM_DAILY_USD_CEILING = '0'; // a $0 ceiling is reached by any spend, incl. none
    try {
      const { roomId, orderId } = await makeOrder('lim-ceiling');
      await fireTrigger(roomId, 'sol', 1000);
      await until(
        () => order(roomId, orderId).then((o) => o.status),
        (s) => s === 'PAUSED',
      );
      const o = await order(roomId, orderId);
      expect(o.status).toBe('PAUSED'); // a pause, not a terminal — the ceiling resets
      expect(o.pause_reason).toMatch(/ceiling/);
      expect(await cycleCount(roomId, orderId)).toBe(0); // pre-open gate: nothing fired
    } finally {
      if (prev === undefined) delete process.env.PLAYROOM_DAILY_USD_CEILING;
      else process.env.PLAYROOM_DAILY_USD_CEILING = prev;
    }
  });
});

describe('the attendance dial pauses an unwatched loop, and resets clear it', () => {
  it('pauses at the unattended budget, and a resume both reactivates and resets the streak', async () => {
    const { roomId, orderId } = await makeOrder('att-resume', { maxUnattended: 2 });

    await fireTrigger(roomId, 'sol', 1000); // cycle 1, unattended 1
    await until(
      () => cycleCount(roomId, orderId),
      (n) => n >= 1,
    );
    expect((await order(roomId, orderId)).status).toBe('ACTIVE');

    await fireTrigger(roomId, 'sol', 2000); // cycle 2, unattended 2 → the dial
    await until(
      () => order(roomId, orderId).then((o) => o.status),
      (s) => s === 'PAUSED',
    );
    expect((await order(roomId, orderId)).pause_reason).toMatch(/without you/);
    expect(await cycleCount(roomId, orderId)).toBe(2);

    // Paused, so the next trigger does not fire.
    await fireTrigger(roomId, 'sol', 3000);
    await new Promise((r) => setTimeout(r, 200));
    expect(await cycleCount(roomId, orderId)).toBe(2);

    // The creator resumes — active again, AND the streak is back to zero.
    const resumed = await executeCommand(
      { actorId: 'prince', mode: 'human' },
      { kind: 'controlOrder', roomId, clientMsgId: 'resume-1', orderId, op: 'resume' },
      deps,
    );
    expect(resumed.ok).toBe(true);
    expect((await order(roomId, orderId)).unattended_count).toBe(0);

    // It runs again from a fresh streak: one more cycle does NOT re-trip the dial.
    await fireTrigger(roomId, 'sol', 4000); // cycle 3, unattended 1
    await until(
      () => cycleCount(roomId, orderId),
      (n) => n >= 3,
    );
    expect((await order(roomId, orderId)).status).toBe('ACTIVE');
  });

  it('a human message in the room resets the dial', async () => {
    const { roomId, orderId } = await makeOrder('att-message', { maxUnattended: 2 });

    await fireTrigger(roomId, 'sol', 1000); // cycle 1, unattended 1
    await until(
      () => cycleCount(roomId, orderId),
      (n) => n >= 1,
    );

    // A person types — the room is watched, so the streak clears (fire-and-forget; poll for it).
    await executeCommand(
      { actorId: 'prince', mode: 'human' },
      { kind: 'postMessage', roomId, clientMsgId: 'watching-1', body: 'still here, keep going' },
      deps,
    );
    await until(
      () => order(roomId, orderId).then((o) => o.unattended_count),
      (n) => n === 0,
    );

    // Because the streak reset, the next cycle is unattended 1 — it does NOT trip the dial of 2.
    await fireTrigger(roomId, 'sol', 2000); // cycle 2, unattended 1
    await until(
      () => cycleCount(roomId, orderId),
      (n) => n >= 2,
    );
    expect((await order(roomId, orderId)).status).toBe('ACTIVE');
  });
});

describe('a self-stop claims the owner’s attention', () => {
  it('raises one DECISION interrupt about the order, addressed to the creator, charged to the loop’s agent', async () => {
    await clearSpend(); // a pristine budget for the raiser, so the claim is not refused
    const { roomId, orderId } = await makeOrder('stop-interrupt', { maxCycles: 1 });

    await fireTrigger(roomId, 'sol', 1000); // cycle 1 → LIMIT_REACHED → the stop
    await until(
      () => orderInterrupts(roomId).then((r) => r.length),
      (n) => n >= 1,
    );
    // Let the fired cycle's turn settle before the room is torn down, so a late turn write cannot
    // race afterEach's DELETE between events and rooms.
    await until(
      () => turnsOf(roomId, 'claude-main'),
      (n) => n >= 1,
    );

    const raised = await orderInterrupts(roomId);
    expect(raised).toHaveLength(1);
    expect(raised[0].urgency).toBe('DECISION'); // claims attention; halts nothing
    expect(raised[0].about_kind).toBe('order');
    expect(raised[0].about_id.startsWith(orderId)).toBe(true); // keyed on the order, unique per stop
    expect(raised[0].addressed_to).toBe('prince'); // the human of the creator's principal
    expect(raised[0].raised_by).toBe('claude-main'); // the loop's agent funds its own claim
    expect(raised[0].summary).toMatch(/cycle/);
  });
});
