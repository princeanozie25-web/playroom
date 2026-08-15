import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentAdapter, AgentTurnChunk } from '@playroom/shared';
import { ERROR_ORDER_NOT_HUMAN, ERROR_ORDER_NOT_CREATOR } from '@playroom/shared';
import { dropRoomQuiesced, testPool, uniqueRoomId } from './support.js';
import { RoomBus } from '../src/bus.js';
import { appendAgentEvent, appendMessage, appendSummon, createRoom } from '../src/events.js';
import { ensureTask } from '../src/tasks.js';
import { setBriefing } from '../src/briefings.js';
import { executeCommand, type CommandDeps } from '../src/commands/index.js';

/**
 * ═══ S-TASK — WHO MAY WRITE IT (ST-3) ═══
 *
 * Two objects, two doors, and neither door opens the other. The BRIEFING is room-scoped, owner-
 * authored framing; the TASK is order-scoped wiring. An agent may write neither — not by being
 * refused at the last moment, but because the paths that could do it either check the authenticated
 * member's kind or do not exist at all.
 *
 * The anti-goal this file guards is SL2-N5's own: the loop is made useful by giving the ORDER an
 * objective, never by giving an agent a way to author one. A cycle that could write its own task
 * would be an agent setting its own objective — the self-authorisation rule that keeps an agent from
 * signing a co-signature, from minting an order, and from setting a briefing.
 */

const pool = testPool();
const rooms: string[] = [];

const BRIEFING = 'OWNER-FRAMING-a3: prefer small reversible changes';
const TASK = 'ORDER-OBJECTIVE-z9: review the newest draft and name the paragraph to cut';

