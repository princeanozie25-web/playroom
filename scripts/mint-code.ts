// scripts/mint-code.ts — mint a room code for one guest seat.
//
//   pnpm tsx scripts/mint-code.ts --room playroom --label "Amara (phone test)"
//   pnpm tsx scripts/mint-code.ts --list --room playroom
//
// PRINTED ONCE, NEVER COMMITTED. The code is not a secret in the way a credential is — it is
// short and single-use on purpose — but it is a claim on an identity for as long as it is
// unredeemed, so it goes in a text message to one person and nowhere else.
//
// The seat is chosen for you: the first guest principal with no live code and no past redemption.
// Choosing it by hand is how a code gets minted against `principal:prince`, which `mintRoomCode`
// refuses — but a refusal you never trigger is better than one you have to read.
import { makePool } from '../apps/api/src/db.js';
import { loadRootEnv } from '../apps/api/src/env.js';
import { MintRefused, listRoomCodes, mintRoomCode } from '../apps/api/src/room-codes.js';

loadRootEnv();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const roomId = arg('room') ?? 'playroom';
  const pool = makePool(url);
  try {
    if (process.argv.includes('--list')) {
      const codes = await listRoomCodes(pool, roomId);
      if (codes.length === 0) {
        console.log(`no codes for room "${roomId}"`);
        return;
      }
      for (const c of codes) {
        const who = c.redeemed_by
          ? `redeemed by ${c.redeemed_by}`
          : `unclaimed, expires ${c.expires_at}`;
        console.log(`${c.code}  ${c.label}  — ${who}`);
      }
      return;
    }

    const label = arg('label');
    if (!label) throw new Error('--label is required: say who this code is for');

    // The next free seat. A guest principal with nothing live and nothing spent.
    const { rows } = await pool.query<{ id: string }>(
      `SELECT p.id FROM principals AS p
        WHERE p.guest = true
          AND NOT EXISTS (SELECT 1 FROM room_codes AS c WHERE c.principal_id = p.id)
        ORDER BY p.ordinal
        LIMIT 1`,
    );
    const seat = rows[0]?.id;
    if (!seat) {
      // Stated as the real constraint rather than as "no seats": the ceiling is the accent palette,
      // and knowing that is what tells you the fix is a design decision, not another INSERT.
      console.error(
        'no free guest seat. There are two, capped by the four-hue accent palette\n' +
          '(migration 017) — a third external tester needs a palette decision first.\n' +
          'Run with --list to see which seats are taken.',
      );
      process.exit(1);
    }

    const code = await mintRoomCode(pool, {
      roomId,
      principalId: seat,
      label,
      codeHours: Number(arg('code-hours') ?? 24),
      credentialHours: Number(arg('credential-hours') ?? 48),
      createdBy: arg('by') ?? 'prince',
    });
    console.log('');
    console.log(`  ${code.code}`);
    console.log('');
    console.log(`  for      ${code.label}`);
    console.log(`  room     ${code.room_id}`);
    console.log(`  seat     ${code.principal_id}`);
    console.log(`  claim by ${code.expires_at}`);
    console.log(`  then valid for ${code.credential_hours}h`);
    console.log('');
    console.log('  Send this to one person. It works once.');
  } catch (err) {
    if (err instanceof MintRefused) {
      console.error(`refused: ${err.reason}`);
      process.exit(1);
    }
    throw err;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
