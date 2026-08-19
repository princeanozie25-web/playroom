// scripts/x-read-demo.ts — the X read seam, end to end, offline.
//
//   pnpm tsx scripts/x-read-demo.ts [handle]
//
// Runs the whole read surface against the MOCK backend — no X account, no key, no network. It is the
// grokbot read loop in miniature: find the mentions, pull the thread each one belongs to, and show the
// context a governed reply would be written against. Swap the backend (a real managed API, the official
// X API) by pointing the future factory at it via env; these four calls do not change.

import { MockXSource } from '@playroom/x-read';

async function main(): Promise<void> {
  const handle = process.argv[2] ?? 'playroom_ai';
  const src = new MockXSource();

  console.log(`\n=== X READ SEAM DEMO (backend: ${src.backend}) — watching @${handle} ===\n`);

  const mentions = await src.getMentions(handle);
  console.log(`MENTIONS of @${handle} (newest first): ${mentions.length}`);
  for (const m of mentions) {
    console.log(`  • ${m.id}  @${m.author.handle}  ${m.createdAt}`);
    console.log(`      ${m.text}`);
  }

  console.log(`\nTHREAD CONTEXT for each mention (what a reply is written against):`);
  const seen = new Set<string>();
  for (const m of mentions) {
    const thread = await src.getThread(m.id);
    if (seen.has(thread.root.id)) continue; // one thread once, even if it holds two mentions
    seen.add(thread.root.id);
    console.log(`\n  THREAD ${thread.root.id} — root by @${thread.root.author.handle}:`);
    console.log(`    ${thread.root.text}`);
    for (const r of thread.replies) console.log(`    ↳ @${r.author.handle}: ${r.text}`);
  }

  console.log(`\nSEARCH "governed":`);
  for (const p of await src.search('governed'))
    console.log(`  • ${p.id} @${p.author.handle}: ${p.text}`);

  console.log(`\nOUR OWN RECENT POSTS (@${handle}):`);
  for (const p of await src.getUserPosts(handle))
    console.log(`  • ${p.id} ${p.createdAt}: ${p.text}`);

  console.log(
    `\n=== a real backend slots in behind the same four calls (credential held by the source) ===\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
