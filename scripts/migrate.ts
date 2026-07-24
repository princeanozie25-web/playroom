// Boring, dependency-free migration runner (pg only). Applies infra/migrations/*.sql
// in filename order, each inside its own transaction, idempotent via a schema_migrations
// table. Targets DATABASE_URL (or --url=<conn>). With --with-test it also verifies the
// playroom_test database (from TEST_DATABASE_URL) exists and migrates it — refusing to
// point tests at the dev database when the test DB is missing and cannot be created.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from 'pg';

try {
  process.loadEnvFile(); // local .env; absent in CI, where real env vars are set
} catch {
  /* no .env — rely on the environment */
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'infra', 'migrations');
const flag = (name: string) => process.argv.includes(`--${name}`);
const opt = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

// Hosted Postgres (Neon) requires TLS. Strip libpq-only query params (sslmode,
// channel_binding) that node-postgres does not use, and set ssl explicitly.
function connFor(url: string) {
  const u = new URL(url);
  const database = u.pathname.replace(/^\//, '');
  u.search = '';
  return { connectionString: u.toString(), database, ssl: { rejectUnauthorized: false } };
}

async function migrate(url: string): Promise<void> {
  const { connectionString, database, ssl } = connFor(url);
  const client = new Client({ connectionString, ssl, connectionTimeoutMillis: 20000 });
  await client.connect();
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    );
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const name of files) {
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (done.rowCount) {
        console.log(`  [${database}] skip ${name}`);
        continue;
      }
      const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
        console.log(`  [${database}] applied ${name}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.end();
  }
}

async function ensureTestDb(adminUrl: string, testDbName: string): Promise<boolean> {
  const { connectionString, ssl } = connFor(adminUrl);
  const client = new Client({ connectionString, ssl, connectionTimeoutMillis: 20000 });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [testDbName]);
    if (exists.rowCount) return true;
    const role = await client.query(
      'SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user',
    );
    if (!role.rows[0]?.rolcreatedb) {
      console.error(
        `FATAL: test database "${testDbName}" is missing and the role lacks CREATEDB. ` +
          'Refusing to point tests at the dev database — create it out-of-band and re-run.',
      );
      return false;
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(testDbName))
      throw new Error(`unsafe db name: ${testDbName}`);
    await client.query(`CREATE DATABASE "${testDbName}"`);
    console.log(`  created database ${testDbName}`);
    return true;
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const primary = opt('url') ?? process.env.DATABASE_URL;
  if (!primary) throw new Error('DATABASE_URL is not set (and no --url= given)');
  console.log('Migrating primary database…');
  await migrate(primary);

  if (flag('with-test')) {
    const testUrl = process.env.TEST_DATABASE_URL;
    if (!testUrl) throw new Error('--with-test requires TEST_DATABASE_URL');
    const testDbName = new URL(testUrl).pathname.replace(/^\//, '');
    console.log(`Verifying test database "${testDbName}"…`);
    if (!(await ensureTestDb(primary, testDbName))) process.exit(1);
    console.log('Migrating test database…');
    await migrate(testUrl);
  }
  console.log('Migrations complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
