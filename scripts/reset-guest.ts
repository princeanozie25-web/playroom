// scripts/reset-guest.ts — give a guest seat back.
//
//   pnpm tsx scripts/reset-guest.ts --seat principal:guest-a
//   pnpm tsx scripts/reset-guest.ts --all
//
// ── READ THIS BEFORE RUNNING IT ────────────────────────────────────────────────────────
//
// THIS DESTROYS ATTRIBUTION. It deletes the guest member and every act they took, which is exactly
// what `mintRoomCode`'s `principal_already_redeemed` refusal exists to prevent: a seat handed to a
// second person would silently re-attribute the first person's acts to them.
//
// So it is legitimate for ONE case only — a seat spent while TESTING, by nobody real. If an actual
// tester has used a seat, leave it spent. That rule is the audit log's whole value, and a script
// that makes it convenient to break is a script that will eventually be used to break it. Hence no
// default: you must name the seat or ask for all of them.
//
// The delete order is not guesswork. It follows the thirteen foreign keys that reference `members`,
// read out of `information_schema` rather than discovered one error at a time — which is how this
// script came to exist, after two failed attempts at doing it by hand.
import { makePool } from '../apps/api/src/db.js';
import { loadRootEnv } from '../apps/api/src/env.js';

loadRootEnv();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const seat = arg('seat');
  const all = process.argv.includes('--all');
  if (!seat && !all) {
    console.error(
      'name a seat (--seat principal:guest-a) or --all.\n' +
        'THIS DELETES THE GUEST AND EVERY ACT THEY TOOK — only for seats spent by testing.',
    );
    process.exit(1);
  }

  const pool = makePool(url);
  try {
    // Which humans are being forgotten, and what they did. Printed BEFORE the delete, because the
    // one thing worse than destroying a record is destroying it without reading it.
    const { rows: victims } = await pool.query<{
      id: string;
      display_name: string;
      principal_id: string;
      acts: string;
    }>(
      `SELECT m.id, m.display_name, m.principal_id,
              (SELECT count(*) FROM events e WHERE e.actor_member_id = m.id) AS acts
         FROM members AS m
         JOIN principals AS p ON p.id = m.principal_id
        WHERE p.guest = true AND m.kind = 'human'
          AND ($1::text IS NULL OR m.principal_id = $1)`,
      [seat ?? null],
    );
    if (victims.length === 0) {
      console.log('no redeemed guest seats to reset');
      return;
    }
    for (const v of victims) {
      console.log(`forgetting ${v.display_name} (${v.id}) — ${v.acts} recorded act(s)`);
    }

    const ids = victims.map((v) => v.id);
    const principals = victims.map((v) => v.principal_id);
    // Children first, in FK order. `routes` is untouched: those belong to the AGENT, which stays.
    const steps: Array<[string, string]> = [
      ['ws_tickets', 'DELETE FROM ws_tickets WHERE member_id = ANY($1)'],
      ['interrupts', 'DELETE FROM interrupts WHERE raised_by = ANY($1) OR addressed_to = ANY($1)'],
      ['promotions', 'DELETE FROM promotions WHERE approved_by = ANY($1)'],
      [
        'tasks',
        `DELETE FROM tasks WHERE created_by = ANY($1) OR origin_member = ANY($1)
            OR assignee_member_id = ANY($1)`,
      ],
      ['events', 'DELETE FROM events WHERE actor_member_id = ANY($1)'],
      ['member_credentials', 'DELETE FROM member_credentials WHERE member_id = ANY($1)'],
      ['room_members', 'DELETE FROM room_members WHERE member_id = ANY($1)'],
      // The code rows go last of the referencing tables: they point at the member both ways.
      ['room_codes', 'DELETE FROM room_codes WHERE redeemed_member = ANY($1)'],
      ['members', 'DELETE FROM members WHERE id = ANY($1)'],
    ];
    for (const [name, sql] of steps) {
      const r = await pool.query(sql, [ids]);
      if (r.rowCount) console.log(`  ${name}: ${r.rowCount}`);
    }
    // And the seat goes back to being an empty seat rather than a person.
    await pool.query(
      `UPDATE principals SET display_name = 'Guest ' || upper(right(id, 1)) WHERE id = ANY($1)`,
      [principals],
    );
    console.log(`reset ${principals.join(', ')} — mintable again`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
