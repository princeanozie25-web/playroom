import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentMessage, AgentTurnChunk, ServerEvent } from '@playroom/shared';
import { expectEvent, testPool, uniqueRoomId } from './support.js';
import { appendMessage, appendRoomSummary, createRoom, latestRoomSummary } from '../src/events.js';
import {
  RECENT_WINDOW_MESSAGES,
  ROOM_SUMMARY_AUTHOR,
  SUMMARY_MAX_OUTPUT_TOKENS,
  SUMMARY_TRIGGER_BATCH,
  maintainRoomSummary,
  summaryPrompt,
  type SummaryDeps,
} from '../src/summary.js';
import { assembleContext, windowFor } from '../src/assembly.js';
import { RoomBus } from '../src/bus.js';
import { withPrincipalStore } from '../src/principal-store.js';

/**
 * ═══ S1.6 — THE ROLLING SUMMARY ═══
 *
 * The exit number is proven in the measurement script (scripts/measure-summon.ts, real tokens). This
 * suite proves the MECHANISM, deterministically and without a network: the summary is an event, it
 * is reconstructible, it compresses common ground and nothing else, it keeps attribution, and the
 * summon path only ever READS it — assembly makes no model call.
 */

const pool = testPool();
const roomId = uniqueRoomId('summary');

// A capturing fake summariser: records exactly what it was asked to compress, and echoes the
// distinct authors back so the OUTPUT demonstrably preserves who said what. A scriptedAdapter yields
// fixed text regardless of input, which cannot show attribution flowing through; this can.
interface Capture {
  messages: AgentMessage[];
  systemPrompt?: string;
  maxOutputTokens?: number;
  calls: number;
}
function capturingSummariser(cap: Capture): AgentAdapter {
  return {
    id: 'claude-main',
    async *stream(messages, opts): AsyncGenerator<AgentTurnChunk> {
      cap.messages = messages;
      cap.systemPrompt = opts?.systemPrompt;
      cap.maxOutputTokens = opts?.maxOutputTokens;
      cap.calls += 1;
      const authors = [...new Set(messages.map((m) => m.author))].join(', ');
      yield { kind: 'text_delta', text: `Room discussion so far, involving ${authors}.` };
      yield { kind: 'done', tokens_in: 200, tokens_out: 12, stop_reason: 'end_turn' };
    },
  };
}

function depsWith(cap: Capture): { deps: SummaryDeps; published: ServerEvent[]; bus: RoomBus } {
  const bus = new RoomBus();
  const published: ServerEvent[] = [];
  bus.subscribe(roomId, (e) => published.push(e));
  const deps: SummaryDeps = {
    pool,
    bus,
    adapterFactory: () => capturingSummariser(cap),
    log: { info() {}, warn() {}, error() {} },
  };
  return { deps, published, bus };
}

const FOREIGN_MARKER = 'ZARQUON-JERRY-SUMMARY-LEAK-55aa';
const JERRY = 'principal:jerry';
const PRINCE_MEMBER = 'claude-main';
const PRINCE = 'principal:prince';

// A message count comfortably over the fold threshold (WINDOW + BATCH), so the first call folds.
const SEEDED = RECENT_WINDOW_MESSAGES + SUMMARY_TRIGGER_BATCH + 4; // 24 + 12 + 4 = 40
const seededSeqs: number[] = [];
let jerryItemId: string | undefined;

beforeAll(async () => {
  await createRoom(pool, roomId, 'Rolling summary', 'prince');
  // Two distinct authors, so attribution has something to preserve. Bodies are distinct so a leak or
  // a dropped author would be visible.
  for (let i = 0; i < SEEDED; i++) {
    const author = i % 2 === 0 ? 'prince' : 'sol';
    const body =
      i % 2 === 0
        ? `Prince raises point ${i}: the branch split needs a second look.`
        : `Sol replies to ${i}: the failing test was a race, not the migration.`;
    const ev = await appendMessage(pool, roomId, author, `seed-${roomId}-${i}`, body);
    seededSeqs.push(ev.seq);
  }

  // A FOREIGN principal store item, so the "common-ground only" claim has an attack to survive.
  const planted = await withPrincipalStore(pool, JERRY, (s) =>
    s.add({
      kind: 'note',
      title: `Jerry private ${FOREIGN_MARKER}`,
      body: `Never merge without co-signature ${FOREIGN_MARKER}`,
      summary: `co-sign required ${FOREIGN_MARKER}`,
    }),
  );
  jerryItemId = planted.id;
});

