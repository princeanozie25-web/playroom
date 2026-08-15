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
import { ASSEMBLY_PARTS } from '../src/assembly.js';
import { RECENT_WINDOW_MESSAGES, SUMMARY_TRIGGER_BATCH } from '../src/summary.js';
import { executeCommand, type CommandDeps } from '../src/commands/index.js';

/**
 * ═══ S-TASK — THE OBJECTIVE REACHES THE CYCLE, DURABLY (ST-2) ═══
 *
 * The task is delivered as the SUMMON'S INTENT, which `fireSummon` writes to `tasks.intent` — a
 * column — and which assembly's `task` region reads from that row on every turn. So it is durable
 * for the same reason the briefing is: it comes from a RECORD, not from the message tail, and no
 * amount of conversation can push it out of the window.
 *
 * A NEW ASSEMBLY REGION WAS REJECTED. It would have meant a sixth declared part, a second read of
 * the same fact, and threading the order id into `assembleContext` — to deliver text the existing
 * task region already carries and already labels. The last assertion here holds that line: the
 * declaration is unchanged, so this slice added no region at all.
 *
 * The symmetry is the point. A human's tag already puts the human's own words in that region
 * (`postMessage` passes the message body as the intent); an order-rooted cycle now puts the order's
 * words there. One region, one meaning: what THIS turn is for.
 */

const pool = testPool();
const rooms: string[] = [];

const BRIEFING = 'FRAMING-MARKER-b71: prefer small reversible changes, and say what you would cut';
const TASK = 'OBJECTIVE-MARKER-t42: review the newest draft and name the one paragraph to cut';

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
      yield { kind: 'text_delta', text: `output from ${id}` };
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
  for (const room of rooms) await dropRoomQuiesced(pool, room);
  rooms.length = 0;
  await pool.query(
    "DELETE FROM events WHERE event_type IN ('interrupt.raised', 'interrupt.downgraded')",
  );
});
afterAll(async () => {
  await pool.end();
});

const BRIEFING_AUTHOR = 'context/room-briefing';
const TASK_AUTHOR = 'context/task-state';

async function newRoom(prefix: string): Promise<string> {
  const id = uniqueRoomId(prefix);
  rooms.push(id);
  await createRoom(pool, id, id, 'prince');
  return id;
}

