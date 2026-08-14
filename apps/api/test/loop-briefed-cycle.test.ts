import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentMessage, AgentTurnChunk } from '@playroom/shared';
import { testPool, uniqueRoomId } from './support.js';
import { RoomBus } from '../src/bus.js';
import { appendAgentEvent, appendMessage, createRoom } from '../src/events.js';
import { ensureTask } from '../src/tasks.js';
import { setBriefing } from '../src/briefings.js';
import { executeCommand, type CommandDeps } from '../src/commands/index.js';

/**
 * ═══ S-LOOP2 — THE BRIEFED CYCLE RUNS ═══
 *
 * Every piece of the loop existed and the loop had never run: an order-rooted cycle carries the room's
 * recent turns, and `room-turns` was a declared part that neither gate allowed, so the cycle threw
 * §7.1 on its own feature and the order paused wearing a reason that read like a model failure.
 *
 * This asserts the cycle end to end: the order fires on the prior turn, summons its action member, and
 * the BRIEFING is in that cycle's window — by the same assembly the member would get from a human's tag.
 */

const pool = testPool();
const rooms: string[] = [];

/** What each adapter was actually handed, so "the briefing reached the cycle" is read, not assumed. */
interface Handed {
  member: string;
  systemPrompt: string;
  messages: AgentMessage[];
}
let handed: Handed[] = [];

function recorder(id: string): AgentAdapter {
  return {
    id,
    async *stream(messages, opts): AsyncGenerator<AgentTurnChunk> {
      handed.push({
        member: id,
        systemPrompt: opts?.systemPrompt ?? '',
        messages: messages.map((m) => ({ ...m })),
      });
      yield { kind: 'text_delta', text: `cycle output from ${id}` };
      yield { kind: 'done', tokens_in: 5, tokens_out: 3, stop_reason: 'end_turn' };
    },
  };
}

let deps: CommandDeps;
beforeEach(() => {
  handed = [];
  deps = {
    pool,
    bus: new RoomBus(),
    log: { info() {}, warn() {}, error() {} },
    adapterFactory: (id) => recorder(id),
    execute: (ctx, command) => executeCommand(ctx, command, deps),
  };
});

afterEach(async () => {
  for (const room of rooms) {
    await pool.query('DELETE FROM standing_orders WHERE room_id = $1', [room]);
    await pool.query('DELETE FROM events WHERE room_id = $1', [room]);
    await pool.query('DELETE FROM tasks WHERE room_id = $1', [room]);
    await pool.query('DELETE FROM room_briefings WHERE room_id = $1', [room]);
    await pool.query('DELETE FROM room_members WHERE room_id = $1', [room]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [room]);
  }
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

/**
 * THE TRIGGER, WRITTEN THE WAY PRODUCTION WRITES IT: a real completed turn row with text and
 * success — which is exactly what `recentCompletedTurns` reads into the next cycle's window. The
 * suite's existing order tests synthesise `runOrders` without one, which is why this defect survived
 * a green suite.
 */
async function priorCompletedTurn(roomId: string, member: string, text: string): Promise<number> {
  const kick = await appendMessage(pool, roomId, 'prince', `kick-${roomId}`, `@${member} start`);
  const { task } = await ensureTask(pool, {
    roomId,
    assignee: member,
    state: 'working',
    action: null,
    intent: 'the cycle before this one',
    createdBy: 'prince',
    causeSeq: kick.seq,
  });
  const completed = await appendAgentEvent(
    pool,
    roomId,
    member,
    { summon_id: `prior-${roomId}` },
    { task_id: task.id },
    'agent.turn.completed',
    {
      turn_id: `prior-turn-${roomId}`,
      adapter_id: member,
      text,
      success: true,
      tokens_in: 5,
      tokens_out: 5,
      cost_usd: 0,
      error_class: null,
    },
    {
      adapter_id: member,
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

async function makeOrder(roomId: string, trigger: string, action: string): Promise<string> {
  const created = await executeCommand(
    { actorId: 'prince', mode: 'human' },
    {
      kind: 'createOrder',
      roomId,
      clientMsgId: `oc-${roomId}`,
      triggerEventType: 'agent.turn.completed',
      triggerMember: trigger,
      actionMember: action,
      maxCycles: null,
      maxUnattendedCycles: 3,
      expiresAt: null,
    },
    deps,
  );
  if (!created.ok) throw new Error(`order not created: ${JSON.stringify(created)}`);
  return created.orderId!;
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

async function turnsOf(roomId: string, member: string) {
  const { rows } = await pool.query<{ success: boolean; error_class: string | null }>(
    `SELECT success, error_class FROM events
      WHERE room_id = $1 AND actor_id = $2 AND event_type = 'agent.turn.completed'
      ORDER BY seq`,
    [roomId, member],
  );
  return rows;
}

async function orderStatus(roomId: string, orderId: string): Promise<string> {
  const { rows } = await pool.query<{ status: string; stop_reason: string | null }>(
    `SELECT status FROM standing_orders WHERE id = $1 AND room_id = $2`,
    [orderId, roomId],
  );
  return rows[0].status;
}

describe('an order-rooted cycle runs, and the briefing frames it', () => {
  it('fires on the prior turn, summons the action member, and carries the briefing into its window', async () => {
    const roomId = await newRoom('sl2-cycle');
    await setBriefing(pool, {
      roomId,
      content: 'BRIEF-MARKER-9d2: review the draft, and say what you would cut',
      purpose: 'the nightly review loop',
      setBy: 'prince',
    });
    const orderId = await makeOrder(roomId, 'sol', 'claude-main');
    const triggerSeq = await priorCompletedTurn(roomId, 'sol', 'PRIOR-DRAFT-MARKER-4f1');

    await executeCommand(
      { actorId: 'system', mode: 'system' },
      { kind: 'runOrders', roomId, member: 'sol', completedSeq: triggerSeq, success: true },
      deps,
    );

    const turns = await until(
      () => turnsOf(roomId, 'claude-main'),
      (t) => t.length > 0,
    );
    expect(turns.length, 'the cycle never summoned claude-main').toBe(1);
    expect(
      turns[0].error_class,
      'the cycle turn failed instead of running — this is S17-N1 if it names AssemblyInvariantError',
    ).toBeNull();
    expect(turns[0].success).toBe(true);
    expect(await orderStatus(roomId, orderId), 'the order paused instead of cycling').toBe(
      'ACTIVE',
    );

    // THE BRIEFING WAS IN THE CYCLE'S WINDOW — read from what the adapter was handed, not inferred.
    const cycle = handed.find((h) => h.member === 'claude-main');
    expect(cycle, 'no window was handed to the cycle member').toBeDefined();
    const flat = cycle!.messages.map((m) => `${m.author}: ${m.body}`).join('\n');
    expect(flat).toContain('BRIEF-MARKER-9d2');
    // ...and so was the prior turn: the reason room-turns exists.
    expect(flat).toContain('PRIOR-DRAFT-MARKER-4f1');
    // The briefing is FIRST — the framing frames what follows.
    expect(cycle!.messages[0].author).toBe('context/room-briefing');
  });
});
