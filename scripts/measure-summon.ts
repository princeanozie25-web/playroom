// scripts/measure-summon.ts — the S1.6 exit number, measured not estimated.
//
// Bible §21.3's exit: a 50-message room summons at UNDER 7k input tokens. This drives the
// REAL command path with REAL adapters and reads `tokens_in` off the `agent.turn.completed`
// row — the provider's own count of what the window actually cost, not a tokeniser's guess.
//
//   pnpm tsx scripts/measure-summon.ts [member] [counts...]
//   e.g. pnpm tsx scripts/measure-summon.ts claude-main 50 100 200 500
//
// For each message count N it builds a fresh room, seeds N-1 human messages, then sends one
// more that summons `member`, and reports the summon's input tokens and cost. Growing N shows
// whether the window (and therefore the cost) stays flat as a room runs long — the whole point.
//
// A SCRIPT, NOT A TEST: it needs provider keys, spends money, and must NEVER run in CI or
// `pnpm verify`. Same rule as latency-room.ts / latency-control.ts.
import type { ServerEvent } from '@playroom/shared';
import { loadRootEnv } from '../apps/api/src/env.js';
import { makePool } from '../apps/api/src/db.js';
import { RoomBus } from '../apps/api/src/bus.js';
import {
  createRoom,
  admitMember,
  appendMessage,
  latestRoomSummary,
} from '../apps/api/src/events.js';
import { executeCommand, type CommandDeps } from '../apps/api/src/commands/index.js';
import { maintainRoomSummary, type SummaryDeps } from '../apps/api/src/summary.js';
import { createAdapter } from '../packages/adapters/src/index.js';

loadRootEnv();

// A corpus of realistic room lines — a code-review conversation, sentence-length, varied so
// the token count is representative of a real room rather than of "hi"/"ok". Each seeded
// message gets a counter suffix too, so no two are byte-identical.
const CORPUS = [
  'I pushed the branch that splits the fabric evaluator from the room service, can you take a look when you get a chance.',
  'The failing test was a race between the ticket consume and the handshake, not the migration like I first thought.',
  'We should decide whether the summary counts against the daily ceiling before this ships to the first tester.',
  'Left a couple of comments on the diff — mostly about the naming in the assembly part, nothing blocking.',
  'The Neon compute went cold overnight so the first turn this morning paid the whole wake, about a second and a half.',
  'Can we keep the recent window at a fixed count for now and revisit a token budget once we have real rooms.',
  'I think the provenance label should come from the store, not the input, otherwise the assertion checks itself.',
  'Reminder that the guest adapters run at half the output cap, so their turns read shorter and cost less.',
  'The redeem endpoint is still unthrottled — it is fine on localhost but it is the first thing to fix on a public URL.',
  'Agreed on keeping agent turns out of the summon activation path; that boundary is doing real work and should not move.',
  'The meter should read as a fact, not a warning — small, in the corner, never a nag about spending.',
  'I measured the fan-out span and it reads zero because it ends at the emitter, before any socket write.',
  'Do we want the summary to preserve who said what, or is a topic list enough for the agent to stay coherent.',
  'The credential in the query string is closed now — the socket takes a single-use ticket that expires in thirty seconds.',
  'Careful with the rollback story: an older server cannot parse a newer event type, so the whole room goes blank.',
  'Prices are config not constants, so a provider price change is an edit to adapters.yaml rather than a release.',
  'The isolation test caught the mutation because the text assertion fired, but the runtime invariant stayed silent.',
  'Let us not gold-plate the summariser — a plain compression that keeps the room cheap is the whole ask here.',
  'One tester spending the whole day budget through someone else another agent is the shared-room design, not a bug yet.',
  'I will re-check the first-token latency once the summary is maintained ahead of the summon rather than during it.',
];

interface Sample {
  messages: number;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  // The summary the summon read: how many messages it folds, and what building it cost. In
  // production the folds are amortised across the room's life (one small fold per ~batch messages);
  // here they are a one-time backfill of an already-long room, so the cost is the pessimistic case.
  summary_covers: number;
  summariser_calls: number;
  summariser_cost_usd: number;
}

