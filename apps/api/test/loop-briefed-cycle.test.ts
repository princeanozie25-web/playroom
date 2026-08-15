import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentMessage, AgentTurnChunk } from '@playroom/shared';
import { dropRoomQuiesced, testPool, uniqueRoomId } from './support.js';
import { RoomBus } from '../src/bus.js';
import {
  appendAgentEvent,
  appendMessage,
  appendRoomSummary,
  appendSummon,
  createRoom,
} from '../src/events.js';
import { ensureTask } from '../src/tasks.js';
import { setBriefing } from '../src/briefings.js';
import { RECENT_WINDOW_MESSAGES, SUMMARY_TRIGGER_BATCH } from '../src/summary.js';
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
  // Quiesce THEN delete (support.ts): a fired cycle keeps writing after this file has moved on, and
  // deleting a room mid-turn leaves rows §19 counts as unrooted — in a test in another file.
  for (const room of rooms) await dropRoomQuiesced(pool, room);
  rooms.length = 0;
  // Interrupt budgets are global by member; a self-stop's DECISION would otherwise starve the next test.
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

/**
 * THE TRIGGER, WRITTEN THE WAY PRODUCTION WRITES IT: a real completed turn row with text and
 * success — which is exactly what `recentCompletedTurns` reads into the next cycle's window. The
 * suite's existing order tests synthesise `runOrders` without one, which is why this defect survived
 * a green suite.
 *
 * IT WRITES THE SUMMON TOO, and that is not decoration. §19's drift query is GLOBAL: a turn row whose
 * summon_id matches no summon row is UNROOTED wherever it lives, so a fixture that skipped the summon
 * would fail a test in another file the moment a teardown lost its race with a late write. Rooting the
 * fixture makes a leaked row harmless instead of relying on cleanup being perfect.
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
  await appendSummon(
    pool,
    roomId,
    { task_id: task.id },
    {
      summon_id: `prior-${roomId}`,
      member,
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

async function makeOrder(
  roomId: string,
  trigger: string,
  action: string,
  limits: { maxCycles?: number | null; maxUnattended?: number } = {},
): Promise<string> {
  const created = await executeCommand(
    { actorId: 'prince', mode: 'human' },
    {
      kind: 'createOrder',
      roomId,
      clientMsgId: `oc-${roomId}`,
      triggerEventType: 'agent.turn.completed',
      triggerMember: trigger,
      actionMember: action,
      task: 'review the draft and say what you would cut',
      maxCycles: limits.maxCycles ?? null,
      maxUnattendedCycles: limits.maxUnattended ?? 3,
      expiresAt: null,
    },
    deps,
  );
  if (!created.ok) throw new Error(`order not created: ${JSON.stringify(created)}`);
  return created.orderId!;
}

/** Run the order runner over a completion, the way the post-completion seam does. */
async function runOrdersFor(roomId: string, member: string, seq: number, success = true) {
  await executeCommand(
    { actorId: 'system', mode: 'system' },
    { kind: 'runOrders', roomId, member, completedSeq: seq, success },
    deps,
  );
}

/**
 * A FULL RECENT WINDOW plus a rolling summary — the pressure a briefing has to survive, and the state
 * a real loop room is in after a few cycles. Seeds comfortably more than the window holds, so the
 * oldest messages are beyond it and the summary covers them.
 */
async function fillWindow(roomId: string): Promise<void> {
  const SEEDED = RECENT_WINDOW_MESSAGES + SUMMARY_TRIGGER_BATCH + 6; // 24 + 12 + 6 = 42
  let lastSeq = 0;
  for (let i = 1; i <= SEEDED; i++) {
    const e = await appendMessage(pool, roomId, 'prince', `full-${roomId}-${i}`, `message ${i}`);
    lastSeq = e.seq;
  }
  await appendRoomSummary(pool, roomId, {
    summary_id: `sum-${roomId}`,
    covers_through_seq: lastSeq - RECENT_WINDOW_MESSAGES,
    covers_message_count: SEEDED - RECENT_WINDOW_MESSAGES,
    text: 'summary of the older half of the room',
    tokens_in: 100,
    tokens_out: 10,
    cost_usd: 0,
    prompt_hash: null,
  });
}

