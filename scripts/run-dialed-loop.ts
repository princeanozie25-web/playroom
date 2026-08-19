// scripts/run-dialed-loop.ts — LEAVING A LOOP RUNNING, AND BEING TOLD ABOUT IT (S-DIAL, SD-4).
//
//   pnpm tsx scripts/run-dialed-loop.ts            # whatever PLAYROOM_RUN_BASE points at
//   pnpm tsx scripts/run-dialed-loop.ts --live     # the deployed tier, on purpose, spelled out
//
// SD-1 gave a loop a voice gate, SD-2 gave it two words instead of one, SD-3 made a raised dial need
// an end. This runs all three at once against a real tier and prints what happened, so "a loop is
// safe to leave running" is a thing you read rather than a thing you are told.
//
// ── WHAT IT DOES, IN ORDER ───────────────────────────────────────────────────────────
//
//   1. AN UNATTENDED LOOP        one order, dial above 1, self-triggering: its own completed turn is
//                                the next cycle's trigger, so nobody has to press anything. It runs
//                                its dial out and PAUSES for a person → one NEEDS-YOU.
//   2. A LOOP THAT FINISHES      resumed, it runs to its cycle cap and stops terminal → one FINISHED.
//   3. THE VOICE RUNS OUT        short orders spend the rest of the action member's interrupt budget,
//                                one telling each, until there is none left.
//   4. THE UNTELLABLE PAUSE      one more order, triggered with the budget gone: SD-1's gate stops it
//                                BEFORE the cycle, and nothing reaches the phone. That silence is the
//                                boundary this slice names rather than engineers around, and the run
//                                ends by showing the order paused anyway.
//
// ── WRITES GO THROUGH THE DOOR; READS GO STRAIGHT TO THE DATABASE ────────────────────
//
// Every write is an HTTP request with a bearer credential, so the SERVER does the work — including
// the push, whose keys live in that machine's secrets and must never be here. The reads are direct
// SQL because the evidence this prints (per-turn cost, the egress record, the refusals) has no route
// and should not grow one just to be looked at once.
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { loadRootEnv } from '../apps/api/src/env.js';
import { makePool } from '../apps/api/src/db.js';
import { admitMember } from '../apps/api/src/events.js';

loadRootEnv();

const LIVE_BASE = 'https://playroom-api.fly.dev';
const live = process.argv.includes('--live');

/** The objective every cycle carries. Short and bounded: this run is about the loop, not the prose. */
const TASK =
  'Name one thing that could go wrong while a loop runs unattended overnight. One sentence, no preamble, and do not repeat a risk already named above.';

const KICK = '@claude-main start the watch.';
const RESUME_KICK = '@claude-main I am back — carry on.';
const FILLER_TASK = 'Say READY in one word.';

/** The loop's own member. Its principal is the one holding the phone, and its budget is the voice. */
const MEMBER = 'claude-main';

interface Ctx {
  base: string;
  token: string;
  pool: Pool;
  roomId: string;
}

