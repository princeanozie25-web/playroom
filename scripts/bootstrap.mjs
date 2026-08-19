// scripts/bootstrap.mjs — clean clone to an open room, in one command.
//
//   node scripts/bootstrap.mjs
//   node scripts/bootstrap.mjs --no-start     # prepare everything, do not run the servers
//
// PLAIN NODE, NO IMPORTS BEYOND BUILT-INS, and that is the point: it has to run BEFORE
// `pnpm install` has been run, on a machine that has just cloned the repository. Anything it
// needs from the workspace it invokes as a child process, after installing.
//
// ── WHY THIS EXISTS ──
//
// S1.3b and S1.3c closed every door: the socket wants a single-use ticket, the roster and the
// room row want a credential, and creating a room wants one too. That is correct, and it left the
// repository with no way in — a README saying "try it" while a stranger cannot get past the
// handshake is a false claim in the most visible file we have.
//
// ── WHAT IT WILL NOT DO ──
//
// It never commits a secret. The credential it mints is written to `.env` and
// `apps/web/.env.local`, both matched by `.gitignore`, and printed once to the terminal. It does
// not write to `.env.example`, which is the file that IS committed and carries only names.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_URL = 'postgres://postgres:postgres@localhost:5433/playroom';
const NO_START = process.argv.includes('--no-start');

const step = (n, what) => console.log(`\n[${n}/6] ${what}`);
const say = (...a) => console.log('     ', ...a);

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: opts.quiet ? 'pipe' : 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  });
}

function tryRun(cmd, args, opts = {}) {
  try {
    return { ok: true, out: run(cmd, args, { ...opts, quiet: true }) };
  } catch (err) {
    return { ok: false, out: String(err.stdout ?? '') + String(err.stderr ?? err.message) };
  }
}

/** Read a name out of a dotenv file without a dependency. */
function envValue(file, name) {
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : undefined;
}

function setEnvValue(file, name, value) {
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (existing.split(/\r?\n/).some((l) => l.trim().startsWith(`${name}=`))) {
    const next = existing
      .split(/\r?\n/)
      .map((l) => (l.trim().startsWith(`${name}=`) ? `${name}=${value}` : l))
      .join('\n');
    writeFileSync(file, next);
    return;
  }
  appendFileSync(
    file,
    `${existing.endsWith('\n') || existing === '' ? '' : '\n'}${name}=${value}\n`,
  );
}

// ── 1. dependencies ───────────────────────────────────────────────────────────────────
step(1, 'Installing dependencies');
if (existsSync(resolve(ROOT, 'node_modules'))) {
  say('node_modules exists — skipping install');
} else {
  run('pnpm', ['install']);
}

// ── 2. a database ─────────────────────────────────────────────────────────────────────
step(2, 'Finding a database');
let databaseUrl = process.env.DATABASE_URL || envValue(resolve(ROOT, '.env'), 'DATABASE_URL');

if (databaseUrl) {
  // YOUR OWN POSTGRES WINS. A hosted database, a local install, anything — the bootstrap is not
  // in the business of replacing a database you already told it about.
  say('using the DATABASE_URL you already have');
} else {
  say('no DATABASE_URL — starting the one in docker-compose.yml');
  const compose = tryRun('docker', ['compose', 'up', '-d', 'db']);
  if (!compose.ok) {
    console.error(`
Docker is not available, and there is no DATABASE_URL to fall back to.

Either:
  * install Docker Desktop and run this again, or
  * point Playroom at a Postgres you already have:

      DATABASE_URL=postgres://user:pass@host:5432/playroom node scripts/bootstrap.mjs

Any Postgres 16 will do. Nothing here is Neon-specific.
`);
    process.exit(1);
  }
  // WAIT ON THE HEALTHCHECK, not on a sleep: a fixed pause is too short on a cold machine and
  // wasted on a warm one.
  process.stdout.write('      waiting for postgres');
  let healthy = false;
  for (let i = 0; i < 60 && !healthy; i += 1) {
    const status = tryRun('docker', ['compose', 'ps', '--format', 'json', 'db']);
    healthy = status.ok && /healthy/.test(status.out);
    if (!healthy) {
      process.stdout.write('.');
      execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)']);
    }
  }
  console.log(healthy ? ' up' : ' (proceeding — healthcheck did not report)');
  databaseUrl = COMPOSE_URL;
  setEnvValue(resolve(ROOT, '.env'), 'DATABASE_URL', databaseUrl);
  // The suite needs its own database. Only created on the path where we own the server.
  tryRun('docker', [
    'compose',
    'exec',
    '-T',
    'db',
    'psql',
    '-U',
    'postgres',
    '-c',
    'CREATE DATABASE playroom_test',
  ]);
  setEnvValue(
    resolve(ROOT, '.env'),
    'TEST_DATABASE_URL',
    COMPOSE_URL.replace('/playroom', '/playroom_test'),
  );
}

