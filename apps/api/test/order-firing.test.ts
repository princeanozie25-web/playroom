import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentTurnChunk } from '@playroom/shared';
import { testPool, uniqueRoomId } from './support.js';
import { RoomBus } from '../src/bus.js';
import { createRoom } from '../src/events.js';
import { executeCommand, type CommandDeps } from '../src/commands/index.js';

/**
 * ═══ S-LOOP — THE TRIGGER FIRES: a completed turn drives the next cycle ═══
 *
 * A completed turn matching an order's filter fires an order-rooted summon — human-rooted through the
 * creator, marked with the order id. Firing is idempotent per triggering event and one-cycle-in-flight
 * (both at the database), an error terminal pauses instead of cycling, and every order-rooted turn
 * still resolves to a human in the §19 drift query. Orders cause; they do not grant.
 */

const pool = testPool();
const rooms: string[] = [];

/** A plain replier — no emitted summon, so a fired cycle is one summon deep and deterministic. */
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

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  for (const room of rooms) {
    await pool.query('DELETE FROM standing_orders WHERE room_id = $1', [room]);
    await pool.query('DELETE FROM events WHERE room_id = $1', [room]);
    await pool.query('DELETE FROM room_members WHERE room_id = $1', [room]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [room]);
  }
  rooms.length = 0;
});

async function makeOrder(prefix: string): Promise<{ roomId: string; orderId: string }> {
  const roomId = uniqueRoomId(prefix);
  rooms.push(roomId);
  await createRoom(pool, roomId, roomId, 'prince');
  const created = await executeCommand(
    { actorId: 'prince', mode: 'human' },
    {
      kind: 'createOrder',
      roomId,
      clientMsgId: `oc-${Date.now()}`,
      triggerEventType: 'agent.turn.completed',
      triggerMember: 'sol', // sol's completion fires the order
      actionMember: 'claude-main', // and it summons claude-main
      task: 'draft, then hand back for review',
      // A CYCLE CAP: S-DIAL refuses a dial above 1 with no end. Generous enough that this
      // fixture behaves exactly as it did.
      maxCycles: 50,
      maxUnattendedCycles: 3,
      expiresAt: null,
    },
    deps,
  );
  if (!created.ok) throw new Error('order not created');
  return { roomId, orderId: created.orderId! };
}

