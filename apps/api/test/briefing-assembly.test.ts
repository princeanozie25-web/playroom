import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage } from '@playroom/shared';
import { testPool, uniqueRoomId } from './support.js';
import { appendMessage, appendRoomSummary, createRoom } from '../src/events.js';
import { assembleContext, assemblyShape, windowFor, type Assembly } from '../src/assembly.js';
import { setBriefing } from '../src/briefings.js';
import { RECENT_WINDOW_MESSAGES, SUMMARY_TRIGGER_BATCH } from '../src/summary.js';

/**
 * ═══ S1.7 — DELIVERY TO A SUMMONED MEMBER (S17-2) ═══
 *
 * A briefing is delivered to a summoned member as its OWN region of assembled context, ahead of the
 * summary and the recent window, and it is PINNED — window pressure cannot evict it. A room with no
 * briefing assembles exactly as before. (Cross-principal isolation of the briefing is proven by
 * extending the foreign-store-unreachable job in context-isolation.test.ts, not duplicated here.)
 */

const pool = testPool();
const rooms: string[] = [];
const SYSTEM = { text: 'SYSTEM FRAME FOR THE BRIEFING ASSEMBLY TEST', hash: 'test-hash' };
const PRINCE = 'principal:prince';
const PRINCE_MEMBER = 'claude-main';
const BRIEFING_AUTHOR = 'context/room-briefing';

function flatten(w: { systemPrompt: string; messages: AgentMessage[] }): string {
  return [w.systemPrompt, ...w.messages.map((m) => `${m.author}: ${m.body}`)].join('\n');
}
async function assembleFor(roomId: string): Promise<Assembly> {
  return assembleContext(pool, {
    memberId: PRINCE_MEMBER,
    principalId: PRINCE,
    roomId,
    task: null,
    system: SYSTEM,
    commonGroundLimit: RECENT_WINDOW_MESSAGES,
  });
}
async function newRoom(): Promise<string> {
  const id = uniqueRoomId('brief-asm');
  rooms.push(id);
  await createRoom(pool, id, id, 'prince');
  return id;
}

afterEach(async () => {
  for (const id of rooms) {
    await pool.query('DELETE FROM events WHERE room_id = $1', [id]);
    await pool.query('DELETE FROM room_briefings WHERE room_id = $1', [id]);
    await pool.query('DELETE FROM room_members WHERE room_id = $1', [id]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [id]);
  }
  rooms.length = 0;
});
afterAll(async () => {
  await pool.end();
});

describe('the briefing is its own region, ahead of the recent window', () => {
  it('appears in the assembled window, before the recent messages, and counts as its own region', async () => {
    const roomId = await newRoom();
    await appendMessage(
      pool,
      roomId,
      'prince',
      `m-${roomId}-1`,
      'hello from the room conversation',
    );
    await setBriefing(pool, {
      roomId,
      content:
        'REVIEW ONLY: prefer small reversible PRs, and open a follow-up issue for anything deferred',
      purpose: 'nightly review loop',
      setBy: 'prince',
    });

    const assembly = await assembleFor(roomId);
    const w = windowFor(assembly);
    expect(flatten(w)).toContain('REVIEW ONLY: prefer small reversible PRs');

    // AHEAD OF the recent window: the briefing is the first message the model sees, before the message.
    expect(w.messages[0].author).toBe(BRIEFING_AUTHOR);
    const idxBrief = w.messages.findIndex((m) => m.author === BRIEFING_AUTHOR);
    const idxMsg = w.messages.findIndex((m) => m.body.includes('hello from the room conversation'));
    expect(idxBrief).toBeGreaterThanOrEqual(0);
    expect(idxMsg).toBeGreaterThan(idxBrief);

    // Its OWN region — one briefing part, not folded into common ground.
    expect(assemblyShape(assembly).briefing).toBe(1);
  });
});

describe('pinned means pinned: the briefing survives a full recent window', () => {
  it('with the window at capacity and a rolling summary present, the briefing is still first', async () => {
    const roomId = await newRoom();
    // Seed comfortably more than the window holds, so the recent window is FULL and the oldest are
    // beyond it — the exact pressure that would evict a briefing if it were just another old message.
    const SEEDED = RECENT_WINDOW_MESSAGES + SUMMARY_TRIGGER_BATCH + 6; // 24 + 12 + 6 = 42
    let lastSeq = 0;
    for (let i = 1; i <= SEEDED; i++) {
      const e = await appendMessage(
        pool,
        roomId,
        'prince',
        `full-${roomId}-${i}`,
        `message number ${i}`,
      );
      lastSeq = e.seq;
    }
    // A rolling summary that folds the older half, so assembly carries BOTH a summary and a full window —
    // and the briefing must sit ahead of both.
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

    await setBriefing(pool, {
      roomId,
      content: 'PINNED-BRIEF-MARKER-7ac1: this framing must survive window pressure',
      purpose: 'pinning proof',
      setBy: 'prince',
    });

    const assembly = await assembleFor(roomId);
    const w = windowFor(assembly);

    // The window is genuinely full — a summary part plus a capped recent window.
    expect(assemblyShape(assembly).common_ground).toBeGreaterThan(RECENT_WINDOW_MESSAGES);
    // And the briefing is present and FIRST — ahead of the summary and the recent window both.
    expect(flatten(w)).toContain('PINNED-BRIEF-MARKER-7ac1');
    expect(w.messages[0].author).toBe(BRIEFING_AUTHOR);
    expect(assemblyShape(assembly).briefing).toBe(1);
  });
});

describe('a room with no briefing assembles exactly as before', () => {
  it('no briefing region, and the window carries no briefing author', async () => {
    const roomId = await newRoom();
    await appendMessage(
      pool,
      roomId,
      'prince',
      `nb-${roomId}-1`,
      'an ordinary message, no briefing set',
    );

    const assembly = await assembleFor(roomId);
    expect(assemblyShape(assembly).briefing).toBe(0);
    const w = windowFor(assembly);
    expect(w.messages.some((m) => m.author === BRIEFING_AUTHOR)).toBe(false);
    // The absent case is not silently different: the window is exactly the common ground it always was.
    expect(w.messages[0].body).toContain('an ordinary message, no briefing set');
  });
});
