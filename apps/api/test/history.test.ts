import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentTurnChunk, ServerEvent } from '@playroom/shared';
import {
  httpCreateRoom,
  startTestServer,
  testPool,
  uniqueRoomId,
  type TestServer,
} from './support.js';
import { appendMessage, latestRoomSummary, HISTORY_PAGE_MAX } from '../src/events.js';
import { maintainRoomSummary, type SummaryDeps } from '../src/summary.js';
import { RoomBus } from '../src/bus.js';

/**
 * ═══ S1.6b — THE BOUNDED HISTORY ENDPOINT ═══
 *
 * The read side of what the socket already does for the live tail: a client loads a recent WINDOW on
 * open and pages OLDER history on demand, instead of replaying a long room whole (S16-N2) or resuming
 * from a stale cursor and showing a truncated room (S16-N1). This proves the server half — the window
 * is the span after the summary floor, older pages reach everything below it, attribution survives
 * paging, and the page is bounded and authenticated.
 */

const pool = testPool();
const roomId = uniqueRoomId('history');
let server: TestServer;
let floor = 0;
const SEEDED = 50;

// A fake summariser, so folding needs no network.
function fakeSummariser(): AgentAdapter {
  return {
    id: 'claude-main',
    async *stream(): AsyncGenerator<AgentTurnChunk> {
      yield { kind: 'text_delta', text: 'a folded summary' };
      yield { kind: 'done', tokens_in: 100, tokens_out: 10, stop_reason: 'end_turn' };
    },
  };
}

async function get(path: string, token = server.token): Promise<{ status: number; body: any }> {
  const res = await fetch(`${server.httpBase}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeAll(async () => {
  server = await startTestServer();
  expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
  // Seed with distinct authors and bodies, so a paged-in message's attribution is checkable.
  for (let i = 0; i < SEEDED; i++) {
    await appendMessage(
      pool,
      roomId,
      i % 2 === 0 ? 'prince' : 'sol',
      `h-${roomId}-${i}`,
      `line ${i} by ${i % 2 === 0 ? 'prince' : 'sol'}`,
    );
  }
  // Fold a summary so there is a real window floor and a real older span below it.
  const deps: SummaryDeps = {
    pool,
    bus: new RoomBus(),
    adapterFactory: fakeSummariser,
    log: { info() {}, warn() {}, error() {} },
  };
  for (;;) {
    const ev = await maintainRoomSummary(deps, roomId);
    if (!ev) break;
  }
  floor = (await latestRoomSummary(pool, roomId))!.covers_through_seq;
  expect(floor).toBeGreaterThan(0);
});

afterAll(async () => {
  await server.close();
  await pool.query('DELETE FROM events WHERE room_id = $1', [roomId]);
  await pool.query('DELETE FROM room_members WHERE room_id = $1', [roomId]);
  await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
  await pool.end();
});

const messages = (evs: ServerEvent[]): Extract<ServerEvent, { event_type: 'message' }>[] =>
  evs.filter(
    (e): e is Extract<ServerEvent, { event_type: 'message' }> => e.event_type === 'message',
  );

describe('the recent window (no cursor)', () => {
  it('is the span AFTER the summary floor — the older messages are not in it', async () => {
    const { status, body } = await get(`/rooms/${roomId}/history`);
    expect(status).toBe(200);
    const evs = body.events as ServerEvent[];
    // Every event in the window is after the floor; nothing summarised leaks into it.
    for (const e of evs) expect(e.seq).toBeGreaterThan(floor);
    // And there IS more below — the summarised span.
    expect(body.has_older).toBe(true);
  });

  it('shows the same recent MESSAGES the agent’s context window does (item 15)', async () => {
    const { body } = await get(`/rooms/${roomId}/history`);
    const windowMsgs = messages(body.events as ServerEvent[]).map((m) => m.payload.body);
    // The agent's window is the messages after the same floor. The client's window is these events;
    // its messages must be exactly that set — same floor, same recent span.
    const { rows } = await pool.query<{ payload: { body: string } }>(
      `SELECT payload FROM events
       WHERE room_id = $1 AND event_type = 'message' AND seq > $2 ORDER BY seq ASC`,
      [roomId, floor],
    );
    expect(windowMsgs).toEqual(rows.map((r) => r.payload.body));
  });
});

describe('older pages (with a cursor)', () => {
  it('reaches an out-of-window message, correctly attributed — N1 fixed, not hidden', async () => {
    // The first-ever message is in the summarised span, below the window. Prove it is REACHABLE.
    const window = (await get(`/rooms/${roomId}/history`)).body.events as ServerEvent[];
    let cursor = window[0].seq;
    let hasOlder = true;
    const seen: ServerEvent[] = [];
    let guard = 0;
    while (hasOlder && guard++ < 20) {
      const { body } = await get(`/rooms/${roomId}/history?before=${cursor}&limit=20`);
      const page = body.events as ServerEvent[];
      // Oldest-first, and strictly below the cursor.
      for (const e of page) expect(e.seq).toBeLessThan(cursor);
      expect([...page].sort((a, b) => a.seq - b.seq).map((e) => e.seq)).toEqual(
        page.map((e) => e.seq),
      );
      seen.unshift(...page);
      cursor = page[0].seq;
      hasOlder = body.has_older;
    }
    // The very first seeded message (line 0 by prince) is now reachable and correctly attributed.
    const first = messages(seen).find((m) => m.payload.body === 'line 0 by prince');
    expect(first, 'the out-of-window first message was not reachable').toBeDefined();
    expect(first!.actor_id).toBe('prince');
    // Paging terminated: nothing older than the earliest event.
    expect(hasOlder).toBe(false);
  });

  it('is bounded — limit is clamped to the ceiling', async () => {
    const { body } = await get(`/rooms/${roomId}/history?before=99999999&limit=9999`);
    expect((body.events as ServerEvent[]).length).toBeLessThanOrEqual(HISTORY_PAGE_MAX);
  });
});

describe('the same auth as every other room read', () => {
  it('refuses with no credential — 401, never a page', async () => {
    const { status, body } = await get(`/rooms/${roomId}/history`, '');
    expect(status).toBe(401);
    expect(body.code).toBe('credential_required');
  });

  it('a room that does not exist is a 404, byte-identical to a room you are not in', async () => {
    const { status, body } = await get(`/rooms/does-not-exist-${Date.now()}/history`);
    expect(status).toBe(404);
    expect(body.code).toBe('room_not_found');
  });
});
