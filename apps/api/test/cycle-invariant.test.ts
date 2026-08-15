import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentAdapter, AgentTurnChunk } from '@playroom/shared';
import { dropRoomQuiesced, testPool, uniqueRoomId } from './support.js';
import { RoomBus } from '../src/bus.js';
import { createRoom } from '../src/events.js';
import { executeCommand, type CommandDeps } from '../src/commands/index.js';

/**
 * ═══ S-CYCLE — THE INVARIANT, AND THE CLASS IT HOLDS OVER (SC-2) ═══
 *
 * SC-1 asserted the collision. This asserts the property that collision was one instance of:
 *
 *   FOR ANY ORDER, CYCLES COUNTED = CYCLES THAT PRODUCED A COMPLETED TURN.
 *
 * Checked over a RUN rather than a call, because an invariant verified once is a coincidence. The run
 * below deliberately contains contention — two orders in one room racing the same completion for the
 * same member, which is exactly the shape that produced SD-N1 — and the invariant is read afterwards
 * from the log, per order, with the denominators printed into the failure message.
 *
 * ── AND THE CLASS, ASSERTED AGAINST THE SOURCE ───────────────────────────────────────
 *
 * Six things can stop a summoned turn between an order's trigger and its first token. Rather than one
 * test per escape hatch — which would assert the ones I thought of and say nothing about the seventh —
 * the counter is asserted to have exactly ONE writer, reachable from exactly one place: the seam that
 * has already written `agent.turn.started`. Every refusal upstream of that row is harmless because it
 * is upstream, and a future one will be too.
 */

const pool = testPool();
const rooms: string[] = [];

