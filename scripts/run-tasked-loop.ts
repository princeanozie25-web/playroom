// scripts/run-tasked-loop.ts — A CYCLE THAT DOES THE WORK, FOR REAL (S-TASK, ST-4).
//
//   pnpm tsx scripts/run-tasked-loop.ts
//
// SL2-4 proved a briefed cycle RUNS. It also proved the loop was not yet useful: the order summoned
// with a generic intent, the briefing framed without asking, and the cycle spent a paid turn replying
// that it could not see a specific request (SL2-N5). This runs the same loop with an OBJECTIVE on the
// order and prints what came back, so "it does the work instead of asking what the work is" is a
// thing you read rather than a thing you are told.
//
// It does two separable things, and keeps them separate on purpose:
//
//   THE RUN         a genuine end-to-end cycle: a human kick, a REAL trigger turn, a REAL cycle turn,
//                   dial at 1, ending in the loop pausing for a person. Nothing scripted.
//   THE MEASUREMENT a controlled pair: the SAME scripted trigger text in both rooms, the same
//                   briefing, and the only difference is the order's task — a full one against a
//                   minimal one. SL2-N6's trigger asked for exactly this ("a real number needs the
//                   trigger's output held fixed, with a real cycle member"), because SL2-4's control
//                   room let the trigger's own reply ride into the cycle's window and be charged to
//                   the briefing.
//
// LOCAL TIER, TEST DATABASE. Production is at migration 024 (SL2-N1): no room_briefings, no
// rooms.created_by, and now no standing_orders.task either. This refuses to run against it.
import type { Pool } from 'pg';
import type { AgentAdapter, AgentTurnChunk } from '@playroom/shared';
import { createAdapter } from '@playroom/adapters';
import { loadRootEnv } from '../apps/api/src/env.js';
import { makePool } from '../apps/api/src/db.js';
import { RoomBus } from '../apps/api/src/bus.js';
import { createRoom } from '../apps/api/src/events.js';
import { setBriefing } from '../apps/api/src/briefings.js';
import { executeCommand, type CommandDeps } from '../apps/api/src/commands/index.js';

loadRootEnv();

const BRIEFING =
  'HOW WORK IS DONE HERE: be concrete and brief. Never ask a clarifying question — if something is unclear, say which part is unclear and answer anyway.';

/** THE OBJECTIVE. Genuine work: it asks for a judgement about a specific thing, in a fixed shape. */
const TASK =
  'Review the draft immediately above in this room. Reply with exactly two lines. Line 1: "CUT: " followed by the one sentence you would remove, quoted. Line 2: "WHY: " followed by one sentence of reason. Do not ask questions and do not add anything else.';

/** The minimal objective the control room's order carries — same shape of thing, almost no text. */
const MINIMAL_TASK = 'Continue.';

const KICK = '@sol draft two sentences on why a standing order needs an owner.';

/** The draft the SCRIPTED trigger writes — byte-identical in both measurement rooms. */
const SCRIPTED_DRAFT =
  'A standing order needs an owner because recurring work is authority that keeps acting after the person who authorised it has stopped paying attention. The owner is who the loop answers to, and who can stop it.';

function scriptedSol(id: string): AgentAdapter {
  return {
    id,
    async *stream(): AsyncGenerator<AgentTurnChunk> {
      yield { kind: 'text_delta', text: SCRIPTED_DRAFT };
      yield { kind: 'done', tokens_in: 0, tokens_out: 0, stop_reason: 'end_turn' };
    },
  };
}

interface TurnRow {
  actor_id: string;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: string | null;
  success: boolean;
  error_class: string | null;
  text: string;
}

async function turns(pool: Pool, roomId: string): Promise<TurnRow[]> {
  const { rows } = await pool.query<TurnRow>(
    `SELECT actor_id, tokens_in, tokens_out, cost_usd, success, error_class,
            coalesce(payload ->> 'text', '') AS text
       FROM events WHERE room_id = $1 AND event_type = 'agent.turn.completed' ORDER BY seq`,
    [roomId],
  );
  return rows;
}