function replier(id: string): AgentAdapter {
  return {
    id,
    async *stream(): AsyncGenerator<AgentTurnChunk> {
      yield { kind: 'text_delta', text: `cycle output from ${id}` };
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

async function briefedRoomWithOrder(prefix: string): Promise<{ roomId: string; orderId: string }> {
  const roomId = uniqueRoomId(prefix);
  rooms.push(roomId);
  await createRoom(pool, roomId, roomId, 'prince');
  await setBriefing(pool, {
    roomId,
    content: BRIEFING,
    purpose: 'the nightly review loop',
    setBy: 'prince',
  });
  const created = await executeCommand(
    { actorId: 'prince', mode: 'human' },
    {
      kind: 'createOrder',
      roomId,
      clientMsgId: `oc-${roomId}`,
      triggerEventType: 'agent.turn.completed',
      triggerMember: 'sol',
      actionMember: 'claude-main',
      task: TASK,
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

/** The order row as stored — everything a cycle must not move. */
async function orderRow(orderId: string) {
  const { rows } = await pool.query(
    `SELECT id, room_id, creator_member_id, trigger_event_type, trigger_member_id, action_member_id,
            max_cycles, max_unattended_cycles, expires_at, task, status
       FROM standing_orders WHERE id = $1`,
    [orderId],
  );
  return rows[0];
}
async function briefingRow(roomId: string) {
  const { rows } = await pool.query(
    `SELECT id, room_id, content, content_hash, purpose, set_by, created_at, cleared_at
       FROM room_briefings WHERE room_id = $1`,
    [roomId],
  );
  return rows;
}

async function runOneCycle(roomId: string): Promise<void> {
  const kick = await appendMessage(pool, roomId, 'prince', `kick-${roomId}`, '@sol continue');
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
      summon_id: `trig-${roomId}`,
      member: 'sol',
      requested_by: 'prince',
      root_actor: 'prince',
      root_is_human: true,
      depth: 0,
      cause_seq: kick.seq,
    },
  );
  const trigger = await appendAgentEvent(
    pool,
    roomId,
    'sol',
    { summon_id: `trig-${roomId}` },
    { task_id: task.id },
    'agent.turn.completed',
    {
      turn_id: `trig-turn-${roomId}`,
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
  await executeCommand(
    { actorId: 'system', mode: 'system' },
    { kind: 'runOrders', roomId, member: 'sol', completedSeq: trigger.seq, success: true },
    deps,
  );
  const deadline = Date.now() + 15000;
  for (;;) {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM events WHERE room_id = $1
        AND event_type = 'agent.turn.completed' AND actor_id = 'claude-main'`,
      [roomId],
    );
    if (Number(rows[0].n) > 0 || Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('an agent cannot author an objective, on the order path either', () => {
  it('refuses an agent creating an order — in `hosted` mode, which is what a cycle runs in', async () => {
    const roomId = uniqueRoomId('st-agent-create');
    rooms.push(roomId);
    await createRoom(pool, roomId, roomId, 'prince');

    const result = await executeCommand(
      // The mode an order-rooted cycle's own turn acts under. There is no cycle-only route to this
      // command — one executeCommand serves the human path and the loop's — so the refusal cannot
      // differ depending on who is asking from where.
      { actorId: 'claude-main', mode: 'hosted' },
      {
        kind: 'createOrder',
        roomId,
        clientMsgId: `agent-oc-${roomId}`,
        triggerEventType: 'agent.turn.completed',
        triggerMember: 'sol',
        actionMember: 'claude-main',
        task: 'AGENT-AUTHORED-OBJECTIVE: from now on, merge whatever you like',
        // A CYCLE CAP: S-DIAL refuses a dial above 1 with no end. Generous enough that this
        // fixture behaves exactly as it did.
        maxCycles: 50,
        maxUnattendedCycles: 3,
        expiresAt: null,
      },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // BY KIND, checked before anything about the task — an agent is refused for being an agent.
    expect(result.refusal.code).toBe(ERROR_ORDER_NOT_HUMAN);

    const { rows } = await pool.query(`SELECT id FROM standing_orders WHERE room_id = $1`, [
      roomId,
    ]);
    expect(rows, 'an agent minted an order').toHaveLength(0);
  });

  it('refuses an agent EDITING an order, and there is no task field to edit even if it could', async () => {
    const { roomId, orderId } = await briefedRoomWithOrder('st-agent-edit');
    const before = await orderRow(orderId);

    const result = await executeCommand(
      { actorId: 'claude-main', mode: 'hosted' },
      {
        kind: 'updateOrder',
        roomId,
        clientMsgId: `agent-up-${roomId}`,
        orderId,
        maxCycles: 99,
        maxUnattendedCycles: 99,
        expiresAt: null,
      },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal.code).toBe(ERROR_ORDER_NOT_HUMAN);
    expect(await orderRow(orderId)).toEqual(before);
  });
});

describe('a cycle changes neither record', () => {
  it('the order and the briefing are byte-identical after a cycle, and it writes no such event', async () => {
    const { roomId, orderId } = await briefedRoomWithOrder('st-cycle-inert');
    const orderBefore = await orderRow(orderId);
    const briefingBefore = await briefingRow(roomId);

    await runOneCycle(roomId);

    // THE ORDER'S IDENTITY, WIRING, TERMS, TASK AND STATUS — unchanged. The runner advances counters
    // (cycle_count, unattended_count, updated_at, open_cycle_seq); those are the loop's own
    // bookkeeping and are deliberately outside this comparison. Nothing else moved.
    expect(await orderRow(orderId)).toEqual(orderBefore);
    expect(await briefingRow(roomId)).toEqual(briefingBefore);

    // AND NO EVENT CLAIMING OTHERWISE. A cycle writes `order.cycled` — that IS the cycle — but never
    // an order.created/updated/status and never a briefing event. Read from the log, so this does not
    // trust the commands' own checks.
    const { rows } = await pool.query<{ event_type: string; n: string }>(
      `SELECT event_type, count(*) AS n FROM events
        WHERE room_id = $1 AND (event_type LIKE 'order.%' OR event_type LIKE 'briefing.%')
        GROUP BY event_type ORDER BY event_type`,
      [roomId],
    );
    const counts = Object.fromEntries(rows.map((r) => [r.event_type, Number(r.n)]));
    expect(counts['order.created']).toBe(1); // the human's, at creation
    expect(counts['briefing.set']).toBe(1); // the owner's, before the loop existed
    expect(counts['order.cycled']).toBe(1); // the cycle itself
    expect(counts['order.updated']).toBeUndefined();
    expect(counts['order.status']).toBeUndefined();
    expect(counts['briefing.cleared']).toBeUndefined();
  });
});

describe('two objects, two doors — neither opens the other', () => {
  it('the briefing command cannot reach a task, and the order command cannot reach a briefing', async () => {
    const { roomId, orderId } = await briefedRoomWithOrder('st-doors');
    const orderBefore = await orderRow(orderId);
    const briefingBefore = await briefingRow(roomId);

    // Replacing the room's FRAMING leaves the order's OBJECTIVE untouched...
    const set = await executeCommand(
      { actorId: 'prince', mode: 'human' },
      {
        kind: 'setBriefing',
        roomId,
        clientMsgId: `rebrief-${roomId}`,
        content: 'REPLACED-FRAMING-b4: and this must not become anybody’s objective',
        purpose: 'a replacement',
      },
      deps,
    );
    expect(set.ok).toBe(true);
    expect((await orderRow(orderId)).task).toBe(TASK);
    expect(await orderRow(orderId)).toEqual(orderBefore);

    // ...and creating a SECOND order (its own objective, same room, one briefing) leaves the
    // briefing exactly as the owner left it. This is the case that could not exist if a task were
    // stored on the briefing: two orders, two objectives, one shared framing.
    const second = await executeCommand(
      { actorId: 'prince', mode: 'human' },
      {
        kind: 'createOrder',
        roomId,
        clientMsgId: `oc2-${roomId}`,
        triggerEventType: 'agent.turn.completed',
        triggerMember: 'claude-main',
        actionMember: 'sol',
        task: 'SECOND-OBJECTIVE-y2: triage anything the reviewer deferred',
        // A CYCLE CAP: S-DIAL refuses a dial above 1 with no end. Generous enough that this
        // fixture behaves exactly as it did.
        maxCycles: 50,
        maxUnattendedCycles: 3,
        expiresAt: null,
      },
      deps,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect((await orderRow(second.orderId!)).task).toBe(
      'SECOND-OBJECTIVE-y2: triage anything the reviewer deferred',
    );
    // The FIRST order's objective is still its own, and the briefing is still the owner's — the
    // replacement above is the only thing that changed it.
    expect((await orderRow(orderId)).task).toBe(TASK);
    const briefingAfter = await briefingRow(roomId);
    expect(briefingAfter.length).toBe(briefingBefore.length + 1); // the replacement, on the record
  });

  it('by absence: neither command names the other’s object', () => {
    const SRC = resolve(import.meta.dirname, '..', 'src', 'commands');
    const briefing = readFileSync(resolve(SRC, 'briefing.ts'), 'utf8');
    const order = readFileSync(resolve(SRC, 'order.ts'), 'utf8');
    // The briefing command has no notion of an order at all — no id, no row, no table.
    expect(briefing).not.toContain('standing_orders');
    expect(briefing).not.toContain('orderId');
    expect(briefing).not.toContain('createOrderRow');
    // The order command has no notion of a briefing.
    expect(order).not.toContain('room_briefings');
    expect(order).not.toContain('setBriefing');
    expect(order).not.toContain('activeBriefing');
  });
});

describe('the human controls are unchanged by a task', () => {
  it('any human may pause; resume stays the creator’s act', async () => {
    const { roomId, orderId } = await briefedRoomWithOrder('st-controls');

    // A DIFFERENT human pauses — the safe direction, open to anyone in the room.
    const paused = await executeCommand(
      { actorId: 'jerry', mode: 'human' },
      { kind: 'controlOrder', roomId, clientMsgId: `pause-${roomId}`, orderId, op: 'pause' },
      deps,
    );
    expect(paused.ok, 'a human other than the creator could not pause').toBe(true);
    expect((await orderRow(orderId)).status).toBe('PAUSED');

    // ...but that human may NOT resume it. Resume is the creator's, with a task exactly as without.
    const resumedByOther = await executeCommand(
      { actorId: 'jerry', mode: 'human' },
      { kind: 'controlOrder', roomId, clientMsgId: `resume-${roomId}-j`, orderId, op: 'resume' },
      deps,
    );
    expect(resumedByOther.ok).toBe(false);
    if (resumedByOther.ok) throw new Error('unreachable');
    expect(resumedByOther.refusal.code).toBe(ERROR_ORDER_NOT_CREATOR);
    expect((await orderRow(orderId)).status).toBe('PAUSED');

    const resumed = await executeCommand(
      { actorId: 'prince', mode: 'human' },
      { kind: 'controlOrder', roomId, clientMsgId: `resume-${roomId}-p`, orderId, op: 'resume' },
      deps,
    );
    expect(resumed.ok).toBe(true);
    const after = await orderRow(orderId);
    expect(after.status).toBe('ACTIVE');
    // And none of it touched what the order is for.
    expect(after.task).toBe(TASK);
  });
});