afterAll(async () => {
  if (jerryItemId) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE playroom_context');
      await c.query('SELECT set_config($1, $2, true)', ['playroom.principal_id', JERRY]);
      await c.query('DELETE FROM principal_context WHERE id = $1', [jerryItemId]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  }
  await pool.query('DELETE FROM events WHERE room_id = $1', [roomId]);
  await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
  await pool.end();
});

describe('the fold: a summary is an event, reconstructible, cost-accounted', () => {
  it('folds the oldest messages into a room.summary event, leaving the recent window', async () => {
    const cap: Capture = { messages: [], calls: 0 };
    const { deps, published } = depsWith(cap);

    const event = await maintainRoomSummary(deps, roomId);
    expect(
      event,
      'nothing was folded — the tail was over threshold, so it should have',
    ).not.toBeNull();
    const rs = expectEvent(event!, 'room.summary');
    // It was fanned out (persist-before-fanout, like every event).
    expect(published.map((e) => e.event_type)).toContain('room.summary');

    const summary = await latestRoomSummary(pool, roomId);
    expect(summary).not.toBeNull();
    // Folded down to the window: SEEDED - WINDOW oldest messages summarised, WINDOW left in the tail.
    const expectedFold = SEEDED - RECENT_WINDOW_MESSAGES; // 40 - 24 = 16
    expect(summary!.covers_message_count).toBe(expectedFold);
    expect(summary!.covers_through_seq).toBe(seededSeqs[expectedFold - 1]);

    // COST IS RECORDED, not hidden (item 8): the summariser is a model call, and its cost is on the
    // event's column (for the ceiling/meter) and in its payload (for the wire).
    expect(rs.payload.cost_usd).not.toBeNull();
    expect(rs.payload.cost_usd!).toBeGreaterThan(0);
    expect(rs.payload.prompt_hash).toBe(summaryPrompt().hash);
    const { rows } = await pool.query<{ cost_usd: string | null }>(
      `SELECT cost_usd FROM events WHERE room_id = $1 AND event_type = 'room.summary'`,
      [roomId],
    );
    expect(rows.length).toBe(1);
    expect(Number(rows[0].cost_usd)).toBeGreaterThan(0);
  });

  it('is RECONSTRUCTIBLE — every message it summarises still exists', async () => {
    const summary = await latestRoomSummary(pool, roomId);
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM events
       WHERE room_id = $1 AND event_type = 'message' AND seq <= $2`,
      [roomId, summary!.covers_through_seq],
    );
    expect(Number(rows[0].n)).toBe(summary!.covers_message_count);
  });

  it('was given the summariser prompt and the output cap — and no principal store', async () => {
    // A fresh fold on a room with a bit more tail, to inspect the call's inputs.
    for (let i = SEEDED; i < SEEDED + SUMMARY_TRIGGER_BATCH + 2; i++) {
      const ev = await appendMessage(
        pool,
        roomId,
        i % 2 === 0 ? 'prince' : 'sol',
        `seed-${roomId}-${i}`,
        `Follow-up ${i}: still discussing the branch and the race.`,
      );
      seededSeqs.push(ev.seq);
    }
    const cap: Capture = { messages: [], calls: 0 };
    const { deps } = depsWith(cap);
    const event = await maintainRoomSummary(deps, roomId);
    expect(event).not.toBeNull();

    expect(cap.calls).toBe(1);
    expect(cap.systemPrompt).toBe(summaryPrompt().text);
    expect(cap.maxOutputTokens).toBe(SUMMARY_MAX_OUTPUT_TOKENS);

    // EXTENDS the previous summary, does not start over: the earlier summary is the first input.
    expect(cap.messages[0].author).toBe('earlier-summary');

    // COMMON GROUND ONLY: the summariser saw messages and the earlier summary — NOTHING from a
    // principal store. The foreign marker is planted in Jerry's store; it must appear nowhere in the
    // input, and nowhere in the summary the event now holds. (RA-006: a new path gets its own check.)
    const flatInput = cap.messages.map((m) => `${m.author}: ${m.body}`).join('\n');
    expect(flatInput).not.toContain(FOREIGN_MARKER);
    const summary = await latestRoomSummary(pool, roomId);
    expect(summary!.text).not.toContain(FOREIGN_MARKER);
  });

  it('keeps ATTRIBUTION — who said what reaches the summariser and its output', async () => {
    const cap: Capture = { messages: [], calls: 0 };
    const { deps } = depsWith(cap);
    // Force another fold by adding tail.
    for (let i = 100; i < 100 + SUMMARY_TRIGGER_BATCH + 2; i++) {
      const ev = await appendMessage(
        pool,
        roomId,
        i % 2 === 0 ? 'prince' : 'sol',
        `attr-${roomId}-${i}`,
        i % 2 === 0 ? `Prince: another point ${i}.` : `Sol: another reply ${i}.`,
      );
      seededSeqs.push(ev.seq);
    }
    const event = await maintainRoomSummary(deps, roomId);
    expect(event).not.toBeNull();
    const authors = new Set(cap.messages.map((m) => m.author));
    expect(authors.has('prince')).toBe(true);
    expect(authors.has('sol')).toBe(true);
    // The echoing fake proves attribution flows through to the output.
    const rs = expectEvent(event!, 'room.summary');
    expect(rs.payload.text).toContain('prince');
    expect(rs.payload.text).toContain('sol');
  });
});

describe('the read path: assembly uses the summary, and makes NO model call', () => {
  it('assembleContext prepends the summary as common ground, then the bounded recent window', async () => {
    // assembleContext takes NO adapterFactory — it cannot make a model call by construction. The
    // summary is MAINTAINED AHEAD of the summon (above); here the summon merely reads it.
    const assembly = await assembleContext(pool, {
      memberId: PRINCE_MEMBER,
      principalId: PRINCE,
      roomId,
      task: null,
      system: { text: 'SYS', hash: 'h' },
      commonGroundLimit: RECENT_WINDOW_MESSAGES,
    });

    const commonParts = assembly.parts.filter((p) => p.source === 'common-ground');
    // Two common-ground parts: the summary, then the recent window. Both are nobody's private context.
    for (const p of commonParts) expect(p.principal_id).toBeNull();
    const summaryPart = commonParts.find((p) =>
      p.messages.some((m) => m.author === ROOM_SUMMARY_AUTHOR),
    );
    expect(summaryPart, 'the summary did not reach the window').toBeDefined();

    // The recent window is bounded: at most WINDOW + BATCH messages after the summary's coverage.
    const window = windowFor(assembly);
    const summaryLine = window.messages.filter((m) => m.author === ROOM_SUMMARY_AUTHOR);
    const tail = window.messages.filter(
      (m) => m.author !== ROOM_SUMMARY_AUTHOR && m.author !== 'context/your-own-notes',
    );
    expect(summaryLine.length).toBe(1);
    expect(tail.length).toBeLessThanOrEqual(RECENT_WINDOW_MESSAGES + SUMMARY_TRIGGER_BATCH);
    // And the summary line comes BEFORE the recent messages — the shared record first (§7.1 order).
    const idxSummary = window.messages.findIndex((m) => m.author === ROOM_SUMMARY_AUTHOR);
    const idxFirstTail = window.messages.findIndex(
      (m) => m.author === 'prince' || m.author === 'sol',
    );
    expect(idxSummary).toBeGreaterThanOrEqual(0);
    expect(idxSummary).toBeLessThan(idxFirstTail);
  });
});

describe('idempotency: migration 019 refuses a second summary for one coverage point', () => {
  it('a duplicate covers_through_seq is refused at the database, returning null', async () => {
    const summary = await latestRoomSummary(pool, roomId);
    const dup = await appendRoomSummary(pool, roomId, {
      summary_id: 'sum_duplicate_attempt',
      covers_through_seq: summary!.covers_through_seq, // the same point the current summary covers
      covers_message_count: summary!.covers_message_count,
      text: 'a racing second fold to the same seq',
      tokens_in: 1,
      tokens_out: 1,
      cost_usd: 0.00001,
      prompt_hash: null,
    });
    expect(dup, 'the unique index let a second summary land on one coverage point').toBeNull();
  });

  it('a second maintain with no new messages folds nothing', async () => {
    const cap: Capture = { messages: [], calls: 0 };
    const { deps } = depsWith(cap);
    const again = await maintainRoomSummary(deps, roomId);
    expect(again).toBeNull();
    expect(cap.calls, 'the summariser was called with nothing to fold').toBe(0);
  });
});