/** A FULL recent window plus a rolling summary — the pressure an objective has to survive. */
async function fillWindow(roomId: string): Promise<void> {
  const SEEDED = RECENT_WINDOW_MESSAGES + SUMMARY_TRIGGER_BATCH + 6; // 42
  let lastSeq = 0;
  for (let i = 1; i <= SEEDED; i++) {
    const e = await appendMessage(
      pool,
      roomId,
      'prince',
      `fill-${roomId}-${i}`,
      `CONVERSATION-MARKER-c9 message ${i}`,
    );
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

async function makeOrder(roomId: string, task: string, maxUnattended = 3): Promise<string> {
  const created = await executeCommand(
    { actorId: 'prince', mode: 'human' },
    {
      kind: 'createOrder',
      roomId,
      clientMsgId: `oc-${roomId}`,
      triggerEventType: 'agent.turn.completed',
      triggerMember: 'sol',
      actionMember: 'claude-main',
      task,
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
async function triggerTurn(roomId: string, tag: string): Promise<number> {
  const kick = await appendMessage(
    pool,
    roomId,
    'prince',
    `kick-${roomId}-${tag}`,
    '@sol continue',
  );
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
      text: `DRAFT-MARKER-d3 (${tag}) the draft this cycle reviews`,
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

async function cyclesRun(roomId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM events WHERE room_id = $1 AND event_type = 'agent.turn.completed'
      AND actor_id = 'claude-main'`,
    [roomId],
  );
  return Number(rows[0].n);
}
async function waitForCycles(roomId: string, n: number): Promise<void> {
  const deadline = Date.now() + 15000;
  while ((await cyclesRun(roomId)) < n && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('the order’s objective reaches the cycle, in a full window', () => {
  it('survives 42 messages and a summary, and arrives in the task region', async () => {
    const roomId = await newRoom('st-deliver');
    await fillWindow(roomId);
    await setBriefing(pool, {
      roomId,
      content: BRIEFING,
      purpose: 'the nightly review loop',
      setBy: 'prince',
    });
    await makeOrder(roomId, TASK);

    await executeCommand(
      { actorId: 'system', mode: 'system' },
      {
        kind: 'runOrders',
        roomId,
        member: 'sol',
        completedSeq: await triggerTurn(roomId, 'a'),
        success: true,
      },
      deps,
    );
    await waitForCycles(roomId, 1);

    const cycle = handed.find((h) => h.member === 'claude-main');
    expect(cycle, 'the cycle took no turn').toBeDefined();
    const objective = cycle!.messages.filter((m) => m.author === TASK_AUTHOR);
    expect(objective, 'no task region reached the cycle').toHaveLength(1);
    expect(objective[0].body).toContain('OBJECTIVE-MARKER-t42');

    // THE WINDOW WAS GENUINELY UNDER PRESSURE: a summary plus a capped recent window sat between
    // the framing and the objective, and neither was evicted.
    expect(cycle!.messages.length).toBeGreaterThan(RECENT_WINDOW_MESSAGES);
    const flat = cycle!.messages.map((m) => m.body).join('\n');
    expect(flat).toContain('summary of the older half of the room');
    expect(flat).toContain('CONVERSATION-MARKER-c9');
  });

  it('THREE THINGS, DISTINGUISHABLE: framing, objective, and the conversation', async () => {
    const roomId = await newRoom('st-three');
    await fillWindow(roomId);
    await setBriefing(pool, {
      roomId,
      content: BRIEFING,
      purpose: 'the nightly review loop',
      setBy: 'prince',
    });
    await makeOrder(roomId, TASK);
    await executeCommand(
      { actorId: 'system', mode: 'system' },
      {
        kind: 'runOrders',
        roomId,
        member: 'sol',
        completedSeq: await triggerTurn(roomId, 'a'),
        success: true,
      },
      deps,
    );
    await waitForCycles(roomId, 1);
    const w = handed.find((h) => h.member === 'claude-main')!.messages;

    // EACH WEARS A DIFFERENT AUTHOR, and the authors are not member ids — a member cannot be
    // addressed as "context/room-briefing", so framing can never be mistaken for someone speaking.
    const idx = (pred: (m: AgentMessage) => boolean) => w.findIndex(pred);
    const iBrief = idx((m) => m.author === BRIEFING_AUTHOR);
    const iTalk = idx((m) => m.body.includes('CONVERSATION-MARKER-c9'));
    const iDraft = idx((m) => m.body.includes('DRAFT-MARKER-d3'));
    const iTask = idx((m) => m.author === TASK_AUTHOR);

    expect(iBrief, 'no framing').toBeGreaterThanOrEqual(0);
    expect(iTalk, 'no conversation').toBeGreaterThanOrEqual(0);
    expect(iDraft, 'no prior turn').toBeGreaterThanOrEqual(0);
    expect(iTask, 'no objective').toBeGreaterThanOrEqual(0);

    // ORDER: framing first (it frames what follows), then the room's shared record — the human
    // conversation, then the agents' own recent turns — then the objective LAST, nearest the reply.
    expect(iBrief).toBeLessThan(iTalk);
    expect(iTalk).toBeLessThan(iDraft);
    expect(iDraft).toBeLessThan(iTask);
    expect(iBrief).toBe(0);
    expect(iTask).toBe(w.length - 1);

    // The conversation is attributed to the MEMBERS who spoke; the two context regions are not.
    expect(w[iTalk].author).toBe('prince');
    expect(w[iDraft].author).toBe('sol');
    expect([BRIEFING_AUTHOR, TASK_AUTHOR]).not.toContain(w[iTalk].author);
  });

  it('EVERY cycle, not just the first — the objective does not decay', async () => {
    const roomId = await newRoom('st-every');
    await makeOrder(roomId, TASK);

    for (const tag of ['a', 'b']) {
      await executeCommand(
        { actorId: 'system', mode: 'system' },
        {
          kind: 'runOrders',
          roomId,
          member: 'sol',
          completedSeq: await triggerTurn(roomId, tag),
          success: true,
        },
        deps,
      );
      await waitForCycles(roomId, tag === 'a' ? 1 : 2);
    }

    const cycles = handed.filter((h) => h.member === 'claude-main');
    expect(cycles.length, 'the second cycle never ran').toBe(2);
    for (const [n, c] of cycles.entries()) {
      const objective = c.messages.filter((m) => m.author === TASK_AUTHOR);
      expect(objective, `cycle ${n + 1} carried no objective`).toHaveLength(1);
      expect(objective[0].body).toContain('OBJECTIVE-MARKER-t42');
    }
  });
});

describe('a human’s tag is untouched by any of this', () => {
  it('carries the human’s own words in the task region — never an order’s objective', async () => {
    const roomId = await newRoom('st-human');
    // The room HAS an order with a task. A human summon in the same room must not inherit it: an
    // order's objective belongs to that order's cycles, not to whoever tags a member next.
    await makeOrder(roomId, TASK);

    const ask = 'HUMAN-ASK-MARKER-h8 @claude what is the weather in this room';
    await executeCommand(
      { actorId: 'prince', mode: 'human' },
      { kind: 'postMessage', roomId, clientMsgId: `human-${roomId}`, body: ask },
      deps,
    );
    const deadline = Date.now() + 15000;
    while (handed.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const w = handed.find((h) => h.member === 'claude-main');
    expect(w, 'the human tag summoned nobody').toBeDefined();
    const objective = w!.messages.filter((m) => m.author === TASK_AUTHOR);
    expect(objective).toHaveLength(1);
    // The human's own message is what this turn is for — the same region, the same meaning.
    expect(objective[0].body).toContain('HUMAN-ASK-MARKER-h8');
    expect(objective[0].body).not.toContain('OBJECTIVE-MARKER-t42');

    // AND NO NEW REGION APPEARED. The authors in a human-rooted window are exactly what they were
    // before S-TASK: the room's members, plus the two context authors that already existed.
    const authors = new Set(w!.messages.map((m) => m.author));
    for (const a of authors) {
      expect(
        ['prince', 'sol', 'claude-main', BRIEFING_AUTHOR, TASK_AUTHOR, 'context/your-own-notes'],
        `an unexpected author "${a}" reached a human-rooted window`,
      ).toContain(a);
    }
  });
});

describe('S-TASK added no assembly region', () => {
  it('the declaration is unchanged — five parts, and `task` is the one that carries an objective', () => {
    // The delivery decision, asserted: had a new region been added, this would be six. The parts of
    // a window are declared in ONE place (SL2-1), so this is the whole of the check.
    expect(ASSEMBLY_PARTS.map((p) => p.source)).toEqual([
      'briefing',
      'common-ground',
      'room-turns',
      'own-store',
      'task',
    ]);
    // And the objective rides in the LAST one, which is where the declaration says the thing being
    // worked on belongs.
    expect(ASSEMBLY_PARTS[ASSEMBLY_PARTS.length - 1].source).toBe('task');
  });
});
