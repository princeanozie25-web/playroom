import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentAdapter, AgentTurnChunk } from '@playroom/shared';
import {
  ERROR_ORDER_TASK_ABSENT,
  ERROR_ORDER_TASK_BLANK,
  ERROR_ORDER_TASK_TOO_LARGE,
  ORDER_TASK_MAX_CHARS,
} from '@playroom/shared';
import { dropRoomQuiesced, testPool, uniqueRoomId } from './support.js';
import { RoomBus } from '../src/bus.js';
import { createRoom } from '../src/events.js';
import { orderById } from '../src/orders.js';
import { executeCommand, type CommandDeps } from '../src/commands/index.js';

/**
 * ═══ S-TASK — AN ORDER SAYS WHAT IT IS FOR (ST-1) ═══
 *
 * SL2-N5: the loop ran and did not do the work it was pointed at, because nothing on the order said
 * what the work WAS. The task is that missing object — and it is WIRING, not cadence: set once, at
 * creation, by a human, and changed only by creating a new order.
 *
 * These assert the two halves of that: the refusals a human meets at creation (three of them, each
 * naming its own rule), and the ABSENCE of any path that could edit one afterwards. The absence is
 * the load-bearing half — UI3-1 made an order's wiring immutable by having no parameter for it, and a
 * task guarded by a check instead of by absence would be a guard someone can argue with.
 */

const pool = testPool();
const rooms: string[] = [];

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
afterEach(async () => {
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
  return id;
}

/** Create an order, passing whatever task the case is about — including none at all. */
async function create(roomId: string, task?: string) {
  return executeCommand(
    { actorId: 'prince', mode: 'human' },
    {
      kind: 'createOrder',
      roomId,
      clientMsgId: `oc-${roomId}-${String(task).slice(0, 8)}`,
      triggerEventType: 'agent.turn.completed',
      triggerMember: 'sol',
      actionMember: 'claude-main',
      maxCycles: null,
      maxUnattendedCycles: 3,
      expiresAt: null,
      ...(task === undefined ? {} : { task }),
    },
    deps,
  );
}

describe('an order cannot be created without saying what it is for', () => {
  it('refuses an ABSENT task by name, and writes no order and no event', async () => {
    const roomId = await newRoom('st-absent');
    const result = await create(roomId);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal.code).toBe(ERROR_ORDER_TASK_ABSENT);
    // The refusal says what to do, not merely that something was wrong.
    expect(result.refusal.message).toMatch(/what it is for/);

    // NOTHING WAS WRITTEN — refused before the record, so a rejected order leaves no trace to clean
    // up and no half-order for the runner to find.
    const { rows: orders } = await pool.query(`SELECT id FROM standing_orders WHERE room_id = $1`, [
      roomId,
    ]);
    expect(orders).toHaveLength(0);
    const { rows: events } = await pool.query(
      `SELECT seq FROM events WHERE room_id = $1 AND event_type = 'order.created'`,
      [roomId],
    );
    expect(events).toHaveLength(0);
  });

  it('refuses a BLANK task, and a whitespace-only one, by their own rule', async () => {
    const roomId = await newRoom('st-blank');
    for (const blank of ['', '   ', '\n\t  \n']) {
      const result = await create(roomId, blank);
      expect(result.ok, `"${blank}" was accepted`).toBe(false);
      if (result.ok) throw new Error('unreachable');
      // Its OWN code, distinct from absent: a person who submitted an empty box has a different fix
      // from a client that never sent the field.
      expect(result.refusal.code).toBe(ERROR_ORDER_TASK_BLANK);
    }
  });

  it('refuses a task over the cap, saying the cap and the length — and never truncates', async () => {
    const roomId = await newRoom('st-large');
    const overCap = 'x'.repeat(ORDER_TASK_MAX_CHARS + 1);
    const result = await create(roomId, overCap);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal.code).toBe(ERROR_ORDER_TASK_TOO_LARGE);
    expect(result.refusal.message).toContain(String(ORDER_TASK_MAX_CHARS));
    expect(result.refusal.message).toContain(String(overCap.length));

    // EXACTLY AT THE CAP IS FINE. A cap that is off by one is a cap nobody can write against.
    const atCap = 'y'.repeat(ORDER_TASK_MAX_CHARS);
    const ok = await create(roomId, atCap);
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error('unreachable');
    const stored = await orderById(pool, roomId, ok.orderId!);
    // Stored WHOLE — a truncated objective is a different objective, so oversize is refused instead.
    expect(stored?.task).toBe(atCap);
  });

  it('stores the task trimmed, on the record and on the creation event', async () => {
    const roomId = await newRoom('st-stored');
    const result = await create(roomId, '  review the newest draft and say what you would cut  ');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const order = await orderById(pool, roomId, result.orderId!);
    expect(order?.task).toBe('review the newest draft and say what you would cut');

    // ON THE EVENT TOO: the record of the authorisation is the record of the ask, because they
    // happened in the same act and can never diverge afterwards.
    const { rows } = await pool.query<{ payload: { task?: string } }>(
      `SELECT payload FROM events WHERE room_id = $1 AND event_type = 'order.created'`,
      [roomId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.task).toBe('review the newest draft and say what you would cut');
  });
});

