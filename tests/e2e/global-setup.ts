import type { FullConfig } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { buildServer } from '../../apps/api/src/server.js';
import { issueCredential } from '../../apps/api/src/credentials.js';
import { makePool } from '../../apps/api/src/db.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const WEB_PORT = 3210;
const API_PORT = 3211;
const ROOM_PREFIX = 'e2e-';

async function waitFor(url: string, child?: ChildProcess): Promise<void> {
  const deadline = Date.now() + 45_000;
  let last: unknown;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null)
      throw new Error(`web process exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
      last = new Error(`HTTP ${response.status}`);
    } catch (error) {
      last = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`timed out waiting for ${url}: ${String(last)}`);
}

/** Remove only deterministic E2E records from the disposable test database. */
async function cleanE2eData(databaseUrl: string): Promise<void> {
  const pool = makePool(databaseUrl);
  try {
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM rooms WHERE id LIKE $1 ORDER BY id',
      [`${ROOM_PREFIX}%`],
    );
    for (const { id } of rows) {
      await pool.query('DELETE FROM events WHERE room_id = $1', [id]);
      await pool.query('DELETE FROM rooms WHERE id = $1', [id]);
    }

    const guests = await pool.query<{ id: string }>(
      `SELECT m.id
         FROM members m JOIN principals p ON p.id = m.principal_id
        WHERE p.guest = true AND m.kind = 'human'`,
    );
    const ids = guests.rows.map((row) => row.id);
    if (ids.length > 0) {
      await pool.query('DELETE FROM ws_tickets WHERE member_id = ANY($1)', [ids]);
      await pool.query('DELETE FROM member_credentials WHERE member_id = ANY($1)', [ids]);
      await pool.query('DELETE FROM room_members WHERE member_id = ANY($1)', [ids]);
      await pool.query('DELETE FROM room_codes WHERE redeemed_member = ANY($1)', [ids]);
      await pool.query('DELETE FROM members WHERE id = ANY($1)', [ids]);
    }
    await pool.query(
      'DELETE FROM room_codes WHERE principal_id IN (SELECT id FROM principals WHERE guest = true)',
    );
    await pool.query(
      `UPDATE principals
          SET display_name = CASE id
            WHEN 'principal:guest-a' THEN 'Guest A'
            WHEN 'principal:guest-b' THEN 'Guest B'
            ELSE display_name END
        WHERE guest = true`,
    );
  } finally {
    await pool.end();
  }
}

export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  try {
    process.loadEnvFile(resolve(ROOT, '.env'));
  } catch {
    /* CI may provide variables directly. */
  }
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'TEST_DATABASE_URL is required for browser E2E; run node scripts/bootstrap.mjs --no-start',
    );
  }
  if (databaseUrl === process.env.DATABASE_URL) {
    throw new Error('browser E2E refuses to use DATABASE_URL; TEST_DATABASE_URL must be isolated');
  }

  await cleanE2eData(databaseUrl);
  const pool = makePool(databaseUrl);
  const owner = await issueCredential(pool, 'prince', `browser e2e ${randomUUID()}`, 1);
  await pool.end();

  const api = buildServer({ databaseUrl, logLevel: 'warn' });
  await api.listen({ port: API_PORT, host: '127.0.0.1' });

  const nextBin = resolve(ROOT, 'apps', 'web', 'node_modules', 'next', 'dist', 'bin', 'next');
  const web = spawn(process.execPath, [nextBin, 'dev', '-p', String(WEB_PORT)], {
    cwd: resolve(ROOT, 'apps', 'web'),
    env: {
      ...process.env,
      NEXT_PUBLIC_API_URL: `http://127.0.0.1:${API_PORT}`,
      PLAYROOM_WEB_TOKEN: owner.token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let webStderr = '';
  web.stderr?.on('data', (chunk) => {
    webStderr += String(chunk);
  });

  try {
    await waitFor(`http://127.0.0.1:${WEB_PORT}/`, web);
    // Compile the two entry pages and the create BFF before timing pending-state behavior. A first
    // Next dev compilation can take several seconds and is not product latency.
    await fetch(`http://127.0.0.1:${WEB_PORT}/start`);
    await fetch(`http://127.0.0.1:${WEB_PORT}/join`);
    await fetch(`http://127.0.0.1:${WEB_PORT}/api/rooms`);
  } catch (error) {
    web.kill();
    await api.close();
    throw new Error(`${String(error)}\n${webStderr.slice(-4_000)}`);
  }

  // Global setup runs before workers are spawned, so these test-only coordinates are inherited.
  // The owner credential is held only by the web server child and never enters a worker/browser.
  process.env.PLAYROOM_E2E_DATABASE_URL = databaseUrl;
  process.env.PLAYROOM_E2E_API_URL = `http://127.0.0.1:${API_PORT}`;

  return async () => {
    if (web.exitCode === null) {
      web.kill();
      await Promise.race([
        once(web, 'exit'),
        new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
      ]);
    }
    await api.close();
    const cleanup = makePool(databaseUrl);
    try {
      await cleanup.query('DELETE FROM member_credentials WHERE id = $1', [owner.id]);
    } finally {
      await cleanup.end();
    }
    await cleanE2eData(databaseUrl);
  };
}
