// scripts/measure-summon-latency.ts — S1.8's latency number: what the STRUCTURED channel adds.
//
// The question the slice has to answer: does an agent-emitted summon (the tool-call channel) push a
// summon-path first-token past ADR-008's warm budget (P50 < 900ms, P95 < 1.8s)? The answer has two
// halves, and this measures the one that is new:
//
//   * B's OWN first token is unchanged. An emitted summon converges on the SAME constructor and the
//     SAME `triggerAgentTurn` a human summon uses — B's provider call is byte-for-byte the human path.
//     So B's TTFT is the warm-path distribution ADR-008 already published (sol P95 698ms, claude-main
//     P95 1742ms) and this script does not re-measure it: it would be measuring the provider, again.
//   * The CONVERGENCE OVERHEAD is new: the work `summonCommand`'s agent branch does that a human
//     summon does not — `listRoomMembers` (the roster, read ONCE) + `evaluate(summon.initiate)` +
//     `matchRoomAgent` (target-in-room, resolved from that same read). All warm-DB and CPU, all BEFORE
//     B's provider call. THIS is the added latency, and this is what the script times, n high, live.
//
// The reported first-token is then the sum: convergence overhead + B's warm-path TTFT. The exit is
// whether that sum stays inside ADR-008. It makes NO provider call and spends NO tokens — the overhead
// is DB + evaluate, and B's half is a published number, not a fresh spend.
//
//   pnpm tsx scripts/measure-summon-latency.ts [n]      e.g. 500
//
// A SCRIPT, NOT A TEST: it hits the live database and must never run in CI or `pnpm verify`.
import { performance } from 'node:perf_hooks';
import { evaluate } from '../packages/fabric/src/index.js';
import { loadRootEnv } from '../apps/api/src/env.js';
import { makePool } from '../apps/api/src/db.js';
import { createRoom } from '../apps/api/src/events.js';
import { listRoomMembers, matchRoomAgent } from '../apps/api/src/members.js';
import { mandateFor } from '../apps/api/src/mandates.js';
import { SUMMON_INITIATE_ACTION } from '../apps/api/src/agent.js';

loadRootEnv();

// The warm-path first-token P95, per member, from ADR-008 (measured 2026-07-26 against live providers).
// B's summon-path first token is its warm TTFT PLUS the convergence overhead measured here; the exit is
// that this sum stays under §11's P95 of 1800ms. claude-main is the tight one — 58ms of headroom warm.
const WARM_P95: Record<string, number> = { 'claude-main': 1742, sol: 698 };
const P95_BUDGET_MS = 1800;

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const n = Number(process.argv[2] ?? '500');
  const emitter = 'claude-main'; // the only member granted summon.initiate this slice
  const target = 'sol';

  const pool = makePool(url);
  const roomId = `sumlat-${Date.now()}`;
  try {
    // createRoom enrols every non-guest member, so claude-main and sol are agent members of this room —
    // exactly the state summonCommand's agent branch resolves against.
    await createRoom(pool, roomId, roomId, 'prince');

    // Warm the path once (mandate validation, member reads) so the first sample is not a cold outlier —
    // ADR-008's rule: a first sample after idle is a cold number and belongs in its own row, not here.
    await listRoomMembers(pool, roomId);

    const overhead: number[] = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      // The agent branch's added work, in the order summonCommand runs it — ONE roster read, used for
      // BOTH the evaluator's roster and target resolution (the second read was the regression).
      const roomMembers = await listRoomMembers(pool, roomId);
      evaluate(
        { type: SUMMON_INITIATE_ACTION, resource: `member:${target}` },
        emitter,
        mandateFor(emitter),
        undefined,
        roomMembers.map((m) => m.id),
      );
      matchRoomAgent(roomMembers, target);
      overhead.push(performance.now() - t0);
    }

    overhead.sort((a, b) => a - b);
    const p50 = pct(overhead, 50);
    const p90 = pct(overhead, 90);
    const p95 = pct(overhead, 95);
    const min = overhead[0];
    const max = overhead[overhead.length - 1];

    console.log(`convergence overhead of the structured summon channel (n=${n}), ms\n`);
    console.log(
      `  min ${min.toFixed(1)}  p50 ${p50.toFixed(1)}  p90 ${p90.toFixed(1)}  ` +
        `p95 ${p95.toFixed(1)}  max ${max.toFixed(1)}\n`,
    );

    console.log(
      'summon-path first token = convergence overhead (p95) + B warm TTFT (p95, ADR-008):',
    );
    for (const [member, warm] of Object.entries(WARM_P95)) {
      const total = warm + p95;
      const flag =
        total < P95_BUDGET_MS ? `under ${P95_BUDGET_MS}ms ✓` : `OVER ${P95_BUDGET_MS}ms ✗`;
      console.log(
        `  B=${member.padEnd(11)} ${warm}ms + ${p95.toFixed(1)}ms = ${total.toFixed(0)}ms — ${flag}`,
      );
    }

    console.log('\nJSONL:');
    console.log(
      JSON.stringify({
        n,
        overhead_ms: { min, p50, p90, p95, max },
        first_token_p95_ms: Object.fromEntries(
          Object.entries(WARM_P95).map(([m, w]) => [m, Number((w + p95).toFixed(0))]),
        ),
      }),
    );
  } finally {
    await pool.query('DELETE FROM events WHERE room_id = $1', [roomId]);
    await pool.query('DELETE FROM room_members WHERE room_id = $1', [roomId]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
    await pool.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