async function api(ctx: Ctx, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${ctx.base}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${ctx.token}`,
      ...(init.headers ?? {}),
    },
  });
  return res;
}

async function post(ctx: Ctx, path: string, body: unknown): Promise<unknown> {
  const res = await api(ctx, path, { method: 'POST', body: JSON.stringify(body) });
  const text = await res.text();
  if (res.status >= 300) throw new Error(`POST ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

// ── READS ────────────────────────────────────────────────────────────────────────────

interface OrderState {
  id: string;
  status: string;
  cycle_count: number;
  unattended_count: number;
  pause_reason: string | null;
}

async function orderState(ctx: Ctx, orderId: string): Promise<OrderState> {
  const { rows } = await ctx.pool.query<OrderState>(
    `SELECT id, status, cycle_count, unattended_count, pause_reason
       FROM standing_orders WHERE id = $1`,
    [orderId],
  );
  if (!rows[0]) throw new Error(`no such order: ${orderId}`);
  return rows[0];
}

/** What the action member has left today — the same two counts SD-1's gate reads. */
async function budget(ctx: Ctx): Promise<{ spent: number; limit: number; remaining: number }> {
  const { rows } = await ctx.pool.query<{ spent: string }>(
    `SELECT
       (SELECT count(*) FROM events
         WHERE event_type = 'interrupt.raised' AND payload ->> 'raised_by' = $1
           AND payload ->> 'urgency' <> 'FYI'
           AND ts >= date_trunc('day', now() AT TIME ZONE 'UTC'))
     + (SELECT count(*) FROM events
         WHERE event_type = 'interrupt.downgraded' AND payload ->> 'raised_by' = $1
           AND ts >= date_trunc('day', now() AT TIME ZONE 'UTC')) AS spent`,
    [MEMBER],
  );
  const spent = Number(rows[0].spent);
  const limit = mandateLimit();
  return { spent, limit, remaining: limit - spent };
}

/** Read from the mandate on disk, which is the same file the deployed machine loads. */
function mandateLimit(): number {
  const raw = readFileSync(new URL('../mandates/claude-main.json', import.meta.url), 'utf8');
  return (JSON.parse(raw) as { limits: { interrupts_per_day: number } }).limits.interrupts_per_day;
}

interface SendRow {
  created_at: Date;
  urgency: string;
  endpoint_origin: string;
  outcome: string;
  disclosed: string;
  detail: string | null;
  /** When the claim behind this send was made — the send's own latency starts here. */
  claimed_at: Date | null;
  summary: string | null;
}

/**
 * The egress record for this room, each row joined to the CLAIM it was made for. Joined rather than
 * zipped by position: a refused send and a delivered one both write a row, and pairing two lists by
 * index would quietly mislabel every row after the first refusal.
 */
async function sends(ctx: Ctx): Promise<SendRow[]> {
  const { rows } = await ctx.pool.query<SendRow>(
    `SELECT s.created_at, s.urgency, s.endpoint_origin, s.outcome, s.disclosed, s.detail,
            e.ts AS claimed_at, e.payload ->> 'summary' AS summary
       FROM push_sends AS s
       LEFT JOIN events AS e
         ON e.room_id = s.room_id AND e.event_type = 'interrupt.raised'
        AND e.payload ->> 'interrupt_id' = s.interrupt_id
      WHERE s.room_id = $1 ORDER BY s.created_at`,
    [ctx.roomId],
  );
  return rows;
}

/**
 * Cycles this order COUNTED and cycles that produced a completed turn (S-CYCLE). The two must be
 * equal; they were not, once, and that is the whole reason this pair is printed rather than assumed.
 * A turn is attributed to an order through the SUMMON that authorised it, joined on the shared task.
 */
async function countedAndWorked(
  ctx: Ctx,
  orderId: string,
): Promise<{ counted: number; worked: number }> {
  const { rows } = await ctx.pool.query<{ counted: string; worked: string }>(
    `SELECT
       (SELECT count(*) FROM events
         WHERE room_id = $1 AND event_type = 'order.cycled' AND payload ->> 'order_id' = $2) AS counted,
       (SELECT count(DISTINCT t.seq) FROM events AS s
          JOIN events AS t ON t.room_id = s.room_id AND t.task_id = s.task_id
                          AND t.event_type = 'agent.turn.completed'
         WHERE s.room_id = $1 AND s.event_type = 'summon'
           AND s.payload ->> 'order_id' = $2) AS worked`,
    [ctx.roomId, orderId],
  );
  return { counted: Number(rows[0].counted), worked: Number(rows[0].worked) };
}

/** Just the worked half, for a one-line print. */
async function worked(ctx: Ctx, orderId: string): Promise<number> {
  return (await countedAndWorked(ctx, orderId)).worked;
}

/** Every claim this room made on a person's attention, whether or not a phone heard it. */
async function claims(ctx: Ctx): Promise<Array<{ ts: Date; urgency: string; summary: string }>> {
  const { rows } = await ctx.pool.query<{ ts: Date; urgency: string; summary: string }>(
    `SELECT ts, payload ->> 'urgency' AS urgency, coalesce(payload ->> 'summary', '') AS summary
       FROM events WHERE room_id = $1 AND event_type = 'interrupt.raised' ORDER BY seq`,
    [ctx.roomId],
  );
  return rows;
}

interface TurnRow {
  ts: Date;
  actor_id: string;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: string | null;
  order_id: string | null;
}

/**
 * Every completed turn, and which order (if any) caused it. A turn does not carry an order id — the
 * SUMMON that authorised it does — so the two are joined on the task they share, which is how a
 * cycle's cost is attributable at all.
 */
async function turns(ctx: Ctx): Promise<TurnRow[]> {
  const { rows } = await ctx.pool.query<TurnRow>(
    `SELECT t.ts, t.actor_id, t.tokens_in, t.tokens_out, t.cost_usd,
            (SELECT s.payload ->> 'order_id' FROM events AS s
              WHERE s.room_id = t.room_id AND s.task_id = t.task_id
                AND s.event_type = 'summon' LIMIT 1) AS order_id
       FROM events AS t
      WHERE t.room_id = $1 AND t.event_type = 'agent.turn.completed' ORDER BY t.seq`,
    [ctx.roomId],
  );
  return rows;
}

// ── WAITING ──────────────────────────────────────────────────────────────────────────

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 240000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting: last ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

const settled = (s: string): boolean => s !== 'ACTIVE';

// ── WRITES ───────────────────────────────────────────────────────────────────────────

async function createOrder(
  ctx: Ctx,
  opts: { task: string; dial: number; cap: number },
): Promise<string> {
  const body = await post(ctx, `/rooms/${ctx.roomId}/orders`, {
    trigger_event_type: 'agent.turn.completed',
    // SELF-TRIGGERING ON PURPOSE: the action member's own completed turn is the next cycle's
    // trigger, which is what makes this unattended rather than a person pressing go each time.
    trigger_member: MEMBER,
    action_member: MEMBER,
    task: opts.task,
    max_unattended_cycles: opts.dial,
    max_cycles: opts.cap,
  });
  return (body as { order_id: string }).order_id;
}

async function say(ctx: Ctx, text: string): Promise<void> {
  await post(ctx, `/rooms/${ctx.roomId}/messages`, { body: text });
}

/**
 * Tag the member, and keep tagging until the order this kick is for has settled.
 *
 * WHY A RETRY AND NOT A SLEEP. An order reaches its terminal status while the turn that took its
 * last cycle is STILL STREAMING — `fireOrderCycle` fires the summon and then checks the count, so the
 * status lands before the turn ends. A kick posted in that window meets the one-turn-per-room guard
 * and is answered with a system notice rather than a turn. Usually harmless: the in-flight turn
 * completes and triggers the new order anyway. But if it lands the other side of that window, nothing
 * triggers the new order and the run would sit waiting for a turn nobody is going to take. So the
 * kick is repeated until the order moves, and the count of extra kicks is printed rather than hidden.
 */
async function kickUntilSettled(
  ctx: Ctx,
  text: string,
  orderId: string,
  tries = 4,
): Promise<OrderState> {
  let extra = 0;
  for (let i = 0; i < tries; i += 1) {
    await say(ctx, i === 0 ? text : `${text} (${i})`);
    if (i > 0) extra += 1;
    try {
      const state = await until(
        () => orderState(ctx, orderId),
        (o) => settled(o.status),
        60000,
      );
      if (extra > 0) console.log(`    (${extra} extra ${extra === 1 ? 'kick' : 'kicks'})`);
      return state;
    } catch {
      /* not settled inside a minute — tag again below */
    }
  }
  throw new Error(`${orderId} never settled after ${tries} kicks`);
}

// ── THE RUN ──────────────────────────────────────────────────────────────────────────

function stamp(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

async function main(): Promise<void> {
  const base = process.env.PLAYROOM_RUN_BASE ?? (live ? LIVE_BASE : 'http://localhost:3001');
  const dbUrl = live ? process.env.DATABASE_URL : process.env.TEST_DATABASE_URL;
  const token = process.env.PLAYROOM_HARNESS_TOKEN;

  // TWO REFUSALS, BOTH ABOUT HITTING THE WRONG TIER BY ACCIDENT — the shape run-tasked-loop.ts uses.
  if (!token) throw new Error('PLAYROOM_HARNESS_TOKEN is not set');
  if (!dbUrl) throw new Error(live ? 'DATABASE_URL is not set' : 'TEST_DATABASE_URL is not set');
  if (!live && dbUrl === process.env.DATABASE_URL) {
    throw new Error('refusing: TEST_DATABASE_URL and DATABASE_URL are the same database');
  }
  if (live && !base.startsWith(LIVE_BASE)) {
    throw new Error(`refusing: --live but the base is ${base}`);
  }

  const pool = makePool(dbUrl);
  const roomId = `dial-${Date.now()}`;
  const ctx: Ctx = { base, token, pool, roomId };

  console.log(`\n═══ A LOOP LEFT RUNNING (${live ? 'LIVE TIER' : base}) ═══`);
  console.log(`room: ${roomId}`);

  const before = await budget(ctx);
  console.log(
    `\n[0] ${MEMBER}'s voice today: ${before.spent}/${before.limit} spent, ${before.remaining} left`,
  );
  const { rows: subs } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM push_subscriptions WHERE principal_id = 'principal:prince'`,
  );
  console.log(`    phones subscribed for principal:prince: ${subs[0].n}`);
  if (before.remaining < 3) {
    throw new Error(
      `refusing: ${before.remaining} of ${before.limit} interrupts left — this run needs at least 3 ` +
        `(a NEEDS-YOU, a FINISHED, and a last unit to spend). The budget resets at 00:00 UTC.`,
    );
  }

  await post(ctx, '/rooms', { id: roomId, title: roomId });
  // ADR-009 (the room door): POST /rooms now enrols only the creator, so admit the loop's member
  // explicitly — the orders below summon claude-main, and summon requires prior membership. The
  // write goes through the pool this run already holds, which points at the same database the door does.
  await admitMember(pool, roomId, MEMBER);

  // ── 0b. A COLLISION, ON PURPOSE (S-CYCLE, SC-3) ────────────────────────────────────
  //
  // SD-N1 was found by accident: one cycle in seven collided with a turn already in flight, counted
  // itself anyway, reached its cap and told a phone it had finished. This forces the same collision
  // rather than waiting to be unlucky — two orders in their OWN room, wired identically, so a single
  // completion fires both and the member can only answer one of them.
  //
  // ITS OWN ROOM, because the loser stays ACTIVE (a deferral leaves the trigger unconsumed), and an
  // order left waiting in the main room would fire on one of the kicks below and muddle the count
  // this run exists to report.
  const collideRoom = `${roomId}-collide`;
  await post(ctx, '/rooms', { id: collideRoom, title: collideRoom });
  await admitMember(pool, collideRoom, MEMBER); // same door: admit the member the collision orders summon
  const cc: Ctx = { ...ctx, roomId: collideRoom };
  const first = await createOrder(cc, { task: FILLER_TASK, dial: 1, cap: 1 });
  const second = await createOrder(cc, { task: FILLER_TASK, dial: 1, cap: 1 });
  console.log(`\n[0b] two orders racing one completion in ${collideRoom}`);
  await say(cc, `@${MEMBER} both of you.`);
  await until(
    () => Promise.all([orderState(cc, first), orderState(cc, second)]),
    ([a, b]) => settled(a.status) || settled(b.status),
  );
  await new Promise((r) => setTimeout(r, 2500)); // let the loser's refusal land in the log
  for (const [label, id] of [
    ['first', first],
    ['second', second],
  ] as const) {
    const s = await orderState(cc, id);
    console.log(
      `    ${label} ${id}: ${s.status}, ${s.cycle_count} counted, ${await worked(cc, id)} worked`,
    );
  }
  const { rows: refusal } = await pool.query<{ body: string }>(
    `SELECT payload ->> 'body' AS body FROM events
      WHERE room_id = $1 AND event_type = 'message' AND actor_id = 'system' ORDER BY seq`,
    [collideRoom],
  );
  console.log(
    refusal.length === 0
      ? `    (no system notice — the loser was stopped by the summon's own uniqueness, not the runner)`
      : `    the room says: "${refusal.map((r) => r.body).join(' | ')}"`,
  );

  // ── 1. AN UNATTENDED LOOP, RUN OUT ─────────────────────────────────────────────────
  const dial = 2;
  const loopOrder = await createOrder(ctx, { task: TASK, dial, cap: 3 });
  console.log(`\n[1] order ${loopOrder}: dial ${dial}, cap 3 cycles, ${MEMBER} triggers itself`);
  const paused = await kickUntilSettled(ctx, KICK, loopOrder);
  console.log(
    `    → ${paused.status} after ${paused.cycle_count} cycles (${paused.unattended_count} unwatched)`,
  );
  console.log(`    → "${paused.pause_reason}"`);

  // ── 2. RESUMED, AND FINISHED ───────────────────────────────────────────────────────
  await post(ctx, `/rooms/${roomId}/orders/${loopOrder}/control`, { op: 'resume' });
  const done = await kickUntilSettled(ctx, RESUME_KICK, loopOrder);
  console.log(`\n[2] resumed → ${done.status} after ${done.cycle_count} cycles`);
  console.log(`    → "${done.pause_reason}"`);

  // ── 3. SPEND THE REST OF THE VOICE ─────────────────────────────────────────────────
  let left = (await budget(ctx)).remaining;
  console.log(
    `\n[3] voice left after the loop: ${left}. Spending the rest, one telling per order.`,
  );
  for (let i = 1; left > 0; i += 1) {
    const filler = await createOrder(ctx, { task: FILLER_TASK, dial: 1, cap: 1 });
    const state = await kickUntilSettled(ctx, `@${MEMBER} short one (${i}).`, filler);
    left = (await budget(ctx)).remaining;
    console.log(`    ${filler} → ${state.status}; voice left: ${left}`);
  }

  // ── 4. THE UNTELLABLE PAUSE ────────────────────────────────────────────────────────
  const silent = await createOrder(ctx, { task: FILLER_TASK, dial: 1, cap: 1 });
  console.log(`\n[4] order ${silent}, triggered with no voice left`);
  const sendsBefore = (await sends(ctx)).length;
  const stopped = await kickUntilSettled(ctx, `@${MEMBER} one more.`, silent);
  console.log(`    → ${stopped.status} after ${stopped.cycle_count} cycles (a cycle never opened)`);
  console.log(`    → "${stopped.pause_reason}"`);
  const sendsAfter = await sends(ctx);
  console.log(
    `    → pushes before this order: ${sendsBefore}; after: ${sendsAfter.length} — ` +
      `${sendsAfter.length === sendsBefore ? 'NOTHING reached the phone, as SD-1 says' : 'SOMETHING WAS SENT (unexpected)'}`,
  );

  // ── DID EVERY COUNT MEAN A TURN? (S-CYCLE) ─────────────────────────────────────────
  //
  // The number SD-4 produced was seven and six. This prints the same pair, per order and per room,
  // so the claim is a thing you read rather than a thing you are told — and so a regression shows up
  // as a mismatch in the run's own output instead of as a wrong notification on a phone.
  console.log(`\n═══ CYCLES COUNTED vs CYCLES THAT WORKED ═══`);
  let counted = 0;
  let workedTotal = 0;
  for (const [label, c] of [
    ['collision', cc],
    ['main', ctx],
  ] as const) {
    const { rows: ids } = await pool.query<{ id: string }>(
      `SELECT id FROM standing_orders WHERE room_id = $1 ORDER BY created_at`,
      [c.roomId],
    );
    for (const { id } of ids) {
      const cw = await countedAndWorked(c, id);
      counted += cw.counted;
      workedTotal += cw.worked;
      const flag = cw.counted === cw.worked ? '' : '   ← MISMATCH';
      console.log(`  ${label.padEnd(9)} ${id}  counted=${cw.counted} worked=${cw.worked}${flag}`);
    }
  }
  console.log(
    `\n  TOTAL: ${counted} counted, ${workedTotal} worked — ` +
      `${counted === workedTotal ? 'equal, which is the invariant' : 'NOT EQUAL: the defect is back'}`,
  );

  // ── WHAT WAS TOLD, AND WHAT IT COST ────────────────────────────────────────────────
  const raised = await claims(ctx);
  const sent = sendsAfter;
  console.log(`\n═══ WHAT REACHED THE PHONE ═══`);
  console.log(`  claims made in this room: ${raised.length} · sends recorded: ${sent.length}`);
  for (const row of sent) {
    const lag = row.claimed_at ? row.created_at.getTime() - row.claimed_at.getTime() : null;
    console.log(
      `  ${stamp(row.created_at)}  ${row.outcome.padEnd(9)} ${row.urgency.padEnd(8)} ` +
        `${row.endpoint_origin}${lag === null ? '' : `  (+${lag}ms after the claim)`}`,
    );
    if (row.summary) console.log(`      the room's sentence: ${row.summary}`);
    if (row.detail) console.log(`      detail: ${row.detail}`);
  }
  console.log(`  disclosed: ${sent[0]?.disclosed ?? '(nothing sent)'}`);

  const all = await turns(ctx);
  console.log(`\n═══ WHAT IT COST, CYCLE BY CYCLE ═══`);
  let total = 0;
  for (const [i, t] of all.entries()) {
    total += Number(t.cost_usd ?? 0);
    console.log(
      `  ${String(i + 1).padStart(2)}. ${t.actor_id.padEnd(12)} in=${String(t.tokens_in).padStart(6)} ` +
        `out=${String(t.tokens_out).padStart(4)} $${Number(t.cost_usd ?? 0).toFixed(6)} ` +
        `${t.order_id ? 'cycle' : 'kick '} ${t.order_id ?? ''}`,
    );
  }
  const { rows: today } = await pool.query<{ usd: string }>(
    `SELECT coalesce(sum(cost_usd), 0)::text AS usd FROM events WHERE ts >= date_trunc('day', now())`,
  );
  console.log(`\n  this run: $${total.toFixed(6)} over ${all.length} turns`);
  console.log(`  the tier's whole day so far: $${Number(today[0].usd).toFixed(6)}`);
  console.log(`  ceiling: ${process.env.PLAYROOM_DAILY_USD_CEILING ?? '(set on the machine)'}`);
  console.log(`\n  room: ${roomId}`);

  await pool.end();
  process.exit(0);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
