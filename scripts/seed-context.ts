// scripts/seed-context.ts — one real item in one principal's store.
//
//   pnpm tsx scripts/seed-context.ts
//
// NOTHING FICTIONAL. The two principals in this system are real — Prince and Jerry — and the item
// seeded into each store is a real fact about how this project is run, not lorem ipsum dressed as a
// document. A fake artifact in a store that exists to prove isolation would be a fake artifact in
// the one test that has to be believed.
//
// Written THROUGH `withPrincipalStore`, so the seed cannot plant a row anywhere the app could not
// read it back: the policy's WITH CHECK refuses an insert naming another principal, and this script
// gets no privilege the room does not have.
import { makePool } from '../apps/api/src/db.js';
import { withPrincipalStore } from '../apps/api/src/principal-store.js';
import { loadRootEnv } from '../apps/api/src/env.js';

loadRootEnv();

const SEED: Record<string, { kind: string; title: string; body: string; summary?: string }> = {
  'principal:prince': {
    kind: 'note',
    title: 'How this repository is worked in',
    body: [
      'Slices are single-agent and serial. Every slice ends green, with CI verified per commit in',
      'isolation, and `--no-verify` is never used. Refusals must be legible: a refusal that cannot',
      'be told apart from an acceptance is treated as a defect, not a style question. Findings',
      'against our own trust boundary go in the red-team ledger with a severity and a disposition,',
      'including the ones I caused.',
    ].join(' '),
    summary:
      'Serial slices, green per commit, legible refusals, findings logged with dispositions.',
  },
  'principal:jerry': {
    kind: 'note',
    title: 'What Jerry needs before trusting an agent decision',
    body: [
      'Sol reviews and comments and does not merge. Before trusting a decision that changed a',
      'repository, Jerry wants the mandate that was in force recorded by hash, the requester named,',
      'and a human signature on anything protected — not a log line asserting that it was fine.',
    ].join(' '),
    summary: 'Wants the mandate hash, the requester and a human signature on protected actions.',
  },
};

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const pool = makePool(url);
  try {
    for (const [principal, item] of Object.entries(SEED)) {
      const added = await withPrincipalStore(pool, principal, async (store) => {
        const existing = await store.items();
        const already = existing.find((i) => i.title === item.title);
        if (already) return null;
        return store.add(item);
      });
      console.log(
        added
          ? `${principal}: added "${added.title}"`
          : `${principal}: already has "${item.title}" — left alone`,
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
