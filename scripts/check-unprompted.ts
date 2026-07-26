// Runs the §19 zero query against a live database and exits non-zero if it is not zero.
//
// The SQL lives in scripts/sql/unprompted-turns.sql and is read from disk, not inlined,
// so the nightly job, this script and any manual psql run are provably the same query.
// A second copy would drift, and the first time they disagreed the passing one would be
// believed.
//
//   pnpm tsx scripts/check-unprompted.ts            # DATABASE_URL
//   pnpm tsx scripts/check-unprompted.ts --test     # TEST_DATABASE_URL
//   pnpm tsx scripts/check-unprompted.ts --plan     # also print the query plan
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

const SQL_PATH = join(dirname(fileURLToPath(import.meta.url)), 'sql', 'unprompted-turns.sql');

interface Counts {
  unprompted_turns: number;
  no_summon_ref: number;
  dangling_ref: number;
  not_human_rooted: number;
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

    // Context, so a zero is not mistaken for "the query found nothing to look at".
    const ctx = await client.query<{ turns: number; baseline: string | null; pre: number }>(
      `SELECT
         count(*) FILTER (WHERE event_type LIKE 'agent.turn.%')::int AS turns,
         (SELECT applied_at::text FROM schema_migrations WHERE name = '004_summon_provenance.sql') AS baseline,
         count(*) FILTER (
           WHERE event_type LIKE 'agent.turn.%'
             AND ts < COALESCE(
               (SELECT applied_at FROM schema_migrations WHERE name = '004_summon_provenance.sql'),
               'infinity'::timestamptz)
         )::int AS pre
       FROM events`,
    );
    const c = ctx.rows[0];

    console.log(`database                : ${database}`);
    console.log(`invariant in force since: ${c.baseline ?? 'NOT MIGRATED'}`);
    console.log(`agent turns in log      : ${c.turns}  (${c.pre} of them pre-invariant)`);
    console.log(`unprompted (must be 0)  : ${r.unprompted_turns}`);
    console.log(`  no summon reference   : ${r.no_summon_ref}`);
    console.log(`  dangling reference    : ${r.dangling_ref}`);
    console.log(`  not human-rooted      : ${r.not_human_rooted}`);

    if (process.argv.includes('--plan')) {
      const plan = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ANALYZE ${sql}`);
      console.log('\n--- plan ---');
      for (const row of plan.rows) console.log(row['QUERY PLAN']);
    }

    const ok = r.unprompted_turns === 0;
    console.log(ok ? '\nOK — every agent turn traces to a human summon.' : '\nFAIL');
    process.exitCode = ok ? 0 : 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
