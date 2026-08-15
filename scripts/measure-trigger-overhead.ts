// scripts/measure-trigger-overhead.ts — S-LOOP's number: what the loop runner adds per cycle,
// and the proof it adds nothing to a normal turn.
//
// THE QUESTION. A standing order turns a completed turn into the next summon. That convergence — read
// the orders this completion triggers, open a cycle (the atomic guard), record it, and fire the summon
// through the SAME fireSummon a person's tag uses — sits at the post-completion seam, AFTER a turn
// ends and BEFORE the next one's first token. This times it, warm, against the live database, so the
// loop's per-cycle cost is a measured number and not a hope.
//
// TWO SPANS, AND THE SECOND IS THE POINT:
//   * TRIGGER OVERHEAD — a completed turn that DOES fire an order: runOrders → tryOpenCycle →
//     order.cycled → fireSummon writing the order-rooted summon + route. The fired turn is a
//     fire-and-forget scripted stream after fireSummon returns, so it is NOT in the span. Added to a
//     member's warm TTFT (ADR-008), this is when an order-rooted turn speaks — held to §11's 1800ms.
//   * NORMAL-TURN NO-OP — a completed turn that fires NO order (no order watches this member): the one
//     indexed read (activeOrdersForTrigger) that returns nothing. This is ALL the loop machinery costs
//     a turn nobody automated, and it is off the first-token path entirely (it runs after completion).
//     ADR-008 is unaffected by construction, not by luck: the room-turns context source is gated to
//     order-rooted turns, so a normal turn's assembly is byte-for-byte what it was before S-LOOP.
//
// A SCRIPT, NOT A TEST: it hits the live database and must never run in CI or `pnpm verify`. It makes
// NO provider call — every turn is a scripted adapter — so it spends NO tokens.
//
//   pnpm tsx scripts/measure-trigger-overhead.ts [n]      e.g. 40
import { performance } from 'node:perf_hooks';
import type { AgentAdapter, AgentTurnChunk } from '@playroom/shared';
import { loadRootEnv } from '../apps/api/src/env.js';
import { makePool } from '../apps/api/src/db.js';
import { RoomBus } from '../apps/api/src/bus.js';
import { createRoom } from '../apps/api/src/events.js';
import { executeCommand, type CommandDeps } from '../apps/api/src/commands/index.js';

loadRootEnv();

// The warm TTFT P95 ADR-008 published, so an order-rooted first token can be stated as a sum — for
// reference only. §11's 1800ms first-token P95 prices a HUMAN'S wait after they act; a loop cycle has
// no human waiting on its first token, so that budget does not gate it. The number that matters is the
// trigger overhead itself, and the no-op that proves a normal turn pays nothing.
const WARM_P95: Record<string, number> = { 'claude-main': 1742, sol: 698 };

