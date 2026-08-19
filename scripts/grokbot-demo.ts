// scripts/grokbot-demo.ts — the GOVERNED grokbot cycle, end to end, offline.
//
//   pnpm tsx scripts/grokbot-demo.ts [handle]
//
// Grokbot's loop — read the mentions, read the thread, answer — with the fabric in the middle. Runs the
// whole cycle against the MOCK read backend (no X account, no key, no network) and evaluates each drafted
// reply against an in-memory mandate that PROTECTS `x.reply`. Every answer reads CO_SIGN: a human signs
// the exact draft before it posts, and nothing here posts. Swap the read backend or the model and this
// does not change — provider-neutral on both ends (ADR-015). No database is touched; the verdict is the
// pure evaluator's, so this is the governance in miniature, not the wiring.

import { MockXSource } from '@playroom/x-read';
import { evaluate, mandateHash, Mandate, type LoadedMandate } from '@playroom/fabric';
import { runGrokbotCycle } from '../apps/api/src/grokbot.js';

// A grokbot mandate: may read X and reply, but a reply is PROTECTED — it pauses for its principal.
const parsed = Mandate.parse({
  mandate_id: 'mnd_grok_demo',
  principal: 'principal:prince',
  member: 'grokbot',
  scope: ['x.read', 'x.reply'],
  protected_actions: ['x.reply'],
  co_sign: { actions: ['x.reply'], by: 'principal' },
  limits: { interrupts_per_day: 6 },
  counterparties: 'roster_only',
  policy_version: 'playroom-policy/1.0',
  expires: '2027-01-01T00:00:00Z',
});
const grokMandate: LoadedMandate = { mandate: parsed, hash: mandateHash(parsed), sig_valid: true };

async function main(): Promise<void> {
  const handle = process.argv[2] ?? 'playroom_ai';
  const source = new MockXSource();

  console.log(
    `\n=== GOVERNED GROKBOT CYCLE (read backend: ${source.backend}) — watching @${handle} ===\n`,
  );

  const cycle = await runGrokbotCycle({
    source,
    watchedHandle: handle,
    // A canned draft stands in for a model adapter — the governance is the point, not the prose.
    draftReply: async ({ mention, thread, screenedText }) =>
      `@${mention.author.handle} — reading the thread of ${thread.replies.length + 1}: ` +
      `"${screenedText.slice(0, 60)}${screenedText.length > 60 ? '…' : ''}". Answering under a mandate; ` +
      `a human co-signs before this goes out.`,
    // `propose` = the pure evaluator, standing in for the /rooms/:id/actions door. Returns a verdict; it
    // never posts. x.reply is protected here, so every proposal is CO_SIGN.
    propose: async (input) => {
      const v = evaluate({ type: input.action, resource: input.resource }, 'grokbot', grokMandate);
      return {
        decision: v.decision,
        reasonCode: v.reason_code,
        decisionId: v.decision === 'ALLOW' ? null : `demo-decision-${input.clientMsgId}`,
      };
    },
  });

  console.log(`${cycle.proposed.length} mention(s) drew a governed reply:\n`);
  for (const p of cycle.proposed) {
    console.log(`  MENTION ${p.mention.id}  @${p.mention.author.handle}`);
    console.log(`    they said : ${p.mention.text}`);
    console.log(`    draft     : ${p.draft}`);
    console.log(`    verdict   : ${p.decision} (${p.reasonCode})`);
    console.log(`    receipt   : ${p.decisionId}`);
    console.log(`    resource  : ${p.resource}`);
    console.log(
      `    posted    : ${p.posted}  ← never auto-posted; a human signs the draft first\n`,
    );
  }

  const allCoSigned = cycle.proposed.every((p) => p.decision === 'CO_SIGN' && p.posted === false);
  console.log(
    allCoSigned
      ? '✓ Grokbot parity — every mention answered — but each answer is co-signed and receipted, none posted.'
      : '⚠ Unexpected: not every reply was co-signed. Check the mandate.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
