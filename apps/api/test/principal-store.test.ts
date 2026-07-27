import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testPool } from './support.js';
import { attemptForeignRead, isolationState, withPrincipalStore } from '../src/principal-store.js';

// THE STORE IS PRIVATE BY CONSTRUCTION (Bible §7.1, §13).
//
// This file asserts the MECHANISM, not the outcome. "Jerry's note did not appear" is satisfied by an
// empty database, a broken query, a typo in a title and a working policy — so every case here
// establishes what was in the store first, then attacks it, then names which mechanism refused.

const pool = testPool();

// THE FIXTURES ARE THE TEST'S OWN, not the seed script's.
//
// `scripts/seed-context.ts` puts real content in both stores, and depending on it here would make
// this file pass or fail according to whether an operator remembered to run it — on a fresh CI
// database it would fail on the corpus assertion while the isolation was perfectly intact. A test
// about a boundary must not be able to go red for a reason unrelated to the boundary.
const MINE = 'store-test prince fixture 4a91';
const THEIRS = 'store-test jerry fixture 7c02';
let planted: Array<{ principal: string; id: string }> = [];

async function deleteAs(principal: string, id: string): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE playroom_context');
    await c.query('SELECT set_config($1, $2, true)', ['playroom.principal_id', principal]);
    await c.query('DELETE FROM principal_context WHERE id = $1', [id]);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  const a = await withPrincipalStore(pool, 'principal:prince', (s) =>
    s.add({ kind: 'note', title: MINE, body: 'prince fixture body' }),
  );
  const b = await withPrincipalStore(pool, 'principal:jerry', (s) =>
    s.add({ kind: 'note', title: THEIRS, body: 'jerry fixture body', summary: 'jerry summary' }),
  );
  planted = [
    { principal: 'principal:prince', id: a.id },
    { principal: 'principal:jerry', id: b.id },
  ];
});

afterAll(async () => {
  for (const p of planted) await deleteAs(p.principal, p.id);
  await pool.end();
});

describe('the isolation is live, not merely configured', () => {
  it('runs as a role that CANNOT bypass row-level security', async () => {
    // The measurement that changed the design. A policy that EXISTS and a policy that APPLIES are
    // different facts: Neon's owner role has BYPASSRLS, so the first version of migration 015
    // enforced NOTHING while reading correctly. Asserted here because the difference is invisible
    // in the schema and total in effect.
    const state = await isolationState(pool, 'principal:prince');
    expect(state.current_user).toBe('playroom_context');
    expect(state.bypassrls, 'the store is running as a role that can bypass its own policy').toBe(
      false,
    );
    expect(state.setting).toBe('principal:prince');
  });

  it('leaves no trace on the pooled connection after the transaction', async () => {
    // `DATABASE_URL` is Neon's POOLED endpoint. A session-scoped `SET` would hand this principal's
    // identity to whichever request borrowed the connection next, so both the role and the setting
    // are `SET LOCAL` — verified by reading them back outside any transaction.
    await withPrincipalStore(pool, 'principal:jerry', async (store) => store.items());
    const { rows } = await pool.query<{ who: string; setting: string | null }>(
      "SELECT current_user AS who, current_setting('playroom.principal_id', true) AS setting",
    );
    expect(rows[0].who).not.toBe('playroom_context');
    expect(rows[0].setting === null || rows[0].setting === '').toBe(true);
  });
});

