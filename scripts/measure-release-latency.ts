// scripts/measure-release-latency.ts — S2.2's release-path number: what an APPROVED co-sign adds.
//
// The release path rides the summon path: an approval fires the held summon through the SAME fireSummon
// → triggerAgentTurn a routine summon uses, so B's own first token is the warm-path distribution
// ADR-008 published (sol P95 698ms, claude-main P95 1742ms) — this does not re-measure it. What is NEW
// is the convergence the RELEASE adds before B's turn: signDecision's checks (load the decision, the
// signer, staleness, single-use) + the resolution write + fireSummon's own DB work, all warm and all
// ahead of the provider call. THIS is what the script times, against the live database, n high.
//
// The reported first token is the sum: release overhead + B's warm TTFT. The exit is whether that stays
// inside §11's P95 of 1800ms. It makes NO provider call — the fired turn runs a scripted adapter — so it
// spends NO tokens; the DB is the only cost measured, and B's half is a published number, not a spend.
//
//   pnpm tsx scripts/measure-release-latency.ts [n]      e.g. 40
//
// A SCRIPT, NOT A TEST: it hits the live database and must never run in CI or `pnpm verify`.
import { performance } from 'node:perf_hooks';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentAdapter, AgentTurnChunk } from '@playroom/shared';
import { Mandate, signMandate } from '@playroom/fabric';
import { loadRootEnv } from '../apps/api/src/env.js';
import { makePool } from '../apps/api/src/db.js';
import { RoomBus } from '../apps/api/src/bus.js';
import { createRoom } from '../apps/api/src/events.js';
import { executeCommand, type CommandDeps } from '../apps/api/src/commands/index.js';
import { resetMandateCache } from '../apps/api/src/mandates.js';

loadRootEnv();

const WARM_P95: Record<string, number> = { 'claude-main': 1742, sol: 698 };
const P95_BUDGET_MS = 1800;
const MANDATES_DIR = resolve(import.meta.dirname, '../mandates');

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

/**
 * A temp mandate dir with claude-main's summon.initiate marked protected.
 *
 * Post-S2.1 that edit is a RE-SIGNING, not a text change: the mandates are signed with a throwaway
 * keypair whose public half is returned for the caller to point PLAYROOM_MANDATE_PUBKEY at. Keeping
 * the shipped (now-stale) signature would load claude-main as sig_valid:false, and the evaluator's
 * §0 authenticity check would BLOCK the summon before it ever reached CO_SIGN — the release path
 * would have nothing to measure. This mirrors decision-execution.test.ts's withProtectedSummon.
 */
function protectedMandateDir(): { dir: string; pub: string } {
  const dir = mkdtempSync(join(tmpdir(), 'playroom-release-'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  for (const f of readdirSync(MANDATES_DIR).filter((f) => f.endsWith('.json'))) {
    const raw = JSON.parse(readFileSync(join(MANDATES_DIR, f), 'utf8'));
    delete raw.sig; // drop the shipped signature; every file is re-signed below with the test key
    if (raw.member === 'claude-main') {
      raw.protected_actions = [...raw.protected_actions, 'summon.initiate'];
      raw.co_sign.actions = [...raw.co_sign.actions, 'summon.initiate'];
    }
    const sig = signMandate(Mandate.parse(raw), priv);
    writeFileSync(join(dir, f), JSON.stringify({ ...raw, sig }));
  }
  return { dir, pub };
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

  const { dir, pub } = protectedMandateDir();
  const previousDir = process.env.PLAYROOM_MANDATES_DIR;
  const previousPub = process.env.PLAYROOM_MANDATE_PUBKEY;
  process.env.PLAYROOM_MANDATES_DIR = dir;
  process.env.PLAYROOM_MANDATE_PUBKEY = pub; // verify the re-signed mandates under the throwaway key
  resetMandateCache();

  const roomIds: string[] = [];
  const overhead: number[] = [];
  try {
    for (let i = 0; i < n; i++) {
      const roomId = `release-${Date.now()}-${i}`;
      roomIds.push(roomId);
      await createRoom(pool, roomId, roomId, 'prince');
      // claude-main emits a protected summon of sol → a CO_SIGN decision (paused).
      await executeCommand(
        { actorId: 'claude-main', mode: 'hosted' },
        {
          kind: 'summon',
          roomId,
          member: 'sol',
          causeSeq: 1,
          intent: 'claude-main summoned sol',
          chain: { rootActor: 'prince', rootIsHuman: true, depth: 0 },
        },
        deps,
      );
      const { rows } = await pool.query<{ decision_id: string }>(
        `SELECT payload ->> 'decision_id' AS decision_id FROM events
          WHERE room_id = $1 AND event_type = 'decision' LIMIT 1`,
        [roomId],
      );
      const decisionId = rows[0]?.decision_id;
      if (!decisionId) throw new Error('no decision written — is summon.initiate protected?');

      // THE RELEASE. Time the approval up to fireSummon writing the summon and route (the turn itself
      // is a fire-and-forget scripted stream after this returns, so it is not in the measured span).
      const t0 = performance.now();
      await executeCommand(
        { actorId: 'prince', mode: 'human' },
        {
          kind: 'signDecision',
          roomId,
          clientMsgId: `rel-${i}`,
          decisionId,
          resolution: 'APPROVED',
        },
        deps,
      );
      overhead.push(performance.now() - t0);
    }

    overhead.sort((a, b) => a - b);
    const p50 = pct(overhead, 50);
    const p90 = pct(overhead, 90);
    const p95 = pct(overhead, 95);
    console.log(`release-path convergence overhead (signDecision + fireSummon), n=${n}, ms\n`);
    console.log(
      `  min ${overhead[0].toFixed(1)}  p50 ${p50.toFixed(1)}  p90 ${p90.toFixed(1)}  ` +
        `p95 ${p95.toFixed(1)}  max ${overhead[overhead.length - 1].toFixed(1)}\n`,
    );
    console.log('release-path first token = overhead(p95) + B warm TTFT(p95, ADR-008):');
    for (const [member, warm] of Object.entries(WARM_P95)) {
      const total = warm + p95;
      const flag =
        total < P95_BUDGET_MS ? `under ${P95_BUDGET_MS}ms ✓` : `OVER ${P95_BUDGET_MS}ms ✗`;
      console.log(
        `  B=${member.padEnd(11)} ${warm} + ${p95.toFixed(1)} = ${total.toFixed(0)}ms — ${flag}`,
      );
    }
    console.log('\nJSONL:');
    console.log(JSON.stringify({ n, overhead_ms: { p50, p90, p95 } }));
  } finally {
    await new Promise((r) => setTimeout(r, 1500)); // let fire-and-forget scripted turns settle
    for (const roomId of roomIds) {
      await pool.query('DELETE FROM events WHERE room_id = $1', [roomId]);
      await pool.query('DELETE FROM room_members WHERE room_id = $1', [roomId]);
      await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
    }
    if (previousDir === undefined) delete process.env.PLAYROOM_MANDATES_DIR;
    else process.env.PLAYROOM_MANDATES_DIR = previousDir;
    if (previousPub === undefined) delete process.env.PLAYROOM_MANDATE_PUBKEY;
    else process.env.PLAYROOM_MANDATE_PUBKEY = previousPub;
    resetMandateCache();
    rmSync(dir, { recursive: true, force: true });
    await pool.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
