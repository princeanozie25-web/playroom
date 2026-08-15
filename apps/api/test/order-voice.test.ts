import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentAdapter, AgentTurnChunk } from '@playroom/shared';
import { dropRoomQuiesced, testPool, uniqueRoomId } from './support.js';
import { RoomBus } from '../src/bus.js';
import { appendAgentEvent, appendMessage, appendSummon, createRoom } from '../src/events.js';
import { ensureTask } from '../src/tasks.js';
import { budgetFor, raiseInterrupt } from '../src/interrupts.js';
import { executeCommand, type CommandDeps } from '../src/commands/index.js';

/**
 * ═══ S-DIAL — AN ORDER THAT CANNOT SPEAK MUST NOT CONTINUE (SD-1) ═══
 *
 * S-PUSH built a channel and did not make a loop safe to leave. `interrupts_per_day` is spent per
 * RAISER per day (6), it sits below the 20/hour push throttle, so it bites first — and an order's own
 * stop-interrupt is charged to its ACTION MEMBER, the same member whose cycles run. A loop at a raised
 * dial could therefore spend its whole voice and keep running with no way to tell anyone anything.
 *
 * THE FIX IS NOT A BIGGER BUDGET. It fails closed, in ADR-001's shape: when the thing that governs is
 * unavailable, the action does not proceed.
 */

const pool = testPool();
const rooms: string[] = [];
const ACTION_MEMBER = 'claude-main';

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
  await pool.query("DELETE FROM interrupts WHERE room_id LIKE 'sd1-%'");
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

async function makeOrder(roomId: string, maxUnattended = 3): Promise<string> {
  const created = await executeCommand(
    { actorId: 'prince', mode: 'human' },
    {
      kind: 'createOrder',
      roomId,
      clientMsgId: `oc-${roomId}`,
      triggerEventType: 'agent.turn.completed',
      triggerMember: 'sol',
      actionMember: ACTION_MEMBER,
      task: 'review the newest draft and say what you would cut',
      maxCycles: null,
      maxUnattendedCycles: maxUnattended,
      expiresAt: null,
    },
    deps,
  );
  if (!created.ok) throw new Error(`order not created: ${JSON.stringify(created)}`);
  return created.orderId!;
}