/**
 * IMMUTABLE BY ABSENCE, asserted against the SOURCE — the same way UI3-1's wiring rule is enforced.
 *
 * A test that called an update path with a task and expected a refusal would prove the guard works;
 * this proves there is nothing to guard. If someone adds `task` to the edit command later, they have
 * to delete an assertion that says, in words, why it must not exist.
 */
describe('nothing can change an order’s task', () => {
  const SRC = resolve(import.meta.dirname, '..', 'src');
  const orderCommand = readFileSync(resolve(SRC, 'commands', 'order.ts'), 'utf8');
  const orders = readFileSync(resolve(SRC, 'orders.ts'), 'utf8');

  it('the edit command takes no task parameter, and its event carries none', () => {
    const update = orderCommand.slice(
      orderCommand.indexOf('export async function updateOrderCommand'),
    );
    // The input block of updateOrderCommand — where a task field would have to appear.
    const inputBlock = update.slice(0, update.indexOf('): Promise<OrderResult>'));
    expect(inputBlock).not.toContain('task');
    // ...and the before/after the edit event carries names only the three editable terms.
    const beforeAfter = update.slice(
      update.indexOf('const before ='),
      update.indexOf('deps.bus.publish'),
    );
    expect(beforeAfter).not.toContain('task');
  });

  it('the projection writer has no UPDATE that touches the task column', () => {
    // Every UPDATE against standing_orders in the record layer, checked for the column. Counters,
    // status and the three terms are written; the task is written once, by the INSERT, and never again.
    const updates = orders.match(/UPDATE standing_orders[\s\S]*?(?=`)/g) ?? [];
    expect(updates.length).toBeGreaterThan(0);
    for (const stmt of updates)
      expect(stmt, `an UPDATE writes task:\n${stmt}`).not.toContain('task');
  });

  it('the runner READS the task and has no way to write one', () => {
    const runner = readFileSync(resolve(SRC, 'commands', 'runOrders.ts'), 'utf8');
    expect(runner, 'the runner never reads the objective it is supposed to carry').toContain(
      'order.task',
    );
    // The loop is the one place a task is used every cycle, and therefore the most tempting place to
    // "just correct" one. It writes orders through `setOrderStatus` and `stopOrder` only.
    expect(runner).not.toContain('UPDATE standing_orders');
    // It writes an order's STATUS (that is what a self-stop is) and nothing else about it: no row
    // insert, no config write. `task ===` reads it; there is no `task =` to be found.
    expect(runner).not.toContain('createOrderRow');
    expect(runner).not.toContain('updateOrderConfig');
  });
});

/**
 * AN ORDER THAT PREDATES TASKS REFUSES TO FIRE, OUT LOUD.
 *
 * Only migration-027-era rows can be in this state: creation refuses a missing task and nothing edits
 * one in. There is no honest way to run such an order — an objective cannot be inferred from a trigger
 * and an action member — so it stops rather than firing an empty cycle, and it says why. The row is
 * written with raw SQL here because the command it would otherwise go through is exactly the thing
 * that now refuses it: this is the shape of a row that already exists in a database, not a new one.
 */
describe('a pre-existing order with no task refuses to fire', () => {
  it('pauses, names the rule, and runs no cycle', async () => {
    const roomId = await newRoom('st-legacy');
    const orderId = `ord_legacy_${Date.now()}`;
    await pool.query(
      `INSERT INTO standing_orders
         (id, room_id, creator_member_id, trigger_event_type, trigger_member_id, action_member_id,
          max_cycles, max_unattended_cycles, expires_at, task)
       VALUES ($1, $2, 'prince', 'agent.turn.completed', 'sol', 'claude-main', NULL, 3, NULL, NULL)`,
      [orderId, roomId],
    );

    await executeCommand(
      { actorId: 'system', mode: 'system' },
      { kind: 'runOrders', roomId, member: 'sol', completedSeq: 1000, success: true },
      deps,
    );

    const deadline = Date.now() + 15000;
    let row: { status: string; pause_reason: string | null } | undefined;
    for (;;) {
      const { rows } = await pool.query<{ status: string; pause_reason: string | null }>(
        `SELECT status, pause_reason FROM standing_orders WHERE id = $1`,
        [orderId],
      );
      row = rows[0];
      if (row?.status === 'PAUSED' || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(row?.status, 'a task-less order stayed active').toBe('PAUSED');
    // NAMES THE RULE AND THE FIX — not "something went wrong", and not silence.
    expect(row?.pause_reason).toMatch(/no task/);
    expect(row?.pause_reason).toMatch(/create a new order/);

    // AND IT RAN NOTHING: no cycle, no summon, no turn. It stopped before the cycle opened, so
    // nothing was spent discovering that there was nothing to do.
    const { rows: cycles } = await pool.query(
      `SELECT seq FROM events WHERE room_id = $1 AND event_type = 'order.cycled'`,
      [roomId],
    );
    expect(cycles).toHaveLength(0);
    const { rows: turns } = await pool.query(
      `SELECT seq FROM events WHERE room_id = $1 AND event_type LIKE 'agent.turn.%'`,
      [roomId],
    );
    expect(turns).toHaveLength(0);
  });
});