async function cycleCount(roomId: string, orderId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM events
      WHERE room_id = $1 AND event_type = 'order.cycled' AND payload ->> 'order_id' = $2`,
    [roomId, orderId],
  );
  return Number(rows[0].n);
}

async function order(roomId: string, orderId: string) {
  const { rows } = await pool.query<{
    status: string;
    pause_reason: string | null;
    unattended_count: number;
  }>(`SELECT status, pause_reason, unattended_count FROM standing_orders WHERE id = $1`, [orderId]);
  void roomId;
  return rows[0];
}

async function systemSays(roomId: string, fragment: string): Promise<boolean> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM events
      WHERE room_id = $1 AND event_type = 'message' AND actor_id = 'system'
        AND payload ->> 'body' LIKE '%' || $2 || '%'`,
    [roomId, fragment],
  );
  return Number(rows[0].n) > 0;
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
    // A FULL WINDOW, not an empty room: a briefing that only survives in a quiet room is not pinned.
    await fillWindow(roomId);
    await setBriefing(pool, {
      roomId,
      content: 'BRIEF-MARKER-9d2: review the draft, and say what you would cut',
      purpose: 'the nightly review loop',
      setBy: 'prince',
    });
    const orderId = await makeOrder(roomId, 'sol', 'claude-main');
    const triggerSeq = await priorCompletedTurn(roomId, 'sol', 'PRIOR-DRAFT-MARKER-4f1');

    await runOrdersFor(roomId, 'sol', triggerSeq);

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
    // And the window really was under pressure: a summary plus a capped recent window sat behind it.
    expect(flat).toContain('summary of the older half of the room');
    expect(cycle!.messages.length).toBeGreaterThan(RECENT_WINDOW_MESSAGES);
  });
});

describe('the cycle gets the briefing by the SAME path as a human’s tag', () => {
  it('the briefing region is byte-identical, and the only difference is the cycle’s own turns', async () => {
    const roomId = await newRoom('sl2-samepath');
    const CONTENT = 'SAME-PATH-MARKER-1c7: the framing does not change with who summoned';
    await setBriefing(pool, {
      roomId,
      content: CONTENT,
      purpose: 'path identity',
      setBy: 'prince',
    });
    await makeOrder(roomId, 'sol', 'claude-main');

    // (1) A HUMAN TAG. The ordinary route: a person summons the member directly.
    await executeCommand(
      { actorId: 'prince', mode: 'human' },
      {
        kind: 'summon',
        roomId,
        member: 'claude-main',
        causeSeq: 1,
        intent: 'a human tags the member',
      },
      deps,
    );
    await until(
      () => turnsOf(roomId, 'claude-main'),
      (t) => t.length >= 1,
    );
    const humanWindow = handed.find((h) => h.member === 'claude-main');

    // (2) THE ORDER-ROOTED CYCLE, in the same room, with the same briefing.
    handed = [];
    const triggerSeq = await priorCompletedTurn(roomId, 'sol', 'A-PRIOR-TURN');
    await runOrdersFor(roomId, 'sol', triggerSeq);
    await until(
      () => turnsOf(roomId, 'claude-main'),
      (t) => t.length >= 2,
    );
    const cycleWindow = handed.find((h) => h.member === 'claude-main');

    expect(humanWindow, 'the human tag produced no window').toBeDefined();
    expect(cycleWindow, 'the cycle produced no window').toBeDefined();

    // IDENTICAL, not merely similar: same author, same body, same position. Both windows come from
    // one `assembleContext` — there is no order-rooted assembly path to drift from the human one, and
    // this is what would fail first if someone built one.
    const briefingOf = (w: typeof humanWindow) =>
      w!.messages.filter((m) => m.author === 'context/room-briefing');
    expect(briefingOf(humanWindow)).toEqual([{ author: 'context/room-briefing', body: CONTENT }]);
    expect(briefingOf(cycleWindow)).toEqual(briefingOf(humanWindow));
    expect(cycleWindow!.messages[0]).toEqual(humanWindow!.messages[0]);
    // Same system frame, too — the briefing is context, and it did not become a system instruction.
    expect(cycleWindow!.systemPrompt).toBe(humanWindow!.systemPrompt);

    // The ONE difference is the loop's own region: the cycle sees recent turns, the human tag does not.
    const bodies = (w: typeof humanWindow) => w!.messages.map((m) => m.body);
    expect(bodies(humanWindow)).not.toContain('A-PRIOR-TURN');
    expect(bodies(cycleWindow)).toContain('A-PRIOR-TURN');
  });
});