async function fireTrigger(
  roomId: string,
  member: string,
  seq: number,
  success = true,
  orderId?: string,
) {
  return executeCommand(
    { actorId: 'system', mode: 'system' },
    { kind: 'runOrders', roomId, member, completedSeq: seq, success, orderId },
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
interface SummonPayload {
  member: string;
  requested_by: string;
  root_actor: string;
  depth: number;
  order_id?: string;
}
async function orderSummons(roomId: string, orderId: string) {
  const { rows } = await pool.query<{ payload: SummonPayload; root_is_human: boolean }>(
    `SELECT payload, root_is_human FROM events
      WHERE room_id = $1 AND event_type = 'summon' AND payload ->> 'order_id' = $2 ORDER BY seq`,
    [roomId, orderId],
  );
  return rows.map((r) => ({ ...r.payload, root_is_human: r.root_is_human }));
}
async function turnsOf(roomId: string, member: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM events WHERE room_id = $1 AND event_type = 'agent.turn.completed' AND adapter_id = $2`,
    [roomId, member],
  );
  return Number(rows[0].n);
}
async function orderStatus(roomId: string, orderId: string): Promise<string> {
  const { rows } = await pool.query<{ status: string }>(
    `SELECT status FROM standing_orders WHERE id = $1 AND room_id = $2`,
    [orderId, roomId],
  );
  return rows[0].status;
}

describe('a completed turn fires an order-rooted cycle', () => {
  it('summons the action member, rooted in the creator and marked with the order', async () => {
    const { roomId, orderId } = await makeOrder('fire-basic');
    await fireTrigger(roomId, 'sol', 1000);
    await until(
      () => turnsOf(roomId, 'claude-main'),
      (n) => n >= 1,
    );

    expect(await cycleCount(roomId, orderId)).toBe(1);
    const summons = await orderSummons(roomId, orderId);
    expect(summons).toHaveLength(1);
    expect(summons[0].member).toBe('claude-main');
    expect(summons[0].order_id).toBe(orderId);
    expect(summons[0].root_actor).toBe('prince'); // the creator is the human at the head
    expect(summons[0].root_is_human).toBe(true); // so it resolves in the drift ledger
    expect(summons[0].requested_by).toBe('prince');
    expect(summons[0].depth).toBe(0); // a fresh human-rooted cycle
    expect(await turnsOf(roomId, 'claude-main')).toBe(1);
  });
});

describe('idempotent per event, one cycle in flight (database)', () => {
  it('the same completion fires once; an older one never fires; a newer one advances', async () => {
    const { roomId, orderId } = await makeOrder('fire-once');
    await fireTrigger(roomId, 'sol', 1000);
    await until(
      () => cycleCount(roomId, orderId),
      (n) => n >= 1,
    );

    // Replay of the same triggering completion — no second cycle.
    await fireTrigger(roomId, 'sol', 1000);
    await new Promise((r) => setTimeout(r, 200));
    expect(await cycleCount(roomId, orderId)).toBe(1);

    // An OLDER completion cannot open a cycle behind the one in flight.
    await fireTrigger(roomId, 'sol', 500);
    await new Promise((r) => setTimeout(r, 200));
    expect(await cycleCount(roomId, orderId)).toBe(1);

    // A NEWER completion advances the loop.
    await fireTrigger(roomId, 'sol', 2000);
    await until(
      () => cycleCount(roomId, orderId),
      (n) => n >= 2,
    );
    expect(await cycleCount(roomId, orderId)).toBe(2);
  });
});

describe('an error terminal pauses the order', () => {
  it('a failed turn in the order’s cycle pauses it out loud rather than cycling', async () => {
    const { roomId, orderId } = await makeOrder('fire-error');
    // A turn that belonged to this order (its chain carried the order id) ended in error.
    await fireTrigger(roomId, 'claude-main', 1000, false, orderId);
    await until(
      () => orderStatus(roomId, orderId),
      (s) => s === 'PAUSED',
    );
    expect(await orderStatus(roomId, orderId)).toBe('PAUSED');
    // A subsequent success trigger does NOT fire — the order is paused, not active.
    await fireTrigger(roomId, 'sol', 2000);
    await new Promise((r) => setTimeout(r, 200));
    expect(await cycleCount(roomId, orderId)).toBe(0);
  });
});

describe('order-rooted turns resolve to a human in the drift ledger', () => {
  it('the drift query counts the order-rooted turn as resolving, and unrooted stays zero', async () => {
    const { roomId, orderId } = await makeOrder('fire-drift');
    await fireTrigger(roomId, 'sol', 1000);
    await until(
      () => turnsOf(roomId, 'claude-main'),
      (n) => n >= 1,
    );
    await new Promise((r) => setTimeout(r, 300)); // let the fired turn's rows settle

    // Scoped drift check for this room: the order-rooted turn resolves (human-rooted via the creator),
    // and no turn in this room is unrooted.
    const { rows } = await pool.query<{ unrooted: string; order_rooted: string }>(
      `WITH turn_rows AS (
         SELECT summon_id, payload ->> 'turn_id' AS turn_id FROM events
          WHERE room_id = $1 AND event_type LIKE 'agent.turn.%'
       ),
       summon_rows AS (
         SELECT summon_id, root_is_human, payload ->> 'order_id' AS order_id FROM events
          WHERE room_id = $1 AND event_type = 'summon'
       )
       SELECT
         (SELECT count(*) FROM turn_rows t LEFT JOIN summon_rows s ON s.summon_id = t.summon_id
            WHERE t.summon_id IS NULL OR s.summon_id IS NULL OR s.root_is_human IS NOT TRUE) AS unrooted,
         (SELECT count(DISTINCT t.turn_id) FROM turn_rows t JOIN summon_rows s ON s.summon_id = t.summon_id
            WHERE s.order_id IS NOT NULL AND s.root_is_human IS TRUE) AS order_rooted`,
      [roomId],
    );
    expect(Number(rows[0].unrooted)).toBe(0);
    expect(Number(rows[0].order_rooted)).toBeGreaterThanOrEqual(1);
    void orderId;
  });
});
