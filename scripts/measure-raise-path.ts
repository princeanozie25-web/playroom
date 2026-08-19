// scripts/measure-raise-path.ts — WHAT A RAISED HAND COSTS, BEFORE ANYTHING IS DOWNSTREAM OF IT.
//
//   pnpm tsx scripts/measure-raise-path.ts [n]
//
// S-PUSH Phase 0 found that this number did not exist. ADR-005/ADR-008 govern the FIRST-TOKEN path
// and price a human's wait for a model; §11 has no row for claiming a person's attention, and the
// raise path is not on the first-token path at all — it is a budget read, a row, an event and a
// fan-out. So "the raise path is unchanged by S-PUSH" was unmeasurable as written: there was no
// before.
//
// THIS IS THE BEFORE. It runs against the TEST database (never production — it writes rows), with
// no sender in existence, and publishes the distribution with its denominator. SP-3 asserts against
// it with sends off, with the vendor unreachable, and with every subscription dead.
//
// The three call sites are measured separately because they are different shapes of the same act:
//   raiseHand   BLOCKER — a connected member asks for a person (SCC-3)
//   coSign      DECISION — a protected action needs a signature (S2.2)
//   order stop  DECISION — a standing order stopped itself and taps its owner (S-LOOP)
// All three go through the one construction site (`raiseInterrupt`), which is what makes one number
// meaningful; they differ in what they carry, not in what they do.
import type { Pool } from 'pg';
import { loadRootEnv } from '../apps/api/src/env.js';
import { makePool } from '../apps/api/src/db.js';
import { createRoom, admitMember } from '../apps/api/src/events.js';
import { raiseInterrupt } from '../apps/api/src/interrupts.js';

loadRootEnv();

interface Sample {
  site: string;
  ms: number;
}

function stats(xs: number[]): string {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  const f = (n: number) => n.toFixed(1).padStart(6);
  return `min ${f(s[0])}  p50 ${f(at(50))}  p90 ${f(at(90))}  p95 ${f(at(95))}  max ${f(s[s.length - 1])}  (n=${s.length})`;
}

async function main(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set');
  if (url === process.env.DATABASE_URL) {
    throw new Error('refusing: TEST_DATABASE_URL and DATABASE_URL are the same database');
  }
  const n = Number(process.argv[2] ?? 40);
  const pool: Pool = makePool(url);
  const roomId = `raise-measure-${Date.now()}`;
  await createRoom(pool, roomId, roomId, 'prince');
  // ADR-009: createRoom now enrols only the creator, so admit each member that raises here.
  await admitMember(pool, roomId, 'claude-code');
  await admitMember(pool, roomId, 'claude-main');
  await admitMember(pool, roomId, 'sol');

  // A budget big enough that no sample is refused: a refusal returns BEFORE the row is written and
  // would time a different, shorter path. The measurement is of the path that DOES the work.
  await pool.query(
    "DELETE FROM events WHERE event_type IN ('interrupt.raised', 'interrupt.downgraded')",
  );

  const sites = [
    { site: 'raiseHand (BLOCKER)', urgency: 'BLOCKER', raisedBy: 'claude-code', aboutKind: 'hand' },
    {
      site: 'coSign (DECISION)',
      urgency: 'DECISION',
      raisedBy: 'claude-main',
      aboutKind: 'decision',
    },
    { site: 'order stop (DECISION)', urgency: 'DECISION', raisedBy: 'sol', aboutKind: 'order' },
  ] as const;

  const samples: Sample[] = [];
  for (const s of sites) {
    for (let i = 0; i < n; i++) {
      // A fresh about_id per sample: the uniqueness index collapses a repeat into the existing-row
      // branch, which is a read and not a raise, and averaging the two would report neither.
      const t0 = performance.now();
      const r = await raiseInterrupt(pool, {
        roomId,
        urgency: s.urgency,
        raisedBy: s.raisedBy,
        addressedTo: 'prince',
        aboutKind: s.aboutKind,
        aboutId: `${s.site}-${i}-${Date.now()}`,
        summary: 'a measurement of the raise path, with nothing downstream of it',
      });
      const ms = performance.now() - t0;
      if (!r.ok) {
        console.log(`  ! ${s.site} refused at sample ${i}: ${r.failure} — budget exhausted?`);
        break;
      }
      samples.push({ site: s.site, ms });
      // The budget is per raiser per day; clear the ledger so a long run does not measure the
      // refusal path once the daily allowance is spent.
      await pool.query(
        "DELETE FROM events WHERE room_id = $1 AND event_type = 'interrupt.raised'",
        [roomId],
      );
    }
  }

  console.log(`\n═══ THE RAISE PATH, WITH NOTHING DOWNSTREAM OF IT (test database) ═══`);
  for (const s of sites) {
    const xs = samples.filter((x) => x.site === s.site).map((x) => x.ms);
    if (xs.length) console.log(`  ${s.site.padEnd(24)} ${stats(xs)}`);
  }
  const all = samples.map((x) => x.ms);
  console.log(`  ${'ALL SITES'.padEnd(24)} ${stats(all)}`);
  console.log(
    `\n  Neon over the public internet from this machine. The floor is a round trip, not compute:\n` +
      `  the path is one budget read, one insert, one event insert and an in-process fan-out.`,
  );

  await pool.query('DELETE FROM interrupts WHERE room_id = $1', [roomId]);
  await pool.query('DELETE FROM events WHERE room_id = $1', [roomId]);
  await pool.query('DELETE FROM room_members WHERE room_id = $1', [roomId]);
  await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
  await pool.end();
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
