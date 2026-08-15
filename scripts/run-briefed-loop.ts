// scripts/run-briefed-loop.ts — ONE BRIEFED CYCLE, FOR REAL (S-LOOP2, SL2-4).
//
//   pnpm tsx scripts/run-briefed-loop.ts
//
// Real providers, real tokens, real money. Everything else in this slice is a test with a scripted
// adapter; this is the run that spends. It drives the whole loop end to end and prints the numbers:
//
//   1. a room with an OWNER and a real briefing the owner set
//   2. a standing order (dial at 1 — see SL2-N4, the hard gate)
//   3. a human kick → a real turn → the order fires → THE BRIEFED CYCLE, a real turn that read the
//      briefing as its first region
//   4. a puller (claude-code) reads the briefing through the door and posts its brief as a MESSAGE
//   5. what the cycle cost, and what the BRIEFING cost, measured against a control room that is
//      identical except that it has no briefing — a provider-counted token diff, not a chars/4 estimate
//
// ── WHICH DATABASE, AND WHY IT IS NOT THE OTHER ONE ──
//
// TEST_DATABASE_URL, and it REFUSES to run if that resolves to the same database as DATABASE_URL.
// DATABASE_URL is production (SCC3-N1) and production is at migration 024: it has no `room_briefings`
// table and no `rooms.created_by`, so a briefing cannot exist there at all (SL2-N1). This run is
// therefore LOCAL — a real provider against the test database — and it is labelled local everywhere
// it is reported. Nothing here pretends to be the live tier.
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createAdapter } from '@playroom/adapters';
import { loadRootEnv } from '../apps/api/src/env.js';
import { makePool } from '../apps/api/src/db.js';
import { RoomBus } from '../apps/api/src/bus.js';
import { createRoom } from '../apps/api/src/events.js';
import { setBriefing } from '../apps/api/src/briefings.js';
import { issueCredential } from '../apps/api/src/credentials.js';
import { buildServer } from '../apps/api/src/server.js';
import { executeCommand, type CommandDeps } from '../apps/api/src/commands/index.js';

loadRootEnv();

const BRIEFING =
  'REVIEW ONLY. Say what you would cut, in two sentences, and open a follow-up for anything deferred.';
const KICK = '@sol draft one sentence about why a standing order needs an owner.';

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
    const rows = await turns(pool, roomId);
    if (rows.some((r) => r.actor_id === member)) return;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${member}'s turn in ${roomId}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** A room, its owner, its order, and a human kick — the whole setup a loop needs. */
async function seedRoom(
  deps: CommandDeps,
  pool: Pool,
  roomId: string,
  withBriefing: boolean,
): Promise<string> {
  await createRoom(pool, roomId, roomId, 'prince');
  if (withBriefing) {
    await setBriefing(pool, {
      roomId,
      content: BRIEFING,
      purpose: 'the nightly review loop',
      setBy: 'prince',
    });
  }
  const created = await executeCommand(
    { actorId: 'prince', mode: 'human' },
    {
      kind: 'createOrder',
      roomId,
      clientMsgId: `oc-${roomId}`,
      triggerEventType: 'agent.turn.completed',
      triggerMember: 'sol',
      actionMember: 'claude-main',
      maxCycles: null,
      // THE DIAL AT 1 — SL2-N4's gate. One unattended cycle, then it stops and asks for a person.
      maxUnattendedCycles: 1,
      expiresAt: null,
    },
    deps,
  );
  if (!created.ok) throw new Error(`order not created for ${roomId}`);
  return created.orderId!;
}

