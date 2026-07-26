// scripts/latency-room.ts — ADR-008's measurement: WARM and COLD, as separate numbers.
//
// ADR-005 measured 50 room turns and produced a soft P95 off a single member. Two things
// change here: n ≥ 50 PER MEMBER, and cold is measured EXPLICITLY rather than left as
// noise inside the warm distribution. A comfortable warm figure published while a real
// user waits 2.5s is the same failure as a drift query reading zero over an empty log.
//
// It drives the REAL ROOM PATH — a live server, a WebSocket, the command layer, the event
// log — so what it reports is what a member waits for, not what a provider call costs.
// ttfd is measured from the send frame leaving the client to the first delta arriving,
// which includes persist-before-fan-out. That is the point: Postgres is ON the first-token
// path, which is why a cold database and a cold provider compound.
//
//   pnpm tsx scripts/latency-room.ts warm [n]     # n turns per enabled member, warmed
//   pnpm tsx scripts/latency-room.ts cold-process # ONE turn, fresh server, no warm-up
//   pnpm tsx scripts/latency-room.ts cold-warmed  # ONE turn, fresh server, warmed first
//
// A script, not a test: it needs keys, spends money, and must NEVER run in CI or
// `pnpm verify`. Same rule as latency-control.ts.
import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';
import { loadRootEnv } from '../apps/api/src/env.js';
import { buildServer } from '../apps/api/src/server.js';
import { listAdapters } from '../packages/adapters/src/index.js';
import { makePool } from '../apps/api/src/db.js';

loadRootEnv();

const mode = process.argv[2] ?? 'warm';
const N = Number(process.argv[3] ?? 50);

interface Sample {
  member: string;
  ttfd_ms: number;
  gap_ms: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pct(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((q / 100) * sorted.length) - 1)];
}

function summarise(label: string, samples: number[]): void {
  const s = [...samples].sort((a, b) => a - b);
  console.log(
    `${label.padEnd(22)} n=${String(s.length).padStart(3)} min=${s[0]} p50=${pct(s, 50)} ` +
      `p90=${pct(s, 90)} p95=${pct(s, 95)} max=${s[s.length - 1]}`,
  );
}

/**
 * ONE socket for the whole run, like a real client — and one turn at a time, driven to
 * COMPLETION before the next is sent.
 *
 * Two harness bugs are fixed here, and both produced numbers rather than errors, which is
 * why they are written down:
 *
 * 1. RESOLVING ON "the first delta seen" measured 41ms for the second member. The socket
 *    subscribed with after=0, so it replayed the FIRST member's deltas and the stopwatch
 *    stopped on somebody else's token. A turn is now identified by its `started` event —
 *    the only one carrying adapter_id — and deltas are matched on that turn's turn_id.
 * 2. WAITING ONLY FOR THE FIRST DELTA sent the next message to a member whose previous
 *    turn was still streaming, which §22b correctly refuses with an in-thread notice and
 *    no turn — surfacing as a 60s timeout 15 turns in. The loop now waits for
 *    `agent.turn.completed`. A refusal is also detected explicitly, so a §22b notice
 *    reports itself instead of looking like a dead provider.
 */
class RoomClient {
  private readonly ws: WebSocket;
  private lastSeq = 0;
  private handlers: Array<(f: Record<string, never>) => void> = [];

