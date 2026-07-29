// scripts/seed-loop.ts — a two-member loop, ready to film.
//
//   pnpm tsx scripts/seed-loop.ts [room-id] [max-unattended] [max-cycles]
//     e.g.  pnpm tsx scripts/seed-loop.ts loop-demo 3 8
//
// Sets up the room and the two standing orders that make a Claude ⇄ Sol cycle — draft → review →
// revise — then prints the one thing left for a person to do: open the room and tag `@claude` to kick
// cycle 0. Everything after is order-rooted and runs on its own, bounded by the dial and the limits.
//
// THROUGH THE PRODUCT'S OWN FUNCTIONS. `createRoom` enrols every member; `createOrder` runs the same
// command a WS frame would, so the orders are minted exactly as a person would mint them — human
// creator, agent trigger/action, evented and projected. Nothing here is raw SQL, so nothing here can
// seed a shape the running app would refuse. The orders are DB-backed, so the running server picks them
// up without a restart.
//
// Structured as main() rather than top-level await, matching migrate.ts: this directory is transformed
// to CJS, where top-level await does not compile.
import type { AgentAdapter, AgentTurnChunk } from '@playroom/shared';
import { loadRootEnv } from '../apps/api/src/env.js';
import { makePool } from '../apps/api/src/db.js';
import { RoomBus } from '../apps/api/src/bus.js';
import { createRoom } from '../apps/api/src/events.js';
import { executeCommand, type CommandDeps } from '../apps/api/src/commands/index.js';

loadRootEnv();

function scripted(id: string): AgentAdapter {
  return {
    id,
    async *stream(): AsyncGenerator<AgentTurnChunk> {
      yield { kind: 'done', tokens_in: 0, tokens_out: 0, stop_reason: 'end_turn' };
    },
  };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const roomId = process.argv[2] ?? 'loop-demo';
  const maxUnattended = Number(process.argv[3] ?? '3');
  const maxCyclesArg = process.argv[4];
  const maxCycles = maxCyclesArg ? Number(maxCyclesArg) : null;

  const pool = makePool(url);
  const deps: CommandDeps = {
    pool,
    bus: new RoomBus(),
    log: { info() {}, warn() {}, error() {} },
    adapterFactory: (id) => scripted(id),
    execute: (ctx, command) => executeCommand(ctx, command, deps),
  };

  try {
    await createRoom(pool, roomId, 'Loop demo', 'prince');

    // Two orders make the cycle. Prince (a human) creates both; each names agent members of the room.
    const orders: Array<{ label: string; trigger: string; action: string }> = [
      { label: 'A', trigger: 'sol', action: 'claude-main' }, // Sol completed → summon Claude
      { label: 'B', trigger: 'claude-main', action: 'sol' }, // Claude completed → summon Sol
    ];
    for (const o of orders) {
      const created = await executeCommand(
        { actorId: 'prince', mode: 'human' },
        {
          kind: 'createOrder',
          roomId,
          clientMsgId: `seed-order-${o.label}`,
          triggerEventType: 'agent.turn.completed',
          triggerMember: o.trigger,
          actionMember: o.action,
          maxCycles,
          maxUnattendedCycles: maxUnattended,
          expiresAt: null,
        },
        deps,
      );
      if (!created.ok) {
        throw new Error(`order ${o.label} not created: ${JSON.stringify(created.refusal)}`);
      }
      console.log(
        `order:${created.orderId} — when ${o.trigger} completes, summon ${o.action} ` +
          `(unattended ${maxUnattended}${maxCycles === null ? '' : `, max ${maxCycles} cycles`})`,
      );
    }

    console.log(`\nroom:${roomId}`);
    console.log('Two standing orders are live. To kick the loop:');
    console.log('  1. Open the room in the web app.');
    console.log('  2. Tag `@claude` with an opening ("draft the opening line").');
    console.log('Claude drafts → Order B fires → Sol reviews → Order A fires → Claude revises → …');
    console.log(
      `The dial pauses it after ${maxUnattended} unattended cycles; resume with one tap.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