function replier(id: string): AgentAdapter {
  return {
    id,
    async *stream(): AsyncGenerator<AgentTurnChunk> {
      yield { kind: 'text_delta', text: `from ${id}` };
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

async function makeOrder(roomId: string, tag: string, maxCycles: number): Promise<string> {
  const created = await executeCommand(
    { actorId: 'prince', mode: 'human' },
    {
      kind: 'createOrder',
      roomId,
      clientMsgId: `oc-${roomId}-${tag}`,
      triggerEventType: 'agent.turn.completed',
      // SELF-TRIGGERING, as the live loop is: the action member's own completion is the next
      // cycle's trigger, so the run advances without anything poking it.
      triggerMember: 'claude-main',
      actionMember: 'claude-main',
      task: 'say one word',
      maxCycles,
      maxUnattendedCycles: 20, // out of the way: this run is about counting, not attendance
      expiresAt: null,
    },
    deps,
  );
  if (!created.ok) throw new Error(`order not created: ${JSON.stringify(created)}`);
  return created.orderId!;
}

/** Counted: order.cycled events. Worked: completed turns, attributed through their summon. */
async function countedAndWorked(
  roomId: string,
): Promise<Array<{ order_id: string; counted: number; worked: number }>> {
  const { rows } = await pool.query<{ order_id: string; counted: string; worked: string }>(
    `WITH counted AS (
       SELECT payload ->> 'order_id' AS order_id, count(*) AS n
         FROM events WHERE room_id = $1 AND event_type = 'order.cycled' GROUP BY 1
     ),
     worked AS (
       SELECT s.payload ->> 'order_id' AS order_id, count(DISTINCT t.seq) AS n
         FROM events AS s
         JOIN events AS t ON t.room_id = s.room_id AND t.task_id = s.task_id
                         AND t.event_type = 'agent.turn.completed'
        WHERE s.room_id = $1 AND s.event_type = 'summon' AND s.payload ->> 'order_id' IS NOT NULL
        GROUP BY 1
     )
     SELECT coalesce(c.order_id, w.order_id) AS order_id,
            coalesce(c.n, 0)::text AS counted, coalesce(w.n, 0)::text AS worked
       FROM counted AS c FULL OUTER JOIN worked AS w ON w.order_id = c.order_id`,
    [roomId],
  );
  return rows.map((r) => ({
    order_id: r.order_id,
    counted: Number(r.counted),
    worked: Number(r.worked),
  }));
}

async function statuses(roomId: string): Promise<Array<{ order_id: string; status: string }>> {
  const { rows } = await pool.query<{ order_id: string; status: string }>(
    `SELECT payload ->> 'order_id' AS order_id, payload ->> 'status' AS status
       FROM events WHERE room_id = $1 AND event_type = 'order.status' ORDER BY seq`,
    [roomId],
  );
  return rows;
}

async function settled(roomId: string): Promise<boolean> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM standing_orders WHERE room_id = $1 AND status = 'ACTIVE'`,
    [roomId],
  );
  return Number(rows[0].n) === 0;
}

describe('over a run with contention, a count means a turn', () => {
  it('every order: cycles counted = cycles that produced a completed turn', async () => {
    const roomId = await newRoom('sc-inv');
    // TWO ORDERS, ONE MEMBER, ONE TRIGGER. Every completion fires both, and claude-main can only
    // answer one at a time — so on each round one of them meets a rule that stops it (the runner's
    // deferral, or migration 005's one-summon-per-cause). Under the defect both would have counted.
    await makeOrder(roomId, 'a', 3);
    await makeOrder(roomId, 'b', 3);

    await executeCommand(
      { actorId: 'prince', mode: 'human' },
      { kind: 'postMessage', roomId, clientMsgId: `kick-${roomId}`, body: '@claude-main begin' },
      deps,
    );

    const deadline = Date.now() + 60000;
    while (!(await settled(roomId))) {
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await new Promise((r) => setTimeout(r, 500)); // let any last write land

    const rows = await countedAndWorked(roomId);
    expect(rows.length, 'the run produced no cycles at all — the invariant would be vacuous').toBe(
      2,
    );
    const total = rows.reduce((n, r) => n + r.counted, 0);
    expect(total, 'too few cycles to be a run').toBeGreaterThanOrEqual(3);

    for (const r of rows) {
      expect(
        r.counted,
        `${r.order_id}: counted ${r.counted} cycles but ${r.worked} produced a turn ` +
          `(orders in run: ${rows.length}, cycles counted in run: ${total})`,
      ).toBe(r.worked);
    }

    // ── NO TERMINAL REACHED BY WORKLESS CYCLES ──────────────────────────────────────
    // What made SD-N1 worse than a wrong number: LIMIT_REACHED is what sends a FINISHED, so a cycle
    // that did nothing could tell a person the work was done. Every terminal in this run belongs to
    // an order whose counted cycles all worked — which the loop above has just established.
    const byId = new Map(rows.map((r) => [r.order_id, r]));
    for (const s of await statuses(roomId)) {
      if (s.status !== 'LIMIT_REACHED') continue;
      const r = byId.get(s.order_id)!;
      expect(r.worked, `${s.order_id} reached LIMIT_REACHED with ${r.worked} worked cycles`).toBe(
        r.counted,
      );
      expect(r.worked).toBeGreaterThan(0);
    }
    expect(await settled(roomId), 'the run never settled').toBe(true);
  }, 90000);
});

/**
 * THE CLASS, AGAINST THE SOURCE.
 *
 * Six ways a summoned turn dies between an order's trigger and its first token, all of them upstream
 * of `agent.turn.started`:
 *
 *   1. no usable route              fireSummon returns after a system notice; no summon row
 *   2. a protected summon held      pauseSummonForCoSign — an agent-emitted path only, not a cycle's
 *   3. the summon already exists    migration 005 refuses a second summon for one cause
 *   4. the ceiling moved            runAgentTurn refuses before it costs anything
 *   5. the member is already busy   §22b (SD-N1's instance; SC-1 asserts it directly)
 *   6. a lost race for the row      migration 006's one-turn-per-summon index
 *
 * None of them is asserted one by one here, deliberately: that would cover the six I found and say
 * nothing about a seventh. What is asserted is why they are all harmless — the counter has ONE
 * writer, and it is reachable only from the seam that has already written the started row.
 */
describe('the counter has one writer, downstream of the proof that a turn exists', () => {
  const SRC = resolve(import.meta.dirname, '..', 'src');
  const strip = (t: string): string =>
    t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const read = (f: string): string => strip(readFileSync(resolve(SRC, f), 'utf8'));

  it('exactly one statement increments cycle_count, and it is countCycleStarted', () => {
    const files = ['orders.ts', 'events.ts', 'commands/runOrders.ts', 'commands/order.ts'];
    const writers = files.filter((f) => /cycle_count\s*=\s*cycle_count\s*\+/.test(read(f)));
    expect(writers).toEqual(['orders.ts']);

    const orders = read('orders.ts');
    const fn = orders.slice(orders.indexOf('export async function countCycleStarted'));
    expect(fn).toContain('cycle_count = cycle_count + 1');
    // And the claim half writes NO counter — it consumes the trigger and nothing else.
    const claim = orders.slice(
      orders.indexOf('export async function claimTrigger'),
      orders.indexOf('export async function countCycleStarted'),
    );
    expect(claim).toContain('open_cycle_seq');
    expect(claim).not.toContain('cycle_count');
    expect(claim).not.toContain('unattended_count');
  });

  it('its only caller is the order-cycle-started command, and only the started seam sends that', () => {
    const runner = read('commands/runOrders.ts');
    const callers = ['commands/runOrders.ts', 'commands/summon.ts', 'agent.ts', 'server.ts'].filter(
      (f) => read(f).includes('countCycleStarted('),
    );
    expect(callers).toEqual(['commands/runOrders.ts']);
    // ...inside the command, not inside fireOrderCycle: the runner asks for a turn, it does not
    // record one.
    const fire = runner.slice(
      runner.indexOf('export async function fireOrderCycle'),
      runner.indexOf('export async function orderCycleStartedCommand'),
    );
    expect(fire).not.toContain('countCycleStarted');
    expect(fire).toContain('claimTrigger');

    // THE DISPATCH: one site, in agent.ts, AFTER the started row is published. Positional, because
    // "downstream of the proof" is the whole property — dispatching it earlier would restore the bug
    // with a different shape.
    const agent = read('agent.ts');
    const dispatches = agent.split("kind: 'orderCycleStarted'").length - 1;
    expect(dispatches).toBe(1);
    const started = agent.indexOf("'agent.turn.started'");
    const publishStarted = agent.indexOf('publish(startedEvent)');
    const dispatch = agent.indexOf("kind: 'orderCycleStarted'");
    expect(started).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(publishStarted);
    expect(publishStarted).toBeGreaterThan(started);
  });

  it('the cycled EVENT moved with the count, so the log cannot claim a cycle the counter denies', () => {
    const runner = read('commands/runOrders.ts');
    const fire = runner.slice(
      runner.indexOf('export async function fireOrderCycle'),
      runner.indexOf('export async function orderCycleStartedCommand'),
    );
    const counted = runner.slice(runner.indexOf('export async function orderCycleStartedCommand'));
    expect(fire).not.toContain('appendOrderCycled');
    expect(counted).toContain('appendOrderCycled');
    // And both limits read the counted number, in the same place it is produced.
    expect(counted).toContain('max_cycles');
    expect(counted).toContain('max_unattended_cycles');
    expect(fire).not.toContain('LIMIT_REACHED');
  });

  it('a cycle counts ONCE even though a chain inherits its order id', () => {
    // A turn that emits a summon passes its chain down, and the chain carries `order_id` — so a
    // second turn in the same cycle would look like a second cycle if the count keyed on that. The
    // trigger seq is set at ONE construction site, only at depth 0, and lives outside the chain.
    const summon = read('commands/summon.ts');
    expect(summon).toContain('input.orderId && input.depth === 0 ? input.causeSeq : undefined');
    const chainBlock = summon.slice(summon.indexOf('chain: {'), summon.indexOf('chain: {') + 220);
    expect(chainBlock).not.toContain('orderTriggerSeq');
    const context = read('commands/context.ts');
    const chainType = context.slice(
      context.indexOf('export interface SummonChain'),
      context.indexOf('export type Command'),
    );
    expect(chainType).not.toContain('orderTriggerSeq');
  });

  it('a cycle whose turn RAN and FAILED still counts — work is not success', () => {
    // The other ruling this slice makes, asserted where it would be undone: the count is driven by
    // the STARTED row, so a turn that errored after starting is a cycle. It cost tokens and it is
    // bounded by the cap like any other; counting only successes would let an erroring loop run
    // past its cap with the ceiling as the only remaining bound.
    const agent = read('agent.ts');
    const dispatch = agent.indexOf("kind: 'orderCycleStarted'");
    const completedFail = agent.indexOf('success: false');
    expect(completedFail).toBeGreaterThan(dispatch);
  });
});