// ── 3. schema ─────────────────────────────────────────────────────────────────────────
step(3, 'Applying migrations');
const migrate = tryRun('pnpm', ['tsx', 'scripts/migrate.ts']);
if (!migrate.ok) {
  console.error(migrate.out);
  console.error('\nMigrations failed. The database URL above is the first thing to check.');
  process.exit(1);
}
say(
  migrate.out
    .split('\n')
    .filter((l) => l.includes('applied') || l.includes('complete'))
    .slice(-3)
    .join('\n      ') || 'schema is current',
);

// ── 4. a credential ───────────────────────────────────────────────────────────────────
step(4, 'Minting a credential for the browser');
//
// MINTED LOCALLY, NEVER COMMITTED. `issue-credential.ts` prints the plaintext once and stores
// only its sha256 — so this file scrapes the printed value and writes it to the two ignored env
// files. A credential in the repository would be a credential in everyone's clone.
const checked = tryRun('pnpm', ['tsx', 'scripts/issue-credential.ts', '--check-web']);
let token = envValue(resolve(ROOT, 'apps/web/.env.local'), 'PLAYROOM_WEB_TOKEN');
if (checked.ok) {
  say('apps/web/.env.local has a live owner credential — keeping it');
} else {
  // A token can be present and still be unusable: the database may have been replaced, or the row
  // may have expired or been revoked. The API must keep failing closed; local bootstrap repairs the
  // configuration by issuing a new credential instead of teaching the API to trust stale callers.
  say(
    token ? 'existing web credential is stale — replacing it' : 'no web credential — creating it',
  );
  const issued = tryRun('pnpm', ['tsx', 'scripts/issue-credential.ts', 'prince', 'browser (dev)']);
  if (!issued.ok) {
    console.error(issued.out);
    process.exit(1);
  }
  token = (issued.out.match(/prm_[0-9a-f]{64}/) ?? [])[0];
  if (!token) {
    console.error(issued.out);
    console.error('\nCould not read the minted credential. Nothing was written.');
    process.exit(1);
  }
  setEnvValue(resolve(ROOT, 'apps/web/.env.local'), 'PLAYROOM_WEB_TOKEN', token);
  say('written to apps/web/.env.local (gitignored)');
}

// ── 5. a room ─────────────────────────────────────────────────────────────────────────
step(5, 'Creating a room');
//
// Through the PRODUCT'S OWN function, not raw SQL: `createRoom` enrols the creator in the same
// transaction, and a room with no members cannot be opened by anyone (S1.3c). Seeding one by hand
// would be seeding the one shape the front door refuses.
const seed = tryRun('pnpm', ['tsx', 'scripts/seed-room.ts']);
if (!seed.ok) {
  console.error(seed.out);
  process.exit(1);
}
const roomId = (seed.out.match(/room:([a-z0-9-]+)/) ?? [])[1] ?? 'playroom';
say(`room "${roomId}" is ready, with prince enrolled`);

// Each principal's private store gets one real note (S1.5). Idempotent, and it writes through the
// scoped store like everything else — so a stranger's clone shows the isolation working on content
// rather than on an empty table, where it would prove nothing.
const ctx = tryRun('pnpm', ['tsx', 'scripts/seed-context.ts']);
say(ctx.ok ? 'each principal has a private store with a note in it' : 'context seed skipped');

// ── 6. run it ─────────────────────────────────────────────────────────────────────────
const url = `http://localhost:3000/r/${roomId}`;
const keys = {
  anthropic: Boolean(
    process.env.ANTHROPIC_API_KEY || envValue(resolve(ROOT, '.env'), 'ANTHROPIC_API_KEY'),
  ),
  openai: Boolean(process.env.OPENAI_API_KEY || envValue(resolve(ROOT, '.env'), 'OPENAI_API_KEY')),
};

step(6, NO_START ? 'Ready (not starting servers)' : 'Starting the api and the web app');
console.log(`
      Open:  ${url}

      Provider keys:  anthropic ${keys.anthropic ? 'set' : 'NOT set'} · openai ${keys.openai ? 'set' : 'NOT set'}
`);
if (!keys.anthropic || !keys.openai) {
  console.log(`      WITHOUT A PROVIDER KEY THE ROOM STILL WORKS, and most of what is worth
      seeing does not need one. The roster, both members' mandates, the summon
      refusals and THE BLOCKED MERGE are all produced by Playroom itself. Tagging a
      member whose key is missing gets you a visible failed turn and a held task —
      which is the honest outcome, and it is what the code does on a provider outage.

      Add keys to .env to see live agent turns:
        ANTHROPIC_API_KEY=...    (claude-main)
        OPENAI_API_KEY=...       (sol)
`);
}

if (NO_START) {
  console.log(`      Start them yourself with:  pnpm dev\n`);
  process.exit(0);
}

const dev = spawn('pnpm', ['dev'], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.on('SIGINT', () => dev.kill('SIGINT'));
dev.on('exit', (code) => process.exit(code ?? 0));