describe('a foreign store is unreachable', () => {
  it('THE CORPUS FIRST — both principals hold items, so absence means something', async () => {
    // The S1.3b lesson, and the reason it is the first assertion in the file: a test proving nothing
    // is reachable proves nothing at all if it is looking at an empty set. The first run of the
    // corpus guard in S1.3b reported four claims as held while searching twelve files.
    const mine = await withPrincipalStore(pool, 'principal:prince', (s) => s.items());
    const theirs = await withPrincipalStore(pool, 'principal:jerry', (s) => s.items());
    expect(
      mine.length,
      'prince has no context — the leak tests below would be vacuous',
    ).toBeGreaterThan(0);
    expect(
      theirs.length,
      'jerry has no context — the leak tests below would be vacuous',
    ).toBeGreaterThan(0);
    // And they are DIFFERENT items, so "I saw an item" cannot be satisfied by seeing my own. Named
    // exactly, not counted: each store contains its own fixture and not the other's.
    expect(mine.map((i) => i.title)).toContain(MINE);
    expect(theirs.map((i) => i.title)).toContain(THEIRS);
    expect(mine.map((i) => i.title)).not.toContain(THEIRS);
    expect(theirs.map((i) => i.title)).not.toContain(MINE);
  });

  it('a store bound to one principal returns only that principal’s items', async () => {
    const theirs = await withPrincipalStore(pool, 'principal:jerry', (s) => s.items());
    const mine = await withPrincipalStore(pool, 'principal:prince', (s) => s.items());
    const foreignTitles = new Set(theirs.map((i) => i.title));
    for (const item of mine) {
      expect(foreignTitles.has(item.title), `prince's store returned jerry's "${item.title}"`).toBe(
        false,
      );
    }
  });

  it('AND A HAND-WRITTEN FOREIGN QUERY RETURNS NOTHING — the database beats the WHERE clause', async () => {
    // The attack, run rather than described. `Store` has no method that can name another principal;
    // this writes the `WHERE principal_id = $1` that the store deliberately cannot express, inside
    // the same scoped transaction. If the policy were absent, or the role could bypass it, this
    // returns Jerry's note.
    //
    // THIS IS THE ASSERTION THAT MAKES THE ISOLATION STRUCTURAL RATHER THAN CONDITIONAL: the
    // failure mode being designed out is a scope clause a refactor drops, and here ADDING a hostile
    // one changes nothing.
    // FALSIFIED BEFORE IT WAS TRUSTED. The identical query, on the identical database, run WITHOUT
    // `SET LOCAL ROLE` — i.e. as the owner, exactly as the first attempt at migration 015 ran:
    //
    //   as neondb_owner bypassrls=true: 1 foreign row: "What Jerry needs before trusting..."
    //   as playroom_context             0 rows
    //
    // So the zero below is a REFUSAL and not an absence. Without that pair of measurements this
    // assertion would be satisfied by an empty table, a wrong principal id, or a typo in a column.
    const attack = await attemptForeignRead(pool, 'principal:prince', 'principal:jerry');
    expect(attack.rows, `read ${attack.rows} foreign rows: ${attack.titles.join(', ')}`).toBe(0);

    // And the reverse direction, because a policy keyed to the wrong side of a comparison would
    // pass one of these and fail the other.
    const reverse = await attemptForeignRead(pool, 'principal:jerry', 'principal:prince');
    expect(reverse.rows).toBe(0);
  });

  it('an unscoped read is EMPTY, not universal — the failure is closed', async () => {
    // `current_setting(..., true)` is NULL when unset, and `principal_id = NULL` matches no rows. So
    // a caller who forgets to scope gets nothing rather than everyone's context: the difference
    // between a bug that shows up as an empty screen and one that shows up as a disclosure.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE playroom_context');
      const { rows } = await client.query<{ n: string }>(
        'SELECT count(*) AS n FROM principal_context',
      );
      await client.query('COMMIT');
      expect(Number(rows[0].n)).toBe(0);
    } finally {
      client.release();
    }
  });

  it('cannot PLANT a row in a foreign store, even deliberately', async () => {
    // The policy's WITH CHECK, which matters because a write is the other direction of the same
    // boundary: without it, one principal could put words in another's private store and then read
    // them back through a legitimate channel.
    // Reaching around the `Store` interface to write the foreign row directly, the way a determined
    // caller would: scoped as prince, inserting as jerry.
    const client = await pool.connect();
    let refusal: unknown;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE playroom_context');
      await client.query('SELECT set_config($1, $2, true)', [
        'playroom.principal_id',
        'principal:prince',
      ]);
      await client
        .query(
          `INSERT INTO principal_context (id, principal_id, kind, title, body)
           VALUES ('ctx_planted', 'principal:jerry', 'note', 'planted', 'planted')`,
        )
        .catch((err: unknown) => {
          refusal = err;
        });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(refusal, 'the insert was ACCEPTED — a foreign store is writable').toBeDefined();
    expect(String(refusal)).toMatch(/row-level security|policy/i);

    // Nothing landed.
    const theirs = await withPrincipalStore(pool, 'principal:jerry', (s) => s.items());
    expect(theirs.some((i) => i.title === 'planted')).toBe(false);
  });
});

describe('the store refuses to be unscoped', () => {
  it('an empty principal id is an error, not an empty store', async () => {
    // The policy already fails closed; this is the second line, so that a caller's mistake reads as
    // a mistake instead of as an account with no context in it.
    await expect(withPrincipalStore(pool, '', async () => 1)).rejects.toThrow(/principal id/);
    await expect(withPrincipalStore(pool, '   ', async () => 1)).rejects.toThrow(/principal id/);
  });
});
