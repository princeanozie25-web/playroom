import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HOOK } from './hooks';

// THE HOOK CONTRACT, ASSERTED IN CI.
//
// The film harness lives outside this repo and cannot run here, so the thing that catches
// a renamed or deleted hook has to be a test in the repo. This is that test.
//
// It is a SOURCE-LEVEL check, deliberately and with its limit stated: it proves every hook
// is still referenced by a component, not that the component still renders it. There is no
// DOM here — adding one would mean jsdom and a testing library, and this slice may not add
// a dependency. The other half of the guarantee is the harness failing a take on a
// zero-match selector, which is the only thing that can see a hook that compiles but never
// reaches the screen. Neither half is sufficient; both are cheap.

const APP = resolve(import.meta.dirname);

function sources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      sources(p, acc);
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts') && entry !== 'hooks.ts') {
      // hooks.ts is the DECLARATION, not a consumer. Including it made this test pass with
      // the hook deleted from the transcript, because `HOOK.transcript` appears in a doc
      // comment there — the check was satisfied by its own example. Caught by deleting a
      // hook on purpose and watching the test stay green, which is why that was done before
      // the commit rather than after.
      acc.push(p);
    }
  }
  return acc;
}

// Comments stripped for the same reason: a commented-out usage is not a usage, and a hook
// mentioned in a note about why it was removed would keep this test green forever.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const corpus = sources(APP)
  .map((f) => stripComments(readFileSync(f, 'utf8')))
  .join('\n');

describe('stable selector hooks', () => {
  it('has no duplicate hook names — two elements answering one selector is ambiguity', () => {
    const names = Object.values(HOOK);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(Object.entries(HOOK))('%s is still used by a component', (key) => {
    // Matched on the KEY (`HOOK.transcript`), not the string value: a component that
    // hardcodes 'transcript' instead of referencing the constant has left the contract,
    // and this test should notice that too.
    expect(corpus, `HOOK.${key} is declared but no component uses it`).toContain(`HOOK.${key}`);
  });

  it('no component hardcodes a hook string instead of using the constant', () => {
    // `data-pr="..."` written by hand would drift from this module silently, which is the
    // whole failure being prevented. The only permitted form is `pr(HOOK.x)`.
    const hardcoded = corpus.match(/data-pr=["'][a-z-]+["']/g);
    expect(hardcoded, `hardcoded data-pr found: ${hardcoded?.join(', ')}`).toBeNull();
  });
});
