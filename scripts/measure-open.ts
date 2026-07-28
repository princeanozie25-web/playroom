// scripts/measure-open.ts — S16b's open-to-interactive number: the windowed load vs the full replay.
//
// What a client pays to OPEN a room is what it must download and rebuild: the events it receives. This
// measures both, as a room grows:
//   BEFORE (pre-S16b): the whole log — every event (`eventsAfter(0)`), what the socket replayed on a
//                      fresh open.
//   AFTER  (S16b):     the window — events after the summary floor, what the history endpoint serves.
// It reports events, payload bytes, and the read's own ms for each. The point is the SHAPE: the window
// stays flat as the room grows; the full replay grows with it.
//
//   pnpm tsx scripts/measure-open.ts [counts...]      e.g. 50 200 1000
//
// A SCRIPT, NOT A TEST: it seeds hundreds of rows and must never run in CI or `pnpm verify`. It makes
// NO provider call — the summary floor is set directly, because open cost depends on the floor, not on
// a summary's text.
import { performance } from 'node:perf_hooks';
import { loadRootEnv } from '../apps/api/src/env.js';
import { makePool } from '../apps/api/src/db.js';
import {
  createRoom,
  appendMessage,
  appendRoomSummary,
  eventsAfter,
} from '../apps/api/src/events.js';
import { RECENT_WINDOW_MESSAGES } from '../apps/api/src/summary.js';

loadRootEnv();

interface Sample {
  messages: number;
  full_events: number;
  full_bytes: number;
  full_ms: number;
  window_events: number;
  window_bytes: number;
  window_ms: number;
  ratio_events: number;
}

async function measureOne(
  pool: ReturnType<typeof makePool>,
  messageCount: number,
): Promise<Sample> {
  const roomId = `open-${messageCount}-${Date.now()}`;
  await createRoom(pool, roomId, roomId, 'prince');
  const seqs: number[] = [];
  for (let i = 0; i < messageCount; i++) {
    const ev = await appendMessage(
      pool,
      roomId,
      i % 2 === 0 ? 'prince' : 'sol',
      `o-${roomId}-${i}`,
      `Message ${i}: a sentence-length line about the branch split and the flaky test.`,
    );
    seqs.push(ev.seq);
  }
  // Set the window floor where a real fold would leave it: RECENT_WINDOW_MESSAGES messages in the tail.
  // No model call — open cost depends on the floor, not on the summary's words.
  const floorIdx = Math.max(0, messageCount - RECENT_WINDOW_MESSAGES) - 1;
  const floor = floorIdx >= 0 ? seqs[floorIdx] : 0;
  await appendRoomSummary(pool, roomId, {
    summary_id: `sum_open_${messageCount}`,
    covers_through_seq: floor,
    covers_message_count: Math.max(0, messageCount - RECENT_WINDOW_MESSAGES),
    text: 'a folded summary',
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    prompt_hash: null,
  });

  const t0 = performance.now();
  const full = await eventsAfter(pool, roomId, 0);
  const fullMs = performance.now() - t0;
  const t1 = performance.now();
  const windowed = await eventsAfter(pool, roomId, floor);
  const windowMs = performance.now() - t1;
  const bytes = (evs: unknown[]): number => JSON.stringify(evs).length;

  await pool.query('DELETE FROM events WHERE room_id = $1', [roomId]);
  await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
  return {
    messages: messageCount,
    full_events: full.length,
    full_bytes: bytes(full),
    full_ms: Math.round(fullMs),
    window_events: windowed.length,
    window_bytes: bytes(windowed),
    window_ms: Math.round(windowMs),
    ratio_events: Number((full.length / windowed.length).toFixed(1)),
  };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const counts = (process.argv.slice(2).length ? process.argv.slice(2) : ['50', '200', '1000'])
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0);
  const pool = makePool(url);
  try {
    console.log('open-to-interactive: what a client downloads and rebuilds to open a room\n');
    const samples: Sample[] = [];
    for (const n of counts) {
      const s = await measureOne(pool, n);
      samples.push(s);
      console.log(
        `  ${String(n).padStart(4)} msgs → FULL ${String(s.full_events).padStart(4)} events / ` +
          `${String(s.full_bytes).padStart(6)}B / ${s.full_ms}ms   ` +
          `WINDOW ${String(s.window_events).padStart(3)} events / ${s.window_bytes}B / ${s.window_ms}ms   ` +
          `(${s.ratio_events}x fewer)`,
      );
    }
    console.log('\nJSONL:');
    for (const s of samples) console.log(JSON.stringify(s));
  } finally {
    await pool.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
