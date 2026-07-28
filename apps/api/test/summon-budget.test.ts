import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentTurnChunk } from '@playroom/shared';
import { testPool, uniqueRoomId } from './support.js';
import { appendMessage, createRoom } from '../src/events.js';
import {
  RECENT_WINDOW_MESSAGES,
  SUMMARY_TRIGGER_BATCH,
  maintainRoomSummary,
  type SummaryDeps,
} from '../src/summary.js';
import { assembleContext, windowFor } from '../src/assembly.js';
import { RoomBus } from '../src/bus.js';

/**
 * ═══ S1.6 — THE WINDOW STAYS UNDER BUDGET, AND FLAT (Bible §21.3, items 15–16) ═══
 *
 * The real token number is proven WITH a provider in scripts/measure-summon.ts (~1.3k tokens at 50,
 * 100, 200 AND 500 messages). This is the CI guard that keeps that true: it asserts, deterministically
 * and offline, that the assembled window stays bounded as the room grows past 50 — the summary folds
 * the older span, so a 400-message room's window is the same size as a 50-message room's.
 *
 * ── HOW THE TOKEN CLAIM IS MADE OFFLINE ──
 *
 * No tokeniser dependency. Instead a CONSERVATIVE OVER-ESTIMATE: for the prose in this room, the
 * models here average ~4 characters per token, so `ceil(chars / 3)` is strictly MORE tokens than the
 * provider will count. If the over-estimate is under 7k, the real count is too — and the script shows
 * the real count is ~1.3k, a wide margin. The estimate is intentionally pessimistic: a guard that
 * under-counts would pass a window that is actually over.
 */

const CHARS_PER_TOKEN_LOWER_BOUND = 3; // pessimistic: real prose is ~4, so this over-counts tokens
const estimateTokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN_LOWER_BOUND);
const BUDGET = 7000; // Bible §21.3

const pool = testPool();
const rooms: string[] = [];

// A fake summariser that returns a summary near the OUTPUT CAP, so the window is measured at its
// worst realistic case rather than with a conveniently tiny summary.
const CAPPED_SUMMARY = 'Prince and Sol worked through the branch split and the flaky test. '.repeat(
  18,
);
function fakeSummariser(): AgentAdapter {
  return {
    id: 'claude-main',
    async *stream(): AsyncGenerator<AgentTurnChunk> {
      yield { kind: 'text_delta', text: CAPPED_SUMMARY };
      yield { kind: 'done', tokens_in: 400, tokens_out: 300, stop_reason: 'end_turn' };
    },
  };
}

function summaryDeps(): SummaryDeps {
  return {
    pool,
    bus: new RoomBus(),
    adapterFactory: fakeSummariser,
    log: { info() {}, warn() {}, error() {} },
  };
}

// A realistic sentence-length room line — so the window's byte size is representative, not "hi"/"ok".
const LINE =
  'We should confirm the summary is maintained ahead of the summon and the recent window stays bounded.';

async function seedAndFold(roomId: string, messageCount: number): Promise<void> {
  await createRoom(pool, roomId, roomId, 'prince');
  rooms.push(roomId);
  for (let i = 0; i < messageCount; i++) {
    await appendMessage(
      pool,
      roomId,
      i % 2 === 0 ? 'prince' : 'sol',
      `b-${roomId}-${i}`,
      `${LINE} (#${i})`,
    );
  }
  const deps = summaryDeps();
  // Fold until caught up — the production path, done here synchronously and deterministically.
  for (let guard = 0; guard < 100; guard++) {
    const ev = await maintainRoomSummary(deps, roomId);
    if (!ev) break;
  }
}

async function windowFor_(
  roomId: string,
): Promise<{ chars: number; tailCount: number; summaryLines: number }> {
  const assembly = await assembleContext(pool, {
    memberId: 'claude-main',
    principalId: 'principal:prince',
    roomId,
    task: null,
    system: { text: 'SYSTEM FRAME', hash: 'h' },
    commonGroundLimit: RECENT_WINDOW_MESSAGES,
  });
  const w = windowFor(assembly);
  const chars = [w.systemPrompt, ...w.messages.map((m) => `${m.author}: ${m.body}`)].join(
    '\n',
  ).length;
  const summaryLines = w.messages.filter((m) => m.author === 'context/room-summary').length;
  const tailCount = w.messages.filter((m) => m.author === 'prince' || m.author === 'sol').length;
  return { chars, tailCount, summaryLines };
}

const SIZES = [40, 120, 400];
const measured: Record<number, { chars: number; tailCount: number; summaryLines: number }> = {};

beforeAll(async () => {
  for (const n of SIZES) {
    const roomId = uniqueRoomId(`budget-${n}`);
    await seedAndFold(roomId, n);
    measured[n] = await windowFor_(roomId);
  }
});

afterAll(async () => {
  for (const room of rooms) {
    await pool.query('DELETE FROM events WHERE room_id = $1', [room]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [room]);
  }
  await pool.end();
});

describe('the assembled window stays under 7k tokens as the room grows', () => {
  it.each(SIZES)('a %i-message room summons under 7k (conservative estimate)', (n) => {
    const m = measured[n];
    const tokens = estimateTokens(m.chars);
    console.log(
      `[budget] ${n} msgs → window ${m.chars} chars ≈ ${tokens} tok (over-estimate); tail=${m.tailCount}, summary lines=${m.summaryLines}`,
    );
    expect(tokens, `a ${n}-message room's window over-estimates to ${tokens} tokens`).toBeLessThan(
      BUDGET,
    );
  });

  it('the recent window is bounded — a 400-message room folds the rest into the summary', () => {
    for (const n of SIZES) {
      // At every size the tail is at most the window plus one batch of slack, and the summary is one
      // line. The room grew 10x; the window did not.
      expect(measured[n].tailCount).toBeLessThanOrEqual(
        RECENT_WINDOW_MESSAGES + SUMMARY_TRIGGER_BATCH,
      );
      // A room past the threshold HAS a summary (this is where the older span goes).
      expect(measured[n].summaryLines).toBe(1);
    }
  });

  it('the window is FLAT — 400 messages costs no more than 40 (item 16)', () => {
    const small = estimateTokens(measured[40].chars);
    const large = estimateTokens(measured[400].chars);
    // Bounded summary + bounded tail means the curve is flat, not merely under budget: the 10x-larger
    // room's window is within a small factor of the small room's, never linear in message count.
    expect(large).toBeLessThan(small * 1.5);
  });
});