  constructor(wsBase: string, roomId: string) {
    this.ws = new WebSocket(`${wsBase}/rooms/${roomId}/ws?after=0`);
    this.ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.type === 'hello') this.lastSeq = Math.max(this.lastSeq, f.last_seq);
      if (f.type === 'event') this.lastSeq = Math.max(this.lastSeq, f.seq);
      for (const h of this.handlers) h(f);
    });
  }

  async open(): Promise<void> {
    await new Promise<void>((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
  }

  close(): void {
    this.ws.close();
  }

  /** Send one summon and return ms from send to the first delta OF THAT TURN. */
  async measure(member: string, i: number): Promise<number> {
    const mark = this.lastSeq;
    let t0 = 0;
    let turnId: string | null = null;
    let ttfd = 0;

    const done = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no completion within 90s (${member})`)),
        90_000,
      );
      const finish = (fn: () => void) => {
        clearTimeout(timer);
        this.handlers = this.handlers.filter((h) => h !== handler);
        fn();
      };
      const handler = (f: Record<string, never>): void => {
        const ev = f as unknown as {
          type: string;
          seq: number;
          event_type: string;
          actor_id: string;
          payload: Record<string, string>;
        };
        if (ev.type === 'error') return finish(() => reject(new Error(`refused: ${ev.payload}`)));
        if (ev.type !== 'event' || ev.seq <= mark) return;
        // A §22b in-flight refusal is a system message, not an error frame. Detected so it
        // reports itself rather than expiring as a timeout.
        if (ev.event_type === 'message' && ev.actor_id === 'system') {
          return finish(() => reject(new Error(`room refused: ${ev.payload.body}`)));
        }
        if (
          ev.event_type === 'agent.turn.started' &&
          ev.payload.adapter_id === member &&
          turnId === null
        ) {
          turnId = ev.payload.turn_id;
          return;
        }
        if (turnId === null || ev.payload.turn_id !== turnId) return;
        if (ev.event_type === 'agent.turn.delta' && ttfd === 0) ttfd = performance.now() - t0;
        // The turn must FINISH before the next one is sent, or the next summon of this
        // member races a stream that is still running.
        if (ev.event_type === 'agent.turn.completed') return finish(() => resolve(ttfd));
      };
      this.handlers.push(handler);
    });

    t0 = performance.now();
    this.ws.send(
      JSON.stringify({
        type: 'send',
        client_msg_id: `lat-${member}-${i}-${t0.toFixed(0)}`,
        author: 'prince',
        // Varied so neither provider serves a cached completion, and short so output length
        // is not what is being measured.
        body: `@${member} reply with one short sentence about ${TOPICS[i % TOPICS.length]}`,
      }),
    );
    const ms = await done;
    if (ms === 0) throw new Error(`turn completed with no delta (${member})`);
    return ms;
  }
}

const TOPICS = [
  'the sky',
  'coffee',
  'the ocean',
  'music',
  'mountains',
  'rain',
  'bread',
  'harbours',
  'winter',
  'libraries',
];

async function withServer<T>(
  warmOnBoot: boolean,
  fn: (ctx: { httpBase: string; wsBase: string; roomId: string }) => Promise<T>,
): Promise<T> {
  const app = buildServer({ warmOnBoot });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('expected an AddressInfo');
  const httpBase = `http://127.0.0.1:${addr.port}`;
  const roomId = `lat-${Date.now()}`;
  const created = await fetch(`${httpBase}/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: roomId, title: 'latency measurement' }),
  });
  if (created.status !== 201) throw new Error(`room create failed: ${created.status}`);
  try {
    return await fn({ httpBase, wsBase: `ws://127.0.0.1:${addr.port}`, roomId });
  } finally {
    // The evidence for the ADR is the printed JSONL, not the rows — so the room goes.
    // A measurement run must not leave scratch rooms in the database (A4's rule).
    const pool = makePool(process.env.DATABASE_URL ?? '');
    try {
      await pool.query('DELETE FROM events WHERE room_id = $1', [roomId]);
      await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
      console.log(`(cleaned up room ${roomId})`);
    } finally {
      await pool.end();
    }
    await app.close();
  }
}

async function warmRun(): Promise<void> {
  const members = listAdapters().map((a) => a.id);
  await withServer(true, async ({ httpBase, wsBase, roomId }) => {
    // Warm explicitly and wait for it, so the whole run is unambiguously the warm path.
    const warm = await (await fetch(`${httpBase}/internal/warmup`, { method: 'POST' })).json();
    console.log(`warm-up: ${JSON.stringify(warm)}\n`);

    const client = new RoomClient(wsBase, roomId);
    await client.open();

    const samples: Sample[] = [];
    let prevEnd: number | null = null;
    for (let i = 0; i < N; i++) {
      for (const member of members) {
        // One turn at a time, driven to completion — §22b allows one in-flight turn per
        // member, and a summon that arrives mid-stream is refused rather than measured.
        const gap = prevEnd === null ? null : Math.round(performance.now() - prevEnd);
        const ms = Math.round(await client.measure(member, i));
        prevEnd = performance.now();
        samples.push({ member, ttfd_ms: ms, gap_ms: gap });
        await sleep(400);
      }
      if ((i + 1) % 10 === 0) console.log(`  … ${i + 1}/${N} rounds`);
    }
    client.close();

    console.log(`\nroom ${roomId}`);
    for (const member of members) {
      summarise(
        `warm ttfd ${member}`,
        samples.filter((s) => s.member === member).map((s) => s.ttfd_ms),
      );
    }
    summarise(
      'warm ttfd ALL',
      samples.map((s) => s.ttfd_ms),
    );
    console.log('\nJSONL:');
    for (const s of samples) console.log(JSON.stringify(s));
  });
}

/**
 * ONE turn on a fresh process after a long idle. n=1 per run, because the whole point is
 * that it is the first — a second sample would be a warm one.
 *
 * THE DATABASE WAKE IS MEASURED SEPARATELY, and it has to be, because otherwise the
 * measurement destroys the thing it measures: creating the room, or even connecting the
 * socket, issues a query that ABSORBS the Neon cold-start, and the turn that follows then
 * sees a warm database and reports a comfortably small number. Timing `SELECT 1` on a fresh
 * pool first isolates the wake and makes it attributable.
 *
 * What a member actually waits for is the wake PLUS the turn — but which request pays the
 * wake depends on what they touch first. Opening a room fetches it (a query), so in the UI
 * the page load often absorbs it and the send looks fast. Both numbers are published rather
 * than one summed figure, because the sum is the honest worst case and the split is what
 * tells you where it went.
 */
async function coldRun(warmFirst: boolean): Promise<void> {
  const member = process.argv[3] ?? listAdapters()[0].id;

  // Step 1: the wake, before anything else has touched Postgres in this process.
  const probe = makePool(process.env.DATABASE_URL ?? '');
  const tDb = performance.now();
  await probe.query('SELECT 1');
  const dbWakeMs = Math.round(performance.now() - tDb);
  await probe.end();

  await withServer(false, async ({ httpBase, wsBase, roomId }) => {
    let warmMs = 0;
    let warmDetail: unknown = null;
    if (warmFirst) {
      const t = performance.now();
      warmDetail = await (await fetch(`${httpBase}/internal/warmup`, { method: 'POST' })).json();
      warmMs = Math.round(performance.now() - t);
    }
    const client = new RoomClient(wsBase, roomId);
    await client.open();
    const ms = Math.round(await client.measure(member, 0));
    client.close();
    console.log(
      JSON.stringify({
        mode: warmFirst ? 'cold-warmed' : 'cold-process',
        member,
        db_wake_ms: dbWakeMs,
        ttfd_ms: ms,
        member_visible_worst_case_ms: dbWakeMs + ms,
        warm_ms: warmMs,
        warm_detail: warmDetail,
      }),
    );
  });
}

async function main(): Promise<void> {
  if (mode === 'warm') await warmRun();
  else if (mode === 'cold-process') await coldRun(false);
  else if (mode === 'cold-warmed') await coldRun(true);
  else throw new Error(`unknown mode: ${mode}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