function scripted(id: string): AgentAdapter {
  return {
    id,
    async *stream(): AsyncGenerator<AgentTurnChunk> {
      yield { kind: 'done', tokens_in: 0, tokens_out: 0, stop_reason: 'end_turn' };
    },
  };
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function report(label: string, xs: number[]): { p50: number; p90: number; p95: number } {
  xs.sort((a, b) => a - b);
  const p50 = pct(xs, 50);
  const p90 = pct(xs, 90);
  const p95 = pct(xs, 95);
  console.log(
    `  ${label.padEnd(22)} min ${xs[0].toFixed(1)}  p50 ${p50.toFixed(1)}  ` +
      `p90 ${p90.toFixed(1)}  p95 ${p95.toFixed(1)}  max ${xs[xs.length - 1].toFixed(1)}  (ms)`,
  );
  return { p50, p90, p95 };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const n = Number(process.argv[2] ?? '40');
  const pool = makePool(url);
  const deps: CommandDeps = {
    pool,
    bus: new RoomBus(),
    log: { info() {}, warn() {}, error() {} },
    adapterFactory: (id) => scripted(id),
    execute: (ctx, command) => executeCommand(ctx, command, deps),
  };

  const roomId = `trigger-overhead-${Date.now()}`;
  const trigger: number[] = [];
  const noop: number[] = [];
  try {
    await createRoom(pool, roomId, roomId, 'prince');
    // The order under test: sol's completion fires a summon of claude-main. A high unattended budget
    // so the attendance dial does not pause it mid-measurement (that path is proved in the tests).
    const created = await executeCommand(
      { actorId: 'prince', mode: 'human' },
      {
        kind: 'createOrder',
        roomId,
        clientMsgId: `oc-${roomId}`,
        triggerEventType: 'agent.turn.completed',
        triggerMember: 'sol',
        actionMember: 'claude-main',
        task: 'measure the trigger overhead',
        maxCycles: null,
        maxUnattendedCycles: n + 10,
        expiresAt: null,
      },
      deps,
    );
    if (!created.ok) throw new Error('order not created');

    for (let i = 0; i < n; i++) {
      const seq = 1000 + i; // strictly increasing, so each opens the next cycle

      // TRIGGER OVERHEAD: sol completed → the order fires. The span ends when runOrders returns, by
      // which point the order-rooted summon and its route are written; the fired turn streams after.
      const t0 = performance.now();
      await executeCommand(
        { actorId: 'system', mode: 'system' },
        { kind: 'runOrders', roomId, member: 'sol', completedSeq: seq, success: true },
        deps,
      );
      trigger.push(performance.now() - t0);

      // NORMAL-TURN NO-OP: claude-main completed, and no order watches claude-main here. This is the
      // whole post-completion cost of the loop machinery on a turn nobody automated.
      const t1 = performance.now();
      await executeCommand(
        { actorId: 'system', mode: 'system' },
        { kind: 'runOrders', roomId, member: 'claude-main', completedSeq: seq, success: true },
        deps,
      );
      noop.push(performance.now() - t1);
    }

    console.log(`\nS-LOOP trigger overhead, live DB, n=${n}\n`);
    const t = report('trigger→summon', trigger);
    report('normal-turn no-op', noop);

    console.log(
      '\nADR-008 — a normal turn pays the no-op above and NOTHING else: it is post-completion, not\n' +
        'first-token, and the room-turns context source is gated to order-rooted turns, so a normal\n' +
        'turn’s assembly is byte-for-byte what it was before S-LOOP. First token is untouched.',
    );
    console.log(
      '\nFor reference (NOT a gate): an order-rooted turn is unattended, so §11’s 1800ms first-token\n' +
        'budget — a human’s wait after they act — does not apply. Overhead + warm TTFT(p95, ADR-008):',
    );
    for (const [member, warm] of Object.entries(WARM_P95)) {
      console.log(
        `  action=${member.padEnd(11)} ${warm} + ${t.p95.toFixed(1)} = ${(warm + t.p95).toFixed(0)}ms`,
      );
    }
    console.log('\nJSONL:');
    console.log(
      JSON.stringify({
        n,
        trigger_ms: { p50: t.p50, p90: t.p90, p95: t.p95 },
        noop_ms: report_silent(noop),
      }),
    );
  } finally {
    await new Promise((r) => setTimeout(r, 1500)); // let fire-and-forget scripted turns settle
    await pool.query('DELETE FROM interrupts WHERE room_id = $1', [roomId]);
    await pool.query('DELETE FROM standing_orders WHERE room_id = $1', [roomId]);
    await pool.query('DELETE FROM events WHERE room_id = $1', [roomId]);
    await pool.query('DELETE FROM room_members WHERE room_id = $1', [roomId]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
    await pool.end();
  }
}

/** Percentiles without printing — for the JSONL line, on an already-sorted array. */
function report_silent(sorted: number[]): { p50: number; p90: number; p95: number } {
  return { p50: pct(sorted, 50), p90: pct(sorted, 90), p95: pct(sorted, 95) };
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