async function main(): Promise<void> {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) throw new Error('TEST_DATABASE_URL is not set');
  if (testUrl === process.env.DATABASE_URL) {
    throw new Error('refusing to run: TEST_DATABASE_URL and DATABASE_URL are the same database');
  }

  const pool = makePool(testUrl);
  const stamp = Date.now();
  const briefed = `sl2-live-${stamp}`;
  const control = `sl2-ctrl-${stamp}`;

  const deps: CommandDeps = {
    pool,
    bus: new RoomBus(),
    log: {
      info: (o: unknown, m?: string) => console.log(`  · ${m ?? ''}`, JSON.stringify(o)),
      warn: (o: unknown, m?: string) => console.log(`  ! ${m ?? ''}`, JSON.stringify(o)),
      error: (o: unknown, m?: string) => console.log(`  ✗ ${m ?? ''}`, JSON.stringify(o)),
    },
    // THE REAL FACTORY. Every turn below is a provider call against a real key.
    adapterFactory: createAdapter,
    execute: (ctx, command) => executeCommand(ctx, command, deps),
  };

  console.log(`\n═══ A BRIEFED CYCLE, LIVE (local tier, test database) ═══`);
  console.log(`briefed room: ${briefed}`);
  console.log(`control room: ${control}  (identical, no briefing)`);

  const briefedOrder = await seedRoom(deps, pool, briefed, true);
  const controlOrder = await seedRoom(deps, pool, control, false);

  // ── THE KICK, from a person, in both rooms ──────────────────────────────────────────
  for (const roomId of [briefed, control]) {
    await executeCommand(
      { actorId: 'prince', mode: 'human' },
      { kind: 'postMessage', roomId, clientMsgId: `kick-${roomId}`, body: KICK },
      deps,
    );
  }
  console.log(`\n[1] kicked both rooms with a human message tagging sol`);

  // sol's real turn → its completion is the trigger the order waits for.
  for (const roomId of [briefed, control]) await waitForTurn(pool, roomId, 'sol');
  console.log(`[2] sol answered in both rooms (the trigger)`);

  // ── THE CYCLE. Fired by the seam inside sol's turn; claude-main reads the briefing. ──
  for (const roomId of [briefed, control]) await waitForTurn(pool, roomId, 'claude-main');
  console.log(`[3] the order fired and claude-main took the cycle's turn in both rooms`);

  // ── THE PULLER, through the door ────────────────────────────────────────────────────
  const app = buildServer({ databaseUrl: testUrl });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('expected a TCP address');
  const base = `http://127.0.0.1:${addr.port}`;
  const cred = await issueCredential(pool, 'claude-code', `sl2-live-${stamp}`);

  const historyRes = await fetch(`${base}/rooms/${briefed}/history`, {
    headers: { authorization: `Bearer ${cred.token}` },
  });
  const history = (await historyRes.json()) as {
    briefing: { content: string; set_by: string } | null;
  };
  console.log(
    `[4] claude-code pulled GET /history → briefing ${
      history.briefing ? `PRESENT, set_by=${history.briefing.set_by}` : 'ABSENT'
    }`,
  );

  const posted = await fetch(`${base}/rooms/${briefed}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cred.token}` },
    body: JSON.stringify({
      body: 'CLOSEOUT (claude-code): read the room briefing through the door, reviewed the cycle’s draft under it, and left the pinned briefing untouched.',
      client_msg_id: `cc-closeout-${stamp}`,
    }),
  });
  console.log(`[5] claude-code posted its brief as a MESSAGE → ${posted.status}`);

  // ── WHERE THE LOOP STOPPED, AND WHAT A PERSON'S MESSAGE DOES ────────────────────────
  const orderRow = async (id: string) => {
    const { rows } = await pool.query<{
      status: string;
      pause_reason: string | null;
      unattended_count: number;
      cycle_count: number;
    }>(
      `SELECT status, pause_reason, unattended_count, cycle_count FROM standing_orders WHERE id = $1`,
      [id],
    );
    return rows[0];
  };
  const stopped = await orderRow(briefedOrder);
  console.log(
    `[6] the order: status=${stopped.status} cycles=${stopped.cycle_count} unattended=${stopped.unattended_count}`,
  );
  console.log(`    reason: ${stopped.pause_reason ?? '(none)'}`);

  await executeCommand(
    { actorId: 'prince', mode: 'human' },
    { kind: 'postMessage', roomId: briefed, clientMsgId: `attend-${stamp}`, body: 'back — nice.' },
    deps,
  );
  await new Promise((r) => setTimeout(r, 1500));
  const afterMessage = await orderRow(briefedOrder);
  console.log(
    `[7] after Prince's message: status=${afterMessage.status} unattended=${afterMessage.unattended_count}`,
  );

  // ── THE NUMBERS ─────────────────────────────────────────────────────────────────────
  const briefedTurns = await turns(pool, briefed);
  const controlTurns = await turns(pool, control);
  const cycleOf = (rows: TurnRow[]) => rows.find((r) => r.actor_id === 'claude-main');
  const usd = (rows: TurnRow[]) => rows.reduce((n, r) => n + Number(r.cost_usd ?? 0), 0);

  console.log(`\n═══ WHAT IT COST ═══`);
  for (const [label, rows] of [
    ['briefed', briefedTurns],
    ['control', controlTurns],
  ] as const) {
    for (const t of rows) {
      console.log(
        `  ${label} ${t.actor_id.padEnd(12)} in=${t.tokens_in} out=${t.tokens_out} cost=$${t.cost_usd} success=${t.success}${
          t.error_class ? ` error=${t.error_class}` : ''
        }`,
      );
    }
  }
  const b = cycleOf(briefedTurns);
  const c = cycleOf(controlTurns);
  if (b?.tokens_in != null && c?.tokens_in != null) {
    const delta = b.tokens_in - c.tokens_in;
    // THE CONFOUND, STATED. The two rooms are identical in setup but NOT in what the models said:
    // the trigger member answers each room separately, and its reply rides into the cycle's window
    // as `room-turns`. So the raw delta is an UPPER BOUND on the briefing, and subtracting the
    // trigger's extra output tokens gives the point estimate. Reporting only the raw number would
    // charge the briefing for words sol happened to write.
    const solBriefed = briefedTurns.find((r) => r.actor_id === 'sol')?.tokens_out ?? 0;
    const solControl = controlTurns.find((r) => r.actor_id === 'sol')?.tokens_out ?? 0;
    const carried = solBriefed - solControl;
    console.log(
      `\n  THE BRIEFING'S CONTRIBUTION: +${delta} input tokens on the cycle's turn ` +
        `(${b.tokens_in} briefed vs ${c.tokens_in} control), provider-counted — an UPPER BOUND.`,
    );
    console.log(
      `  the trigger's reply differed by ${carried} output tokens, which ride into the cycle's ` +
        `window as room-turns, so the briefing's own share is ≈ ${delta - carried} tokens.`,
    );
    console.log(`  briefing length: ${BRIEFING.length} chars`);
  }
  const ceiling = process.env.PLAYROOM_DAILY_USD_CEILING ?? '(unset)';
  console.log(
    `\n  cycle total (briefed room): $${usd(briefedTurns).toFixed(6)}  ·  daily ceiling: $${ceiling}`,
  );

  const { rows: spend } = await pool.query<{ total: string }>(
    `SELECT coalesce(sum(cost_usd), 0) AS total FROM events
      WHERE cost_usd IS NOT NULL AND ts >= date_trunc('day', now() AT TIME ZONE 'utc')`,
  );
  console.log(`  today's total spend in this database: $${Number(spend[0].total).toFixed(6)}`);

  await pool.query('DELETE FROM member_credentials WHERE id = $1', [cred.id]);
  await app.close();
  await pool.end();
  console.log(
    `\nrun id: ${randomUUID().slice(0, 8)} — rooms left in place as the record of the run.`,
  );
  // EXPLICIT. A fired cycle leaves fire-and-forget work (the runner, the interrupt) holding handles
  // this process does not own, so waiting for an empty event loop waits forever — the first run of
  // this script did exactly that, after completing every step.
  process.exit(0);
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
