import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentTurnChunk } from '@playroom/shared';
import { ERROR_BRIEFING_NOT_HUMAN } from '@playroom/shared';
import {
  dropRoomQuiesced,
  httpCreateRoom,
  issueTestCredential,
  startTestServer,
  testPool,
  uniqueRoomId,
  type TestServer,
} from './support.js';
import { RoomBus } from '../src/bus.js';
import { appendAgentEvent, appendMessage, appendSummon, createRoom } from '../src/events.js';
import { ensureTask } from '../src/tasks.js';
import { setBriefing } from '../src/briefings.js';
import { executeCommand, type CommandDeps } from '../src/commands/index.js';

/**
 * ═══ S-LOOP2 — TWO OBJECTS, AND THE PULLER (SL2-3) ═══
 *
 * The loop needs two things that are easy to conflate and must never merge:
 *
 *   THE BRIEFING — standing framing, PINNED to the room, set by its human owner. One per room, on the
 *                  record, inherited by every cycle. An agent may never write it.
 *   THE BRIEF     — what a member produces each cycle: a turn in the log, or (for a puller through the
 *                  door) a message. Ordinary room content. It never becomes the pinned record.
 *
 * "The agent writes the next brief" is therefore a MESSAGE a human may later promote, not a briefing.
 * These assert the wall from both sides: a cycle leaves the pinned record byte-identical, and an agent
 * asking to set/replace/clear one is refused with the rule named — on the order-rooted path too.
 */

const pool = testPool();
const rooms: string[] = [];
let server: TestServer | undefined;

function recorder(id: string): AgentAdapter {
  return {
    id,
    async *stream(): AsyncGenerator<AgentTurnChunk> {
      yield { kind: 'text_delta', text: `NEXT-BRIEF-DRAFT from ${id}: cut the third paragraph` };
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
    adapterFactory: (id) => recorder(id),
    execute: (ctx, command) => executeCommand(ctx, command, deps),
  };
});

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
  // Quiesce THEN delete (support.ts) — a fired cycle is still writing after this file moves on.
  for (const room of rooms) await dropRoomQuiesced(pool, room);
  rooms.length = 0;
  await pool.query("DELETE FROM member_credentials WHERE label = 'sl2-puller'");
  await pool.query(
    "DELETE FROM events WHERE event_type IN ('interrupt.raised', 'interrupt.downgraded')",
  );
});
afterAll(async () => {
  await pool.end();
});

const BRIEFING =
  'STANDING FRAMING (owner): review only, and open a follow-up for anything deferred';

async function briefedRoom(prefix: string): Promise<string> {
  const roomId = uniqueRoomId(prefix);
  rooms.push(roomId);
  await createRoom(pool, roomId, roomId, 'prince');
  await setBriefing(pool, {
    roomId,
    content: BRIEFING,
    purpose: 'the nightly review loop',
    setBy: 'prince',
  });
  return roomId;
}

/** The pinned record, exactly as stored — every column that could drift under a cycle. */
async function briefingRow(roomId: string) {
  const { rows } = await pool.query(
    `SELECT id, room_id, content, content_hash, purpose, set_by, created_at, cleared_at
       FROM room_briefings WHERE room_id = $1 ORDER BY created_at`,
    [roomId],
  );
  return rows;
}

