// scripts/seed-room.ts — one room a stranger can actually open.
//
//   pnpm tsx scripts/seed-room.ts [room-id]
//
// THROUGH THE PRODUCT'S OWN FUNCTION. `createRoom` inserts the room, enrols every current member
// and enrols the creator, all in one transaction — and after S1.3b's front door, a room with no
// members cannot be opened by ANYONE, including the person who made it. Seeding with raw SQL would
// be seeding exactly the shape the handshake refuses, and it would drift from the route the moment
// enrolment changes.
//
// Structured as main() rather than top-level await, matching migrate.ts: this directory is
// transformed to CJS, where top-level await does not compile.
import { makePool } from '../apps/api/src/db.js';
import { createRoom } from '../apps/api/src/events.js';
import { loadRootEnv } from '../apps/api/src/env.js';

loadRootEnv();

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const id = process.argv[2] ?? 'playroom';

  const pool = makePool(url);
  try {
    // `prince` is the seeded human member (migration 007). The bootstrap mints that member's
    // credential, so the room it creates is a room that credential can open.
    const room = await createRoom(pool, id, 'Playroom', 'prince');
    // The prefix is what `bootstrap.mjs` greps for. Machine-readable first, human-readable after.
    console.log(`room:${room.id}`);
    console.log(`Created "${room.title}" — every current member is enrolled.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