/** A real completed turn by the trigger member — rooted, the way production writes it. */
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
async function cycles(roomId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM events WHERE room_id = $1 AND event_type = 'order.cycled'`,
    [roomId],
  );
  return Number(rows[0].n);
}

/** Spend the action member's whole voice, the way a loop would: real raises, real charges. */
async function spendTheVoice(roomId: string): Promise<void> {
  const before = await budgetFor(pool, ACTION_MEMBER);
  const limit = before.limit ?? 6;
  for (let i = 0; i < limit; i++) {
    const r = await raiseInterrupt(pool, {
      roomId,
      urgency: 'DECISION',
      raisedBy: ACTION_MEMBER,
      addressedTo: 'prince',
      aboutKind: 'decision',
      aboutId: `sd1-spend-${i}-${Date.now()}`,
      summary: 'a claim that spends the budget, exactly as a co-signature would',
    });
    if (!r.ok) break;
  }
  const after = await budgetFor(pool, ACTION_MEMBER);
  expect(after.remaining, 'the fixture did not actually exhaust the budget').toBe(0);
}

describe('a loop whose voice is spent does not keep running', () => {
  it('pauses BEFORE the cycle opens, names the rule, and fires nothing', async () => {
    const roomId = await newRoom('sd1-voice');
    const orderId = await makeOrder(roomId);
    await spendTheVoice(roomId);

    await fire(roomId, await trigger(roomId, 'a'));
    const deadline = Date.now() + 15000;
    while ((await order(orderId)).status === 'ACTIVE' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const o = await order(orderId);
    expect(o.status, 'a voiceless order kept running').toBe('PAUSED');
    // NAMES THE RULE AND WHOSE VOICE IT WAS.
    expect(o.pause_reason).toMatch(/interrupt budget/);
    expect(o.pause_reason).toContain(ACTION_MEMBER);
    expect(o.pause_reason).toMatch(/cannot speak/);

    // NOTHING RAN. It is a PRE-OPEN gate: no cycle, and therefore no paid turn spent producing work
    // nobody could be told about.
    expect(await cycles(roomId), 'a cycle opened past a spent voice').toBe(0);
    const { rows: turns } = await pool.query(
      `SELECT seq FROM events WHERE room_id = $1 AND event_type LIKE 'agent.turn.%'
        AND actor_id = $2`,
      [roomId, ACTION_MEMBER],
    );
    expect(turns).toHaveLength(0);
  });

  it('and it fires normally while the voice remains', async () => {
    const roomId = await newRoom('sd1-ok');
    const orderId = await makeOrder(roomId);
    await fire(roomId, await trigger(roomId, 'a'));
    const deadline = Date.now() + 15000;
    while ((await cycles(roomId)) === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(await cycles(roomId), 'the gate refused an order that still had a voice').toBe(1);
    expect((await order(orderId)).status).toBe('ACTIVE');
  });
});

describe('a failed telling is returned, never swallowed', () => {
  const SRC = resolve(import.meta.dirname, '..', 'src', 'commands');
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('both interrupt-raising helpers report what happened to their caller', () => {
    // THE SILENT SITE PHASE 0 WENT LOOKING FOR was `raiseDecisionInterrupts`: it returned void, so a
    // decision could be written, a summon held, the claim refused for budget, and the turn end
    // normally — and the completion would fire the NEXT cycle of a loop whose signature request
    // nobody had been told about. Both helpers now return counts.
    const cosign = strip(readFileSync(resolve(SRC, 'coSign.ts'), 'utf8'));
    const runner = strip(readFileSync(resolve(SRC, 'runOrders.ts'), 'utf8'));
    for (const [name, body] of [
      ['raiseDecisionInterrupts', cosign],
      ['raiseOrderInterrupts', runner],
    ] as const) {
      const at = body.indexOf(`function ${name}`);
      expect(at, `${name} is gone`).toBeGreaterThan(-1);
      // Slice to the END OF THE RETURN-TYPE LINE, not to the next '{' — the first brace after
      // "): Promise<" is the one INSIDE `Promise<{ told: ... }>`, so the naive cut ended before the
      // very field being asserted. (It did, in the first version of this test.)
      const ret = body.indexOf('): Promise<', at);
      const sig = body.slice(at, body.indexOf('\n', ret));
      expect(sig, `${name} still returns void — a refusal there is invisible`).not.toContain(
        'Promise<void>',
      );
      expect(sig).toContain('refusedForBudget');
    }
  });

  it('the runner’s voice gate sits BEFORE the cycle opens, next to expiry and the ceiling', () => {
    const runner = strip(readFileSync(resolve(SRC, 'runOrders.ts'), 'utf8'));
    const gate = runner.indexOf('budgetFor(deps.pool, order.action_member_id)');
    const open = runner.indexOf('tryOpenCycle(');
    const summon = runner.indexOf('fireSummon(');
    expect(gate).toBeGreaterThan(-1);
    // Before the atomic open, and therefore before anything is spent.
    expect(gate).toBeLessThan(open);
    expect(gate).toBeLessThan(summon);
  });

  it('the budget was NOT raised to fix this — the mandates still say 6', () => {
    // The anti-goal, asserted: raising the number only moves where the silence starts.
    const mandates = resolve(import.meta.dirname, '..', '..', '..', 'mandates');
    for (const m of ['claude-main.json', 'claude-code.json', 'sol.json', 'ada.json', 'bo.json']) {
      const doc = JSON.parse(readFileSync(resolve(mandates, m), 'utf8')) as {
        limits?: { interrupts_per_day?: number };
      };
      expect(doc.limits?.interrupts_per_day, `${m} had its interrupt budget changed`).toBe(6);
    }
  });
});