describe('the bounds still bind a briefed cycle, and each names the rule that fired', () => {
  it('MAX CYCLES: the fired cycle is the last, and the order says which count it finished', async () => {
    const roomId = await newRoom('sl2-maxcycles');
    await setBriefing(pool, { roomId, content: 'brief', purpose: 'p', setBy: 'prince' });
    const orderId = await makeOrder(roomId, 'sol', 'claude-main', { maxCycles: 1 });

    const seq = await priorCompletedTurn(roomId, 'sol', 'draft one');
    await runOrdersFor(roomId, 'sol', seq);
    await until(
      () => order(roomId, orderId).then((o) => o.status),
      (s) => s === 'LIMIT_REACHED',
    );
    const o = await order(roomId, orderId);
    expect(o.status).toBe('LIMIT_REACHED');
    expect(o.pause_reason, 'the stop did not name the count it finished').toMatch(/1 cycle\b/);
    expect(await cycleCount(roomId, orderId)).toBe(1);
  });

  it('IDEMPOTENCY + ONE IN FLIGHT: a replayed trigger fires nothing; an older one never opens', async () => {
    const roomId = await newRoom('sl2-idem');
    await setBriefing(pool, { roomId, content: 'brief', purpose: 'p', setBy: 'prince' });
    const orderId = await makeOrder(roomId, 'sol', 'claude-main');

    const seq = await priorCompletedTurn(roomId, 'sol', 'the trigger');
    await runOrdersFor(roomId, 'sol', seq);
    await until(
      () => cycleCount(roomId, orderId),
      (n) => n >= 1,
    );

    // THE SAME COMPLETION, again — the database's idempotency key is the triggering seq.
    await runOrdersFor(roomId, 'sol', seq);
    await new Promise((r) => setTimeout(r, 250));
    expect(await cycleCount(roomId, orderId), 'a replayed trigger opened a second cycle').toBe(1);

    // AN OLDER COMPLETION — cannot open a cycle behind the one that has already run.
    await runOrdersFor(roomId, 'sol', seq - 1);
    await new Promise((r) => setTimeout(r, 250));
    expect(await cycleCount(roomId, orderId), 'an older trigger opened a cycle').toBe(1);
  });

  it('THE ATTENDANCE DIAL: at the budget it pauses saying it ran without you', async () => {
    const roomId = await newRoom('sl2-dial');
    await setBriefing(pool, { roomId, content: 'brief', purpose: 'p', setBy: 'prince' });
    const orderId = await makeOrder(roomId, 'sol', 'claude-main', { maxUnattended: 1 });

    const seq = await priorCompletedTurn(roomId, 'sol', 'unwatched work');
    await runOrdersFor(roomId, 'sol', seq);
    await until(
      () => order(roomId, orderId).then((o) => o.status),
      (s) => s === 'PAUSED',
    );
    const paused = await order(roomId, orderId);
    expect(paused.status).toBe('PAUSED');
    expect(paused.pause_reason).toMatch(/without you/);

    // AND A MESSAGE DOES NOT UNPAUSE IT. `resetUnattended` touches ACTIVE orders only, so a person
    // typing clears the streak of a running loop but never restarts one that already stopped for them
    // — resume is its own act, by the creator. Asserted because the opposite would be a loop that
    // slips back into motion because somebody said good morning.
    await executeCommand(
      { actorId: 'prince', mode: 'human' },
      { kind: 'postMessage', roomId, clientMsgId: `watch-${roomId}`, body: 'still here' },
      deps,
    );
    await new Promise((r) => setTimeout(r, 300));
    expect((await order(roomId, orderId)).status).toBe('PAUSED');
  });

  it('THE ATTENDANCE DIAL: a human message resets the streak of a running loop', async () => {
    const roomId = await newRoom('sl2-dial-reset');
    await setBriefing(pool, { roomId, content: 'brief', purpose: 'p', setBy: 'prince' });
    const orderId = await makeOrder(roomId, 'sol', 'claude-main', { maxUnattended: 3 });

    const seq = await priorCompletedTurn(roomId, 'sol', 'one unwatched cycle');
    await runOrdersFor(roomId, 'sol', seq);
    await until(
      () => order(roomId, orderId).then((o) => o.unattended_count),
      (n) => n >= 1,
    );
    expect((await order(roomId, orderId)).status).toBe('ACTIVE');

    // A person types: the room is watched. (The reset is fire-and-forget; poll for it.)
    await executeCommand(
      { actorId: 'prince', mode: 'human' },
      { kind: 'postMessage', roomId, clientMsgId: `watch-${roomId}`, body: 'still here' },
      deps,
    );
    await until(
      () => order(roomId, orderId).then((o) => o.unattended_count),
      (n) => n === 0,
    );
    expect((await order(roomId, orderId)).unattended_count).toBe(0);
  });

  it('THE CEILING: a reached ceiling pauses before the cycle opens, and does not retry', async () => {
    const prev = process.env.PLAYROOM_DAILY_USD_CEILING;
    process.env.PLAYROOM_DAILY_USD_CEILING = '0'; // any spend, including none, has reached $0
    try {
      const roomId = await newRoom('sl2-ceiling');
      await setBriefing(pool, { roomId, content: 'brief', purpose: 'p', setBy: 'prince' });
      const orderId = await makeOrder(roomId, 'sol', 'claude-main');

      const seq = await priorCompletedTurn(roomId, 'sol', 'work nobody can fund');
      await runOrdersFor(roomId, 'sol', seq);
      await until(
        () => order(roomId, orderId).then((o) => o.status),
        (s) => s === 'PAUSED',
      );
      const o = await order(roomId, orderId);
      expect(o.pause_reason, 'the pause did not name the ceiling').toMatch(/ceiling/);
      expect(await cycleCount(roomId, orderId), 'a cycle opened past the ceiling').toBe(0);
      expect((await turnsOf(roomId, 'claude-main')).length, 'tokens were spent past it').toBe(0);

      // AND IT DOES NOT RETRY: a second trigger on a paused order opens nothing either.
      await runOrdersFor(roomId, 'sol', seq + 1);
      await new Promise((r) => setTimeout(r, 250));
      expect(await cycleCount(roomId, orderId)).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.PLAYROOM_DAILY_USD_CEILING;
      else process.env.PLAYROOM_DAILY_USD_CEILING = prev;
    }
  });

  it('AN ERROR TERMINAL: the loop pauses rather than cycling on a failure', async () => {
    const roomId = await newRoom('sl2-error');
    await setBriefing(pool, { roomId, content: 'brief', purpose: 'p', setBy: 'prince' });
    const orderId = await makeOrder(roomId, 'sol', 'claude-main');

    // A turn that belonged to this order's cycle ended in error.
    await executeCommand(
      { actorId: 'system', mode: 'system' },
      {
        kind: 'runOrders',
        roomId,
        member: 'claude-main',
        completedSeq: 1000,
        success: false,
        orderId,
        errorClass: 'ProviderTimeout',
      },
      deps,
    );
    await until(
      () => order(roomId, orderId).then((o) => o.status),
      (s) => s === 'PAUSED',
    );
    const o = await order(roomId, orderId);
    expect(o.status).toBe('PAUSED');
    // The sentence names the failure's class, so an outage and a refusal do not read identically.
    expect(o.pause_reason).toMatch(/ProviderTimeout/);
    expect(await cycleCount(roomId, orderId)).toBe(0);
  });

  it('THE DEPTH CAP: a cycle is a fresh hop, and the hop after it is refused out loud', async () => {
    const roomId = await newRoom('sl2-depth');
    await setBriefing(pool, {
      roomId,
      content: 'a briefing widens nothing',
      purpose: 'p',
      setBy: 'prince',
    });
    const orderId = await makeOrder(roomId, 'sol', 'claude-main');

    const seq = await priorCompletedTurn(roomId, 'sol', 'the draft');
    await runOrdersFor(roomId, 'sol', seq);
    await until(
      () => turnsOf(roomId, 'claude-main'),
      (t) => t.length >= 1,
    );

    // The cycle's own summon is depth 0 — an order fires a FRESH human-rooted chain, so the member it
    // summons still has its one S1.8 hop. It does not inherit a depth from the turn that triggered it.
    const { rows } = await pool.query<{ payload: { depth: number; order_id?: string } }>(
      `SELECT payload FROM events WHERE room_id = $1 AND event_type = 'summon'
        AND payload ->> 'order_id' = $2`,
      [roomId, orderId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.depth).toBe(0);

    // AND THE CAP STILL BINDS INSIDE THE BRIEFED ROOM: dispatched at the constructor from the position
    // an agent reaches after one hop, a further summon is refused — by the DEPTH rule, named out loud.
    // (claude-main is the subject precisely because its mandate DOES grant summon.initiate, so the
    // mandate check passes and the cap is what refuses.)
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
    expect(await systemSays(roomId, 'may not start another summon')).toBe(true);
    // Refused BEFORE the summon is written, so THIS attempt left no summon row. Keyed on its own
    // cause_seq (1), because the room already holds the rooted summon behind the trigger turn —
    // counting every summon of sol would count that one and pass for the wrong reason.
    const { rows: solSummons } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM events
        WHERE room_id = $1 AND event_type = 'summon' AND payload ->> 'member' = 'sol'
          AND payload ->> 'cause_seq' = '1'`,
      [roomId],
    );
    expect(Number(solSummons[0].n), 'the over-depth summon was written anyway').toBe(0);
  });
});
