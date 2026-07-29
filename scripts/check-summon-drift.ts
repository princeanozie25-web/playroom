// Runs the §19 drift query against a live database and exits non-zero if either number
// is not zero.
//
// The SQL lives in scripts/sql/summon-drift.sql and is read from disk, not inlined, so the
// nightly job, this script and any manual psql run are provably the same query. A second
// copy would drift, and the first time they disagreed the passing one would be believed.
//
//   pnpm tsx scripts/check-summon-drift.ts            # DATABASE_URL
//   pnpm tsx scripts/check-summon-drift.ts --test     # TEST_DATABASE_URL
//   pnpm tsx scripts/check-summon-drift.ts --plan     # also print the measured plan
//
// TWO numbers, both of which must be zero — see the header of the .sql for why one is not
// enough. `turn_rows_examined` is printed alongside them because a zero over an empty log
// proves the query parses and nothing else.
//
// Structured as main() rather than top-level await, matching migrate.ts: this directory
// is transformed to CJS, where top-level await does not compile.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from 'pg';

try {
  process.loadEnvFile(); // local .env; absent in CI, where real env vars are set
} catch {
  /* no .env — rely on the environment */
}

const SQL_PATH = join(dirname(fileURLToPath(import.meta.url)), 'sql', 'summon-drift.sql');

interface Counts {
  unrooted_turns: number;
  no_summon_ref: number;
  dangling_ref: number;
  not_human_rooted: number;
  multi_turn_summons: number;
  turn_rows_examined: number;
  summons_examined: number;
  // The resolving population split (S-LOOP): how the human authorised each resolving turn.
  directly_human_rooted_turns: number;
  order_rooted_turns: number;
  order_summons_examined: number;
}

// Same TLS treatment as migrate.ts: strict on hosted Postgres, none on local.
function connFor(url: string) {
  const u = new URL(url);
  const host = u.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const database = u.pathname.replace(/^\//, '');
  u.search = '';
  return {
    connectionString: u.toString(),
    database,
    ssl: isLocal ? undefined : { rejectUnauthorized: true },
  };
}

async function main(): Promise<void> {
  const useTest = process.argv.includes('--test');
  const url = useTest ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) throw new Error(`${useTest ? 'TEST_DATABASE_URL' : 'DATABASE_URL'} is not set`);

  const sql = readFileSync(SQL_PATH, 'utf8');
  const { connectionString, database, ssl } = connFor(url);
  const client = new Client({ connectionString, ssl, connectionTimeoutMillis: 20000 });
  await client.connect();

  try {
    const { rows } = await client.query<Counts>(sql);
    const r = rows[0];

    // When the invariant came into force. A turn older than this carries no summon_id and
    // is counted as unrooted deliberately — it predates the rule, and blessing it would
    // make the number a formality.
    const since = await client.query<{ applied_at: string | null }>(
      `SELECT applied_at::text AS applied_at FROM schema_migrations
       WHERE name = '004_summon_provenance.sql'`,
    );

    console.log(`database                  : ${database}`);
    console.log(`invariant in force since  : ${since.rows[0]?.applied_at ?? 'NOT MIGRATED'}`);
    console.log(
      `examined                  : ${r.turn_rows_examined} turn rows, ${r.summons_examined} summons`,
    );
    console.log(`unrooted turns (must be 0): ${r.unrooted_turns}`);
    console.log(`  no summon reference     : ${r.no_summon_ref}`);
    console.log(`  dangling reference      : ${r.dangling_ref}`);
    console.log(`  not human-rooted        : ${r.not_human_rooted}`);
    console.log(`multi-turn summons    (0) : ${r.multi_turn_summons}`);
    console.log(
      `resolving turns           : ${r.directly_human_rooted_turns} directly human-rooted + ` +
        `${r.order_rooted_turns} order-rooted (of ${r.summons_examined} summons, ${r.order_summons_examined} order-rooted)`,
    );

    if (r.turn_rows_examined === 0) {
      console.log('\nNOTE: no agent turns in this log. Zero here is vacuous.');
    }

    if (process.argv.includes('--plan')) {
      const plan = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ANALYZE ${sql}`);
      console.log('\n--- plan ---');
      for (const row of plan.rows) console.log(row['QUERY PLAN']);
    }

    const ok = r.unrooted_turns === 0 && r.multi_turn_summons === 0;
    console.log(
      ok
        ? '\nOK — every agent turn traces to a human summon, and no summon started twice.'
        : '\nFAIL',
    );
    process.exitCode = ok ? 0 : 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
