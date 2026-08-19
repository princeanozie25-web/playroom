// scripts/issue-credential.ts — issue a member credential, print it once (S1.2).
//
//   pnpm tsx scripts/issue-credential.ts <member-id> <label>
//   pnpm tsx scripts/issue-credential.ts prince browser
//   pnpm tsx scripts/issue-credential.ts prince harness --test
//
//   pnpm tsx scripts/issue-credential.ts --list
//   pnpm tsx scripts/issue-credential.ts --revoke <credential-id>
//
// THE PLAINTEXT IS PRINTED ONCE AND NEVER STORED. Only its sha256 goes in the database, so a
// credential table that leaks reveals no usable secret. If a token is lost, issue another and
// revoke the old — rotation is issue-then-revoke, never update-in-place, because the old row is
// the record that the secret existed.
//
// Structured as main() rather than top-level await, matching migrate.ts: this directory is
// transformed to CJS, where top-level await does not compile.
import { Client } from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  process.loadEnvFile();
} catch {
  /* no .env — rely on the environment */
}

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
  const args = process.argv.slice(2);
  const useTest = args.includes('--test');
  const url = useTest ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) throw new Error(`${useTest ? 'TEST_DATABASE_URL' : 'DATABASE_URL'} is not set`);

  const { connectionString, database, ssl } = connFor(url);
  const client = new Client({ connectionString, ssl, connectionTimeoutMillis: 20000 });
  await client.connect();

  try {
    if (args.includes('--check-web')) {
      // BOOTSTRAP CONTINUITY CHECK. Presence in .env.local is not proof that a credential still
      // belongs to this database: a database can be replaced, or the row can expire or be revoked.
      // Read the ignored file here (after dependencies exist), compare only its hash, and print no
      // credential material. Exit 2 means bootstrap should mint a replacement; every other database
      // failure remains a real failure and exits 1 through main().catch below.
      const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const webEnv = resolve(root, 'apps/web/.env.local');
      const line = existsSync(webEnv)
        ? readFileSync(webEnv, 'utf8')
            .split(/\r?\n/)
            .map((value) => value.trim())
            .find((value) => value.startsWith('PLAYROOM_WEB_TOKEN='))
        : undefined;
      const token = line?.slice('PLAYROOM_WEB_TOKEN='.length).trim();
      if (!token) {
        console.log('web credential: missing');
        process.exitCode = 2;
        return;
      }
      const { rows } = await client.query<{ member_id: string }>(
        `SELECT member_id
           FROM member_credentials
          WHERE token_hash = $1
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > now())`,
        [createHash('sha256').update(token).digest('hex')],
      );
      if (rows.length === 1 && rows[0].member_id === 'prince') {
        console.log('web credential: valid for local owner');
        return;
      }
      console.log('web credential: invalid for this database');
      process.exitCode = 2;
      return;
    }

    if (args.includes('--list')) {
      const { rows } = await client.query(
        `SELECT id, member_id, label, created_at::date AS issued, revoked_at::date AS revoked
           FROM member_credentials ORDER BY created_at`,
      );
      console.log(`credentials in ${database}:`);
      for (const r of rows) {
        console.log(
          `  ${r.id}  ${r.member_id.padEnd(12)} ${r.label.padEnd(18)} issued ${r.issued}` +
            (r.revoked ? `  REVOKED ${r.revoked}` : ''),
        );
      }
      if (rows.length === 0) console.log('  (none — nothing can connect)');
      return;
    }

    const revokeAt = args.indexOf('--revoke');
    if (revokeAt >= 0) {
      const id = args[revokeAt + 1];
      if (!id) throw new Error('--revoke needs a credential id (see --list)');
      const res = await client.query(
        'UPDATE member_credentials SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
        [id],
      );
      console.log(res.rowCount ? `revoked ${id}` : `${id} not found, or already revoked`);
      return;
    }

    const [memberId, label] = args.filter((a) => !a.startsWith('--'));
    if (!memberId || !label) {
      throw new Error('usage: issue-credential.ts <member-id> <label> [--test]');
    }

    const member = await client.query('SELECT id, kind FROM members WHERE id = $1', [memberId]);
    if (member.rowCount === 0) {
      // Loud, and it names what exists. A credential for a member that does not exist would be
      // a secret nothing could ever authenticate as.
      const all = await client.query('SELECT id FROM members ORDER BY id');
      throw new Error(`no member "${memberId}" (known: ${all.rows.map((r) => r.id).join(', ')})`);
    }

    const token = `prm_${randomBytes(32).toString('hex')}`;
    const id = `cred_${randomBytes(8).toString('hex')}`;
    await client.query(
      'INSERT INTO member_credentials (id, member_id, token_hash, label) VALUES ($1, $2, $3, $4)',
      [id, memberId, createHash('sha256').update(token).digest('hex'), label],
    );

    console.log(`issued ${id} for ${memberId} (${label}) in ${database}`);
    console.log('');
    console.log('  THE TOKEN, SHOWN ONCE — store it now:');
    console.log(`  ${token}`);
    console.log('');
    console.log('  For the web app, put it in .env as:');
    console.log(`  PLAYROOM_WEB_TOKEN=${token}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
