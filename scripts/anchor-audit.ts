// scripts/anchor-audit.ts — the audit-chain anchor (S2.3 / A3, Bible §15/§17).
//
//   pnpm tsx scripts/anchor-audit.ts                  # anchor DATABASE_URL, print the root
//   pnpm tsx scripts/anchor-audit.ts --url=<url>      # anchor an explicit database
//   pnpm tsx scripts/anchor-audit.ts --verify         # verify the chain only, write nothing
//
// Folds every not-yet-chained commitment event into the audit chain and prints the ROOT — the value Bible
// §17 anchors externally (emailed to principals) so a later rewrite is caught by a root that was already
// sent. Email DELIVERY is a follow-up; producing and reporting the root is the anchor's core, and it is
// idempotent, so a cron may run it as often as it likes.
//
// Structured as main() rather than top-level await, matching migrate.ts: this directory is transformed to
// CJS, where top-level await does not compile.
import { makePool } from '../apps/api/src/db.js';
import { loadRootEnv } from '../apps/api/src/env.js';
import { chainCommitmentEvents, verifyAuditChain } from '../apps/api/src/audit.js';

loadRootEnv();

function argUrl(): string | undefined {
  const a = process.argv.find((x) => x.startsWith('--url='));
  return a ? a.slice('--url='.length) : undefined;
}

async function main(): Promise<void> {
  const url = argUrl() ?? process.env.DATABASE_URL;
  if (!url) throw new Error('no database url — set DATABASE_URL or pass --url=<url>');
  const verifyOnly = process.argv.includes('--verify');
  const pool = makePool(url);
  try {
    if (verifyOnly) {
      const v = await verifyAuditChain(pool);
      console.log(
        v.ok
          ? `audit chain OK — ${v.entries} entries, root ${v.root ?? '(empty)'}`
          : `audit chain BROKEN at seq ${v.brokenAt}: ${v.reason}`,
      );
      if (!v.ok) process.exitCode = 1;
      return;
    }
    const anchored = await chainCommitmentEvents(pool);
    const verified = await verifyAuditChain(pool);
    console.log(
      `anchored ${anchored.appended} new commitment(s); root ${anchored.root ?? '(empty)'}`,
    );
    if (!verified.ok) {
      console.log(
        `WARNING: chain does not verify — broken at seq ${verified.brokenAt}: ${verified.reason}`,
      );
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
