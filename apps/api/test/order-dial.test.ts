import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentTurnChunk } from '@playroom/shared';
import { ERROR_ORDER_UNBOUNDED_DIAL } from '@playroom/shared';
import { dropRoomQuiesced, testPool, uniqueRoomId } from './support.js';
import { RoomBus } from '../src/bus.js';
import { appendAgentEvent, appendMessage, appendSummon, createRoom } from '../src/events.js';
import { ensureTask } from '../src/tasks.js';
import { executeCommand, type CommandDeps } from '../src/commands/index.js';

/**
 * ═══ S-DIAL — THE GATE LIFTS, AND WHAT REPLACES IT (SD-3) ═══
 *
 * `max_unattended_cycles` was gated at 1 because a raised hand reached nobody whose room was closed
 * (SL2-N4). Prince observed one arrive on 15 Aug 2026 with the app closed, so the gate is lifted —
 * BY THAT OBSERVATION, recorded in p0-claims.md, not by this code and not by a brief.
 *
 * LIFTING IT REMOVES A BOUND, and that is what this file is really about. At a dial of 1 the
 * check-in WAS the end: a person saw every cycle before the next ran. Above 1, an order needs
 * something that actually STOPS — a count or a clock. The daily ceiling is the wrong shape: it pauses
 * and resumes at midnight, which makes an unbounded loop one that never finishes.
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
  await pool.query(
    "DELETE FROM events WHERE event_type IN ('interrupt.raised', 'interrupt.downgraded')",
  );
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

interface Terms {
  dial: number;
  maxCycles?: number | null;
  expiresAt?: string | null;
}
async function create(roomId: string, terms: Terms) {
  return executeCommand(
    { actorId: 'prince', mode: 'human' },
    {
      kind: 'createOrder',
      roomId,
      clientMsgId: `oc-${roomId}-${terms.dial}-${Date.now()}`,
      triggerEventType: 'agent.turn.completed',
      triggerMember: 'sol',
      actionMember: 'claude-main',
      task: 'review the newest draft and say what you would cut',
      maxCycles: terms.maxCycles ?? null,
      maxUnattendedCycles: terms.dial,
      expiresAt: terms.expiresAt ?? null,
    },
    deps,
  );
}

async function trigger(roomId: string, tag: string): Promise<number> {
  const kick = await appendMessage(pool, roomId, 'prince', `kick-${roomId}-${tag}`, '@sol go');
  const { task } = await ensureTask(pool, {
    roomId,
    assignee: 'sol',
    state: 'working',
    action: null,
    intent: 'the cycle before this one',
    createdBy: 'prince',
    causeSeq: kick.seq,
  });
  await appendSummon(
    pool,
    roomId,
    { task_id: task.id },
    {
      summon_id: `trig-${roomId}-${tag}`,
      member: 'sol',
      requested_by: 'prince',
      root_actor: 'prince',
      root_is_human: true,
      depth: 0,
      cause_seq: kick.seq,
    },
  );
  const completed = await appendAgentEvent(
    pool,
    roomId,
    'sol',
    { summon_id: `trig-${roomId}-${tag}` },
    { task_id: task.id },
    'agent.turn.completed',
    {
      turn_id: `trig-turn-${roomId}-${tag}`,
      adapter_id: 'sol',
      text: 'the draft this cycle reviews',
      success: true,
      tokens_in: 5,
      tokens_out: 5,
      cost_usd: 0,
      error_class: null,
    },
    {
      adapter_id: 'sol',
      tokens_in: 5,
      tokens_out: 5,
      cost_usd: 0,
      latency_ms: 10,
      prompt_hash: null,
      success: true,
      error_class: null,
      timings: null,
    },
  );
  return completed.seq;
}
async function fire(roomId: string, seq: number): Promise<void> {
  await executeCommand(
    { actorId: 'system', mode: 'system' },
    { kind: 'runOrders', roomId, member: 'sol', completedSeq: seq, success: true },
    deps,
  );
}
async function order(orderId: string) {
  const { rows } = await pool.query<{ status: string; pause_reason: string | null }>(
    'SELECT status, pause_reason FROM standing_orders WHERE id = $1',
    [orderId],
  );
  return rows[0];
}
async function until(orderId: string, pred: (s: string) => boolean, ms = 15000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred((await order(orderId)).status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('the dial may exceed 1 now, and an order above 1 must say when it ends', () => {
  it('accepts a raised dial WITH a cycle cap, and WITH an expiry', async () => {
    const roomId = await newRoom('sd3-bounded');
    const withCap = await create(roomId, { dial: 5, maxCycles: 10 });
    expect(withCap.ok, 'a bounded raised dial was refused').toBe(true);
    const withExpiry = await create(roomId, {
      dial: 5,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(withExpiry.ok, 'an expiring raised dial was refused').toBe(true);
  });

  it('REFUSES a raised dial with neither, and names what to add', async () => {
    const roomId = await newRoom('sd3-unbounded');
    const r = await create(roomId, { dial: 5 });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.refusal.code).toBe(ERROR_ORDER_UNBOUNDED_DIAL);
    expect(r.refusal.message).toMatch(/cycle cap or an expiry/);
    // THE CEILING IS NAMED AS NOT COUNTING, because it is the thing a reader would reach for: it
    // pauses at midnight and resumes, so it never ends a loop.
    expect(r.refusal.message).toMatch(/ceiling pauses a loop, it does not end one/);

    const { rows } = await pool.query('SELECT id FROM standing_orders WHERE room_id = $1', [
      roomId,
    ]);
    expect(rows, 'an unbounded raised-dial order was written anyway').toHaveLength(0);
  });

  it('a dial of 1 still needs nothing — the check-in IS the bound there', async () => {
    const roomId = await newRoom('sd3-dial1');
    const r = await create(roomId, { dial: 1 });
    expect(r.ok, 'the rule fired at a dial where the check-in is the bound').toBe(true);
  });

  it('and the EDIT path cannot raise the dial past its bounds either', async () => {
    const roomId = await newRoom('sd3-edit');
    const created = await create(roomId, { dial: 1 });
    if (!created.ok) throw new Error('setup failed');

    // Raising the dial alone: refused.
    const bad = await executeCommand(
      { actorId: 'prince', mode: 'human' },
      {
        kind: 'updateOrder',
        roomId,
        clientMsgId: `up-${roomId}-bad`,
        orderId: created.orderId!,
        maxCycles: null,
        maxUnattendedCycles: 6,
        expiresAt: null,
      },
      deps,
    );
    expect(bad.ok, 'an edit walked around the rule the create path enforces').toBe(false);
    if (bad.ok) throw new Error('unreachable');
    expect(bad.refusal.code).toBe(ERROR_ORDER_UNBOUNDED_DIAL);

    // Raising it AND adding a cap in the same edit: allowed, because the result is bounded.
    const good = await executeCommand(
      { actorId: 'prince', mode: 'human' },
      {
        kind: 'updateOrder',
        roomId,
        clientMsgId: `up-${roomId}-good`,
        orderId: created.orderId!,
        maxCycles: 4,
        maxUnattendedCycles: 6,
        expiresAt: null,
      },
      deps,
    );
    expect(good.ok).toBe(true);
  });
});

describe('every bound still binds at a raised dial, and names which one fired', () => {
  it('MAX CYCLES → LIMIT_REACHED, naming the count', async () => {
    const roomId = await newRoom('sd3-cap');
    const created = await create(roomId, { dial: 5, maxCycles: 1 });
    if (!created.ok) throw new Error('setup failed');
    await fire(roomId, await trigger(roomId, 'a'));
    await until(created.orderId!, (s) => s === 'LIMIT_REACHED');
    const o = await order(created.orderId!);
    expect(o.status).toBe('LIMIT_REACHED');
    expect(o.pause_reason).toMatch(/1 cycle\b/);
  });

  it('EXPIRY → EXPIRED, before any cycle opens', async () => {
    const roomId = await newRoom('sd3-expiry');
    const created = await create(roomId, { dial: 5, expiresAt: '2020-01-01T00:00:00.000Z' });
    if (!created.ok) throw new Error('setup failed');
    await fire(roomId, await trigger(roomId, 'a'));
    await until(created.orderId!, (s) => s === 'EXPIRED');
    expect((await order(created.orderId!)).status).toBe('EXPIRED');
    const { rows } = await pool.query(
      `SELECT seq FROM events WHERE room_id = $1 AND event_type = 'order.cycled'`,
      [roomId],
    );
    expect(rows).toHaveLength(0);
  });

  it('THE CEILING → PAUSED naming the ceiling, and no turn runs', async () => {
    const prev = process.env.PLAYROOM_DAILY_USD_CEILING;
    process.env.PLAYROOM_DAILY_USD_CEILING = '0';
    try {
      const roomId = await newRoom('sd3-ceiling');
      const created = await create(roomId, { dial: 5, maxCycles: 10 });
      if (!created.ok) throw new Error('setup failed');
      await fire(roomId, await trigger(roomId, 'a'));
      await until(created.orderId!, (s) => s === 'PAUSED');
      const o = await order(created.orderId!);
      expect(o.status).toBe('PAUSED');
      expect(o.pause_reason).toMatch(/ceiling/);
    } finally {
      if (prev === undefined) delete process.env.PLAYROOM_DAILY_USD_CEILING;
      else process.env.PLAYROOM_DAILY_USD_CEILING = prev;
    }
  });

  it('AN ERROR TERMINAL → PAUSED, wearing the failure’s class', async () => {
    const roomId = await newRoom('sd3-error');
    const created = await create(roomId, { dial: 5, maxCycles: 10 });
    if (!created.ok) throw new Error('setup failed');
    await executeCommand(
      { actorId: 'system', mode: 'system' },
      {
        kind: 'runOrders',
        roomId,
        member: 'claude-main',
        completedSeq: 1000,
        success: false,
        orderId: created.orderId!,
        errorClass: 'ProviderTimeout',
      },
      deps,
    );
    await until(created.orderId!, (s) => s === 'PAUSED');
    expect((await order(created.orderId!)).pause_reason).toMatch(/ProviderTimeout/);
  });

  it('THE DEPTH CAP → refused out loud, unchanged by the dial', async () => {
    const roomId = await newRoom('sd3-depth');
    const created = await create(roomId, { dial: 5, maxCycles: 10 });
    if (!created.ok) throw new Error('setup failed');
    await executeCommand(
      { actorId: 'claude-main', mode: 'hosted' },
      {
        kind: 'summon',
        roomId,
        member: 'sol',
        causeSeq: 1,
        intent: 'a summoned agent tries to start another summon',
        chain: { rootActor: 'prince', rootIsHuman: true, depth: 1 },
      },
      deps,
    );
    await new Promise((r) => setTimeout(r, 300));
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM events WHERE room_id = $1 AND event_type = 'message'
        AND actor_id = 'system' AND payload ->> 'body' LIKE '%may not start another summon%'`,
      [roomId],
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it('MAX_ACTIONS_PER_TURN is a per-TURN bound and the dial cannot reach it', async () => {
    // Asserted structurally rather than re-run: the cap lives in agent.ts and counts emissions
    // within ONE turn, so it is untouched by how often a loop checks in. `action-channel.test.ts`
    // exercises the refusal itself; what matters here is that nothing about the dial is in scope.
    const { MAX_ACTIONS_PER_TURN } = await import('../src/agent.js');
    expect(MAX_ACTIONS_PER_TURN).toBe(8);
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const agent = readFileSync(resolve(import.meta.dirname, '..', 'src', 'agent.ts'), 'utf8');
    const capBlock = agent.slice(agent.indexOf('MAX_ACTIONS_PER_TURN = '));
    expect(capBlock).not.toContain('max_unattended');
  });
});