async function measureOne(
  deps: CommandDeps,
  bus: RoomBus,
  pool: ReturnType<typeof makePool>,
  member: string,
  messageCount: number,
): Promise<Sample> {
  const roomId = `measure-${messageCount}-${Date.now()}`;
  await createRoom(pool, roomId, roomId, 'prince');
  // ADR-009: createRoom now enrols only the creator, so admit the members this summon path drives.
  await admitMember(pool, roomId, 'claude-main');
  await admitMember(pool, roomId, 'sol');

  // Seed N-1 human messages directly — a message row is a message row however it was written,
  // and this is faster and cheaper than driving each through a summon.
  for (let i = 0; i < messageCount - 1; i++) {
    const body = `${CORPUS[i % CORPUS.length]} (#${i + 1})`;
    await appendMessage(pool, roomId, 'prince', `seed-${roomId}-${i}`, body);
  }

  // BUILD THE SUMMARY THE WAY PRODUCTION DOES, ahead of the summon — real summariser calls, folded
  // until caught up. This is what makes the measured summon a WITH-summary summon rather than the
  // fresh-room transient. Its cost is captured so the report shows the net, not just the win.
  const sumDeps: SummaryDeps = {
    pool,
    bus: deps.bus,
    adapterFactory: deps.adapterFactory,
    log: deps.log,
  };
  let summariserCost = 0;
  let summariserCalls = 0;
  for (;;) {
    const ev = await maintainRoomSummary(sumDeps, roomId);
    if (!ev) break;
    summariserCalls += 1;
    if (ev.event_type === 'room.summary') summariserCost += ev.payload.cost_usd ?? 0;
  }
  const summary = await latestRoomSummary(pool, roomId);

  // The Nth message summons the member. Await its completion off the bus.
  const completed = new Promise<ServerEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`no completion within 90s (${member}, ${messageCount} msgs)`));
    }, 90_000);
    const unsub = bus.subscribe(roomId, (ev) => {
      if (ev.event_type === 'agent.turn.completed' && ev.payload.adapter_id === member) {
        clearTimeout(timer);
        unsub();
        resolve(ev);
      }
    });
  });

  await executeCommand(
    { actorId: 'prince', mode: 'human' },
    {
      kind: 'postMessage',
      roomId,
      clientMsgId: `summon-${roomId}`,
      body: `@${member} in one short sentence, where have we got to?`,
    },
    deps,
  );

  const ev = await completed;
  const payload = ev.event_type === 'agent.turn.completed' ? ev.payload : null;
  const sample: Sample = {
    messages: messageCount,
    tokens_in: payload?.tokens_in ?? null,
    tokens_out: payload?.tokens_out ?? null,
    cost_usd: payload?.cost_usd ?? null,
    summary_covers: summary?.covers_message_count ?? 0,
    summariser_calls: summariserCalls,
    summariser_cost_usd: Number(summariserCost.toFixed(5)),
  };

  // The turn keeps writing after `completed` — `moveTask` appends a `task.state` row once the
  // work is done. Let that settle before deleting, or the room delete races an event that
  // references it. Leave no scratch room behind (A4's rule): `events` has no ON DELETE CASCADE,
  // everything else does, so delete events first, then the room.
  await new Promise((r) => setTimeout(r, 1500));
  await pool.query('DELETE FROM events WHERE room_id = $1', [roomId]);
  await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
  return sample;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const member = process.argv[2] ?? 'claude-main';
  const counts = (process.argv.slice(3).length ? process.argv.slice(3) : ['50', '100', '200'])
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0);

  const pool = makePool(url);
  const bus = new RoomBus();
  const quiet = { info() {}, warn() {}, error() {} };
  const deps: CommandDeps = {
    pool,
    bus,
    log: quiet,
    adapterFactory: createAdapter,
    execute: (ctx, command) => executeCommand(ctx, command, deps),
  };

  try {
    console.log(`member=${member} — input tokens per summon as the room grows\n`);
    const samples: Sample[] = [];
    for (const n of counts) {
      const s = await measureOne(deps, bus, pool, member, n);
      samples.push(s);
      const flag = s.tokens_in != null && s.tokens_in < 7000 ? 'under 7k ✓' : 'OVER 7k ✗';
      console.log(
        `  ${String(n).padStart(4)} msgs → summon in=${s.tokens_in} out=${s.tokens_out} ` +
          `cost=$${s.cost_usd} — ${flag}  |  summary folds ${s.summary_covers} msgs in ` +
          `${s.summariser_calls} call(s), $${s.summariser_cost_usd}`,
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
