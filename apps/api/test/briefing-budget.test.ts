import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage } from '@playroom/shared';
import { testPool, uniqueRoomId } from './support.js';
import { appendMessage, createRoom } from '../src/events.js';
import { assembleContext, windowFor } from '../src/assembly.js';
import { BRIEFING_MAX_CHARS, setBriefing } from '../src/briefings.js';
import { RECENT_WINDOW_MESSAGES } from '../src/summary.js';

/**
 * ═══ S1.7 — WHAT A BRIEFING COSTS (S17-4) ═══
 *
 * A briefing is paid on EVERY summon. This measures the token delta a briefing adds to a summon's
 * window — with and without one, and with the room's message count as the denominator — so the cost is
 * a figure, not an adjective. It also fixes the invariant the cost rests on: the delta is EXACTLY the
 * briefing's content (nothing else changes), and it is bounded by the size cap (oversize is refused at
 * set time, tested in briefing-record.test.ts). Token figures are a ~4-chars/token ESTIMATE — the exact
 * count is the provider's tokenizer's, which is why real per-turn spend comes from provider usage.
 */

const pool = testPool();
const rooms: string[] = [];
const SYSTEM = { text: 'SYSTEM FRAME', hash: 'h' };
const PRINCE = 'principal:prince';

function chars(w: { systemPrompt: string; messages: AgentMessage[] }): number {
  return [w.systemPrompt, ...w.messages.map((m) => `${m.author}: ${m.body}`)].join('\n').length;
}
const estTokens = (c: number) => Math.round(c / 4);
async function assemble(roomId: string) {
  return windowFor(
    await assembleContext(pool, {
      memberId: 'claude-main',
      principalId: PRINCE,
      roomId,
      task: null,
      system: SYSTEM,
      commonGroundLimit: RECENT_WINDOW_MESSAGES,
    }),
  );
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

describe('a briefing costs exactly its content, bounded by the cap, on every summon', () => {
  it('measures the token delta with the room message count as denominator', async () => {
    const roomId = uniqueRoomId('brief-budget');
    rooms.push(roomId);
    await createRoom(pool, roomId, roomId, 'prince');
    const N = 10; // the denominator: how many messages the room holds
    for (let i = 1; i <= N; i++) {
      await appendMessage(
        pool,
        roomId,
        'prince',
        `bb-${roomId}-${i}`,
        `a room message of a fairly ordinary length, number ${i}`,
      );
    }

    // WITHOUT a briefing.
    const w0 = chars(await assemble(roomId));

    // A TYPICAL briefing — the kind a room owner would actually set for a review loop.
    const typical =
      'Review the open PRs for the playroom repo. Prefer small, reversible changes. If a change is ' +
      'risky, open a follow-up issue rather than merging. Ask before touching deploy or migrations.';
    await setBriefing(pool, { roomId, content: typical, purpose: 'loop framing', setBy: 'prince' });
    const wTypical = chars(await assemble(roomId));

    // A briefing AT THE CAP — the worst case the room can pay, since oversize is refused at set time.
    const atCap = 'x'.repeat(BRIEFING_MAX_CHARS);
    await setBriefing(pool, { roomId, content: atCap, purpose: 'cap', setBy: 'prince' });
    const wCap = chars(await assemble(roomId));

    const dTypical = wTypical - w0;
    const dCap = wCap - w0;
    console.log(
      `[brief-budget] denominator=${N} messages | window WITHOUT briefing=${w0} chars (~${estTokens(w0)} tok) | ` +
        `WITH a ${typical.length}-char typical briefing=${wTypical} chars (~${estTokens(wTypical)} tok), ` +
        `delta=+${dTypical} chars (~${estTokens(dTypical)} tok) | ` +
        `WITH a ${BRIEFING_MAX_CHARS}-char cap briefing=${wCap} chars (~${estTokens(wCap)} tok), ` +
        `delta=+${dCap} chars (~${estTokens(dCap)} tok)`,
    );

    // THE DELTA IS EXACTLY THE BRIEFING'S CONTENT — nothing else in the window moved. A small fixed
    // overhead is the author label ("context/room-briefing: ") plus the joining newline.
    const OVERHEAD = 'context/room-briefing: '.length + 1;
    expect(dTypical).toBe(typical.length + OVERHEAD);
    expect(dCap).toBe(BRIEFING_MAX_CHARS + OVERHEAD);
    // AND IT IS BOUNDED: no briefing can add more than the cap (+ the fixed label overhead), because a
    // larger one is refused before it is ever stored. So the worst-case per-summon cost is knowable.
    expect(dCap).toBeLessThanOrEqual(BRIEFING_MAX_CHARS + OVERHEAD);
  });
});
