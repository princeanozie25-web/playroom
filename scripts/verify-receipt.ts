// scripts/verify-receipt.ts — verify a Playroom receipt for yourself. No server. No trust in us.
//
//   pnpm tsx scripts/verify-receipt.ts <receipt.json>   # verify a receipt you exported
//   pnpm tsx scripts/verify-receipt.ts --demo           # build one offline and watch it catch tampering
//
// Export a receipt as a room member:
//   GET /rooms/:id/decisions/:decisionId/receipt   → save the JSON body
// then run this on it. It re-derives every hash with @playroom/receipt — the SAME open algorithm the server
// used to build the audit chain — and tells you whether the commitment holds. The one thing it cannot know
// is whether `root` is the root your principal received out of band (Bible §17): compare that yourself. That
// comparison is the whole point — a rewrite cannot reproduce a root that was already sent, and nothing about
// this verification asks you to believe the server.

import { readFileSync } from 'node:fs';
// In-repo path to the verifier package. A verifier distributed to a third party imports the PUBLISHED
// `@playroom/receipt` instead — same code, same result; the point is that it is open and runs anywhere.
import {
  verifyDetachedReceipt,
  bodyHash,
  entryHash,
  GENESIS,
  type ChainLink,
  type DetachedReceipt,
  type EntryMeta,
} from '../packages/receipt/src/index.js';

function report(receipt: DetachedReceipt): boolean {
  const v = verifyDetachedReceipt(receipt);
  // Display the VERIFIED outcome (v.outcome, read from the hashed payload), never the raw top-level caption:
  // the two are only guaranteed equal when v.ok, and a lying server can flip the caption while the hashes
  // stay honest. When verification fails, the outcome is shown as (unverified) — because it is.
  const o = v.outcome;
  console.log(`\n  decision : ${o?.decision_id ?? '(unverified)'}`);
  console.log(
    `  outcome  : ${o ? `${o.resolution ?? '(unresolved)'}${o.signed_by ? ` by ${o.signed_by}` : ''}` : '(unverified)'}`,
  );
  console.log(`  entry    : ${receipt.entry_hash}`);
  console.log(`  root     : ${receipt.root}`);
  console.log(
    `  path     : ${Array.isArray(receipt.path) ? receipt.path.length : 0} link(s) from this entry to the root`,
  );
  console.log(
    `  checks   : body=${v.checks.body}  entry=${v.checks.entry}  chain=${v.checks.chain}  outcome=${v.checks.outcome}`,
  );
  if (v.ok) {
    console.log(
      '\n  ✓ VERIFIED — the receipt is internally consistent and reaches the stated root.',
    );
    console.log('    Compare the root above against the one your principal received out of band.');
  } else {
    console.log(`\n  ✗ FAILED — ${v.reason}`);
  }
  return v.ok;
}

function demo(): void {
  // A tiny two-commitment chain, built entirely in memory with the open primitives, then verified.
  const meta1: EntryMeta = {
    room_id: 'room-demo',
    actor_id: 'prince',
    event: 'decision.resolved',
    source_seq: 41,
  };
  const meta2: EntryMeta = {
    room_id: 'room-demo',
    actor_id: 'prince',
    event: 'decision.resolved',
    source_seq: 44,
  };
  const payload1 = { decision_id: 'dec_alpha', resolution: 'APPROVED', signed_by: 'prince' };
  const payload2 = { decision_id: 'dec_beta', resolution: 'DENIED', signed_by: 'prince' };

  const body1 = bodyHash(payload1);
  const entry1 = entryHash(GENESIS, body1, meta1);
  const body2 = bodyHash(payload2);
  const entry2 = entryHash(entry1, body2, meta2);

  const path: ChainLink[] = [
    { prev_hash: GENESIS, body_hash: body1, entry_hash: entry1, meta: meta1 },
    { prev_hash: entry1, body_hash: body2, entry_hash: entry2, meta: meta2 },
  ];
  const receipt: DetachedReceipt = {
    decision_id: 'dec_alpha',
    resolution: 'APPROVED',
    signed_by: 'prince',
    source_payload: payload1,
    meta: meta1,
    body_hash: body1,
    prev_hash: GENESIS,
    entry_hash: entry1,
    root: entry2,
    path,
  };

  console.log('\n=== DEMO 1 — a valid detached receipt, built and verified entirely offline ===');
  report(receipt);

  console.log('\n=== DEMO 2 — flip one byte of the recorded outcome (APPROVED → DENIED) ===');
  report({ ...receipt, source_payload: { ...payload1, resolution: 'DENIED' } });

  console.log('\n=== DEMO 3 — forge a link in the inclusion path ===');
  const forged = [...path];
  forged[1] = { ...forged[1], prev_hash: 'sha256:forged' };
  report({ ...receipt, path: forged });

  console.log('\nAll three answers were computed on THIS machine, from the receipt alone.\n');
}

const arg = process.argv[2];
if (!arg || arg === '--demo') {
  demo();
} else {
  const receipt = JSON.parse(readFileSync(arg, 'utf8')) as DetachedReceipt;
  console.log(`=== VERIFYING ${arg} ===`);
  const ok = report(receipt);
  process.exit(ok ? 0 : 1);
}