async function waitForTurn(pool: Pool, roomId: string, member: string, ms = 90000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if ((await turns(pool, roomId)).some((r) => r.actor_id === member)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${member} in ${roomId}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function seed(deps: CommandDeps, pool: Pool, roomId: string, task: string): Promise<string> {
  await createRoom(pool, roomId, roomId, 'prince');
  await setBriefing(pool, {
    roomId,
    content: BRIEFING,
    purpose: 'the nightly review loop',
    setBy: 'prince',
  });
  const created = await executeCommand(
    { actorId: 'prince', mode: 'human' },
    {
      kind: 'createOrder',
      roomId,
      clientMsgId: `oc-${roomId}`,
      triggerEventType: 'agent.turn.completed',
      triggerMember: 'sol',
      actionMember: 'claude-main',
      task,
      maxCycles: null,
      maxUnattendedCycles: 1, // SL2-N4's gate: one unattended cycle, then it asks for a person
      expiresAt: null,
    },
    deps,
  );
  if (!created.ok) throw new Error(`order not created for ${roomId}: ${JSON.stringify(created)}`);
  return created.orderId!;
}

function makeDeps(pool: Pool, factory: (id: string) => AgentAdapter): CommandDeps {
  const deps: CommandDeps = {
    pool,
    bus: new RoomBus(),
    log: { info() {}, warn() {}, error() {} },
    adapterFactory: factory,
    execute: (ctx, command) => executeCommand(ctx, command, deps),
  };
  return deps;
}

async function kick(deps: CommandDeps, roomId: string): Promise<void> {
  await executeCommand(
    { actorId: 'prince', mode: 'human' },
    { kind: 'postMessage', roomId, clientMsgId: `kick-${roomId}`, body: KICK },
    deps,
  );
}

async function main(): Promise<void> {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) throw new Error('TEST_DATABASE_URL is not set');
  if (testUrl === process.env.DATABASE_URL) {
    throw new Error('refusing to run: TEST_DATABASE_URL and DATABASE_URL are the same database');
  }
  const pool = makePool(testUrl);
  const stamp = Date.now();

  // ── THE RUN: everything real ────────────────────────────────────────────────────────
  const live = `st-live-${stamp}`;
  const liveDeps = makeDeps(pool, createAdapter);
  console.log(`\n═══ A TASKED CYCLE, LIVE (local tier, test database) ═══`);
  console.log(`room: ${live}`);
  console.log(`task: ${TASK}\n`);

  const liveOrder = await seed(liveDeps, pool, live, TASK);
  await kick(liveDeps, live);
  await waitForTurn(pool, live, 'sol');
  console.log(`[1] prince tagged sol; sol answered (a real turn — the trigger)`);
  await waitForTurn(pool, live, 'claude-main');
  console.log(`[2] the order fired; claude-main took the cycle's turn with the objective`);

  const liveTurns = await turns(pool, live);
  const draft = liveTurns.find((t) => t.actor_id === 'sol');
  const cycle = liveTurns.find((t) => t.actor_id === 'claude-main');
  console.log(`\n─── THE DRAFT (sol) ───\n${draft?.text ?? '(none)'}`);
  console.log(`\n─── WHAT THE CYCLE DID (claude-main) ───\n${cycle?.text ?? '(none)'}`);

  // DID IT DO THE WORK, OR ASK WHAT THE WORK IS? A crude, honest check on the reply's SHAPE — the
  // text above is the real evidence; this only makes a regression loud.
  const reply = cycle?.text ?? '';
  const didWork = /^\s*CUT:/im.test(reply) && /^\s*WHY:/im.test(reply);
  const askedInstead =
    /\?\s*$/.test(reply.trim()) || /could you|can you clarify|what would you like/i.test(reply);
  console.log(
    `\n[3] shape: followed the objective = ${didWork} · asked for clarification instead = ${askedInstead}`,
  );

  const { rows: orderRows } = await pool.query<{ status: string; pause_reason: string | null }>(
    `SELECT status, pause_reason FROM standing_orders WHERE id = $1`,
    [liveOrder],
  );
  console.log(
    `[4] the order: ${orderRows[0].status} — ${orderRows[0].pause_reason ?? '(running)'}`,
  );

  // ── THE MEASUREMENT: the trigger held fixed, only the task differs (closes SL2-N6's ask) ──
  const full = `st-meas-full-${stamp}`;
  const minimal = `st-meas-min-${stamp}`;
  const measDeps = makeDeps(pool, (id) => (id === 'sol' ? scriptedSol(id) : createAdapter(id)));
  await seed(measDeps, pool, full, TASK);
  await seed(measDeps, pool, minimal, MINIMAL_TASK);
  for (const roomId of [full, minimal]) {
    await kick(measDeps, roomId);
    await waitForTurn(pool, roomId, 'sol');
    await waitForTurn(pool, roomId, 'claude-main');
  }
  const cycleOf = async (roomId: string) =>
    (await turns(pool, roomId)).find((t) => t.actor_id === 'claude-main');
  const a = await cycleOf(full);
  const b = await cycleOf(minimal);

  console.log(`\n═══ WHAT IT COST ═══`);
  for (const t of liveTurns) {
    console.log(
      `  live     ${t.actor_id.padEnd(12)} in=${t.tokens_in} out=${t.tokens_out} cost=$${t.cost_usd}`,
    );
  }
  console.log(
    `  measure  full-task    in=${a?.tokens_in} out=${a?.tokens_out} cost=$${a?.cost_usd}  (task ${TASK.length} chars)`,
  );
  console.log(
    `  measure  minimal-task in=${b?.tokens_in} out=${b?.tokens_out} cost=$${b?.cost_usd}  (task ${MINIMAL_TASK.length} chars)`,
  );
  if (a?.tokens_in != null && b?.tokens_in != null) {
    console.log(
      `\n  THE TASK'S OWN CONTRIBUTION: +${a.tokens_in - b.tokens_in} input tokens for ` +
        `+${TASK.length - MINIMAL_TASK.length} chars — the trigger's text was IDENTICAL in both rooms ` +
        `(scripted), so unlike SL2-4's number this one is not carrying the trigger's reply.`,
    );
  }
  const liveCost = liveTurns.reduce((n, t) => n + Number(t.cost_usd ?? 0), 0);
  console.log(
    `\n  the live cycle cost $${liveCost.toFixed(6)} · ceiling ${process.env.PLAYROOM_DAILY_USD_CEILING ?? '(unset locally)'}`,
  );
  console.log(
    `  capture home: ${process.env.PLAYROOM_CAPTURE_HOME ?? '(unset — no 390px capture)'}`,
  );

  await pool.end();
  // A fired cycle leaves fire-and-forget work holding handles this process does not own.
  process.exit(0);
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