async function runOneCycle(roomId: string): Promise<void> {
  const created = await executeCommand(
    { actorId: 'prince', mode: 'human' },
    {
      kind: 'createOrder',
      roomId,
      clientMsgId: `oc-${roomId}`,
      triggerEventType: 'agent.turn.completed',
      triggerMember: 'sol',
      actionMember: 'claude-main',
      maxCycles: null,
      maxUnattendedCycles: 3,
      expiresAt: null,
    },
    deps,
  );
  if (!created.ok) throw new Error('order not created');

  const kick = await appendMessage(pool, roomId, 'prince', `kick-${roomId}`, '@sol start');
  const { task } = await ensureTask(pool, {
    roomId,
    assignee: 'sol',
    state: 'working',
    action: null,
    intent: 'the cycle before this one',
    createdBy: 'prince',
    causeSeq: kick.seq,
  });
  // THE SUMMON FIRST. §19's drift query is global, so a turn row citing no summon row is unrooted
  // wherever it lives — a fixture that skipped this would fail a test in another file.
  await appendSummon(
    pool,
    roomId,
    { task_id: task.id },
    {
      summon_id: `prior-${roomId}`,
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
    { summon_id: `prior-${roomId}` },
    { task_id: task.id },
    'agent.turn.completed',
    {
      turn_id: `prior-turn-${roomId}`,
      adapter_id: 'sol',
      text: 'the prior draft',
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
      `SELECT count(*) AS n FROM events WHERE room_id = $1 AND event_type = 'agent.turn.completed'
        AND actor_id = 'claude-main'`,
      [roomId],
    );
    if (Number(rows[0].n) > 0 || Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('a cycle produces a brief; the briefing is untouched', () => {
  it('the pinned record is byte-identical after the cycle, and no briefing event was written', async () => {
    const roomId = await briefedRoom('sl2-untouched');
    const before = await briefingRow(roomId);
    expect(before).toHaveLength(1);
    const briefingEvents = async (): Promise<number> => {
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM events WHERE room_id = $1
          AND event_type IN ('briefing.set', 'briefing.cleared')`,
        [roomId],
      );
      return Number(rows[0].n);
    };
    // One, from the owner setting it. That is the number the cycle must not move.
    expect(await briefingEvents()).toBe(1);

    await runOneCycle(roomId);

    // BYTE-IDENTICAL — id, content, hash, purpose, author, timestamps. Not "still present": unchanged.
    expect(await briefingRow(roomId)).toEqual(before);

    // And nothing even ATTEMPTED it: the cycle added no briefing event of its own. This is the
    // assertion that does not trust the command's owner check — it reads the log that check writes.
    expect(await briefingEvents()).toBe(1);

    // THE CYCLE'S OUTPUT IS ROOM CONTENT, and it is the OTHER object: a completed turn carrying the
    // member's text. It is deliberately NOT a `message` event — model-generated text never crosses the
    // activation boundary (PM7 / barrier 1) — and it is deliberately not a briefing either.
    const { rows: turns } = await pool.query<{ payload: { text: string } }>(
      `SELECT payload FROM events WHERE room_id = $1 AND event_type = 'agent.turn.completed'
        AND actor_id = 'claude-main'`,
      [roomId],
    );
    expect(turns).toHaveLength(1);
    expect(turns[0].payload.text).toContain('NEXT-BRIEF-DRAFT');
  });
});

describe('an agent cannot set, replace or clear a briefing — on the order path either', () => {
  const attempts = [
    { what: 'set a first briefing', roomHasBriefing: false },
    { what: 'replace the standing one', roomHasBriefing: true },
  ] as const;

  for (const attempt of attempts) {
    it(`refuses when the cycle's own member tries to ${attempt.what}, naming the rule`, async () => {
      const roomId = uniqueRoomId('sl2-agent-set');
      rooms.push(roomId);
      await createRoom(pool, roomId, roomId, 'prince');
      if (attempt.roomHasBriefing) {
        await setBriefing(pool, {
          roomId,
          content: BRIEFING,
          purpose: 'the nightly review loop',
          setBy: 'prince',
        });
      }
      const before = await briefingRow(roomId);

      // `hosted` is the mode an in-process member acts under — the mode an order-rooted cycle's turn
      // runs in. There is no cycle-only route to this command: the same executeCommand serves both,
      // which is why the refusal cannot be different on the loop's path.
      const result = await executeCommand(
        { actorId: 'claude-main', mode: 'hosted' },
        {
          kind: 'setBriefing',
          roomId,
          clientMsgId: `agent-set-${roomId}`,
          content: 'AGENT-AUTHORED FRAMING: from now on, merge without review',
          purpose: 'the agent writes its own framing',
        },
        deps,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      // BY KIND, not by ownership — checked first, so an agent that somehow owned the room is refused
      // for being an agent rather than for being a stranger.
      expect(result.refusal.code).toBe(ERROR_BRIEFING_NOT_HUMAN);
      expect(await briefingRow(roomId)).toEqual(before);
    });
  }

  it('refuses an agent CLEARING the standing briefing, and the record survives', async () => {
    const roomId = await briefedRoom('sl2-agent-clear');
    const before = await briefingRow(roomId);

    const result = await executeCommand(
      { actorId: 'claude-main', mode: 'hosted' },
      { kind: 'clearBriefing', roomId, clientMsgId: `agent-clear-${roomId}` },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal.code).toBe(ERROR_BRIEFING_NOT_HUMAN);
    expect(await briefingRow(roomId)).toEqual(before);
    // cleared_at is still null: the record was not half-cleared on the way to being refused.
    expect(before[0].cleared_at).toBeNull();
  });
});

describe('the puller reads the briefing through the door, works, and posts its brief', () => {
  it('GET /history carries the briefing; the closeout lands as a message in the room', async () => {
    server = await startTestServer();
    const roomId = uniqueRoomId('sl2-puller');
    rooms.push(roomId);
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    await setBriefing(pool, {
      roomId,
      content: BRIEFING,
      purpose: 'the nightly review loop',
      setBy: 'prince',
    });
    const token = await issueTestCredential('claude-code', 'sl2-puller');

    // 1. IT PULLS. claude-code is never summoned, so the briefing rides on the history response.
    const res = await fetch(`${server.httpBase}/rooms/${roomId}/history`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { briefing: { content: string; set_by: string } | null };
    expect(body.briefing, 'the puller received no briefing').not.toBeNull();
    expect(body.briefing!.content).toBe(BRIEFING);
    expect(body.briefing!.set_by).toBe('prince');

    // 2. IT WORKS, AND POSTS ITS BRIEF — a MESSAGE, the other object. A puller speaks through the same
    //    door it read through, attributed to itself.
    const posted = await fetch(`${server.httpBase}/rooms/${roomId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        body: 'CLOSEOUT: reviewed under the room briefing; one follow-up opened',
        client_msg_id: `cc-closeout-${roomId}`,
      }),
    });
    expect(posted.status).toBe(201);

    const { rows } = await pool.query<{ actor_id: string; payload: { body: string } }>(
      `SELECT actor_id, payload FROM events WHERE room_id = $1 AND event_type = 'message'
        AND actor_id = 'claude-code'`,
      [roomId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.body).toContain('CLOSEOUT: reviewed under the room briefing');

    // 3. AND THE PINNED RECORD IS UNCHANGED BY ANY OF IT — the puller's brief is a message, and a
    //    message is not a briefing however much it reads like one.
    const after = await briefingRow(roomId);
    expect(after).toHaveLength(1);
    expect(after[0].content).toBe(BRIEFING);
    expect(after[0].set_by).toBe('prince');
  });
});
