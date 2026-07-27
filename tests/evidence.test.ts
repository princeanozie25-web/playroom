import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// THE CLAIMS THAT WERE ASSERTED BY GREP, ASSERTED BY TESTS INSTEAD.
//
// ── WHY THIS FILE EXISTS ──
//
// `apps/api/src/agent.ts` carried a NUL byte from S0.5b to S1.3 (a space that became `\x00`
// through shell escaping). A file containing NUL is classed as binary by ripgrep and ITS CONTENTS
// ARE SKIPPED — so for eight slices, every content search of this repository silently excluded the
// activation boundary, the most security-relevant file in it.
//
// Several exit criteria were signed off on those searches: S0.4's provider-name grep, M-3's "one
// construction site for a decision", ADR-006's zero-hit `permit`, and the boundary greps in
// S0.5a/b's closeouts. The claims were probably true. They had never been tested against the one
// file most able to falsify them, and a closeout asserted them anyway.
//
// So the greps live here now. A claim a person re-runs by hand is a claim that decays the moment
// nobody re-runs it — which is exactly how the `permit` criterion below was broken for three
// slices without anyone noticing.
//
// ── THIS FILE IS EXEMPT FROM ITS OWN SEARCHES, AND HAS TO BE ──
//
// It names the terms it forbids. Including itself in the corpus would make every assertion
// self-refuting, which is the same trap `hooks.test.ts` fell into when a doc comment satisfied the
// check it was supposed to fail. Every scope below excludes this path explicitly, by name, so the
// exemption is visible rather than accidental.

const SELF = 'tests/evidence.test.ts';

/**
 * THE REPOSITORY ROOT, asked for rather than assumed.
 *
 * This file lives in the `tests` workspace, so vitest runs it with that directory as the working
 * directory — and the first run reported four claims as HELD while searching twelve files, because
 * `git ls-files` had returned only what lives under `tests/`. A corpus check that silently searches
 * a fraction of the corpus is the NUL byte's failure arriving by another route, so the root is
 * resolved from git and every path is resolved against it.
 */
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

function gitText(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function gitBytes(args: string[]): Buffer {
  return execFileSync('git', args, { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
}

/** Tracked files, from git — the corpus a reviewer or a grep would actually see. */
function trackedFiles(): string[] {
  return gitText(['ls-files'])
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f.length > 0 && f !== SELF);
}

/** Binary by intent — `.gitattributes` marks the PDF, and media is never source. */
const BINARY = /\.(pdf|webm|png|jpe?g|ico|woff2?|mp4)$/i;

const TEXT_SOURCE = /\.(ts|tsx|js|mjs|cjs|sql|css|json|ya?ml|md|sh|txt)$/i;

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

/**
 * Source with comments removed.
 *
 * Prose about a rule must not satisfy the rule. Every structural assertion in this repository
 * learned that from the UI2 false pass, where `HOOK.transcript` appeared in a doc comment and the
 * check that was meant to catch its deletion passed instead.
 */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/^\s*--.*$/gm, '') // SQL line comments
    .replace(/^\s*#.*$/gm, ''); // YAML and shell line comments
}

/**
 * Files that must be allowed to name the thing they forbid.
 *
 * `mandate-records.test.ts` asserts that no serialised member carries a `mandate_label`, which it
 * can only do by containing the string. Same exemption as this file's own, and listed by name for
 * the same reason: an exemption that is visible can be argued with.
 */
const NAMES_WHAT_IT_FORBIDS = ['apps/api/test/mandate-records.test.ts'];

function matches(paths: string[], pattern: RegExp, stripComments = true): string[] {
  const found: string[] = [];
  for (const p of paths) {
    const src = stripComments ? code(p) : read(p);
    src.split('\n').forEach((line, i) => {
      if (pattern.test(line)) found.push(`${p}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  return found;
}

const tracked = trackedFiles();
const source = tracked.filter((f) => TEXT_SOURCE.test(f) && !BINARY.test(f));

/**
 * THE ROOM, THE FABRIC AND THE DATA MODEL — the surfaces Roadmap §6's anti-lock-in rule is about.
 *
 * Tests are excluded and that is not a loophole: `members.test.ts` and `conformance.ts` assert that
 * provider names DO NOT appear, which means they have to contain them. Excluding the files whose
 * job is to name the forbidden thing is the only way the assertion can exist at all.
 */
const PRODUCT = [
  'apps/api/src/',
  'apps/web/app/',
  'packages/fabric/',
  'packages/shared/',
  'infra/migrations/',
  'prompts/',
  'mandates/',
];
const productSource = source.filter(
  (f) => PRODUCT.some((p) => f.startsWith(p)) && !f.includes('.test.'),
);

describe('the corpus is searchable (the failure that hid the rest)', () => {
  it('SEARCHES THE WHOLE REPOSITORY, not whichever directory vitest started in', () => {
    // The guard on the guard. Every assertion below is an ASSERTION OF ABSENCE, and absence is
    // what an empty corpus also looks like — so the corpus itself is asserted first. The first
    // run of this file searched 12 files instead of 169 and reported four claims as held.
    expect(tracked.length).toBeGreaterThan(150);
    expect(source).toContain('apps/api/src/agent.ts');
    expect(productSource).toContain('apps/api/src/agent.ts');
  });

  it('NO TRACKED SOURCE FILE CONTAINS A NUL BYTE', () => {
    // THE CLASS, not the instance. One NUL removed `agent.ts` from every content search for eight
    // slices, and nothing in the repository could notice: a search that skips a file returns
    // fewer results, which looks exactly like a clean result.
    //
    // Read as BYTES. A `grep` for `\x00` from a shell cannot work — bash cannot hold a NUL in a
    // string, so the pattern is empty and matches every file. That mistake was made while writing
    // this test, which is the second reason the check belongs in code.
    const offenders = tracked
      .filter((f) => !BINARY.test(f))
      .filter((f) => readFileSync(resolve(ROOT, f)).includes(0));
    expect(offenders, 'a NUL byte removes a file from every ripgrep search').toEqual([]);
  });

  it('no tracked source file is stored with CRLF, per `.gitattributes` eol=lf', () => {
    // Checked against the INDEX rather than the working tree, deliberately: `* text=auto eol=lf`
    // means git normalises on commit, so a working-tree file with CRLF is stored as LF and shows
    // no diff. Asserting on the working tree would fail on files a Windows tool touched, for a
    // condition git has already handled.
    //
    // A BACKSTOP, and worth knowing why it is only that: `text=auto` STOPS normalising a file it
    // detects as binary — which a NUL byte makes it do. So the CRLF that produced a 546-line diff
    // for a 29-line change in S13-1 was a SYMPTOM of the NUL, not an independent defect. The
    // primary check is the one above; this one catches a file explicitly marked `-text`.
    const offenders = source.filter((f) => {
      const staged = gitBytes(['show', `:${f}`]);
      return staged.includes('\r\n');
    });
    expect(offenders).toEqual([]);
  });
});

describe('claims a closeout asserted by grep', () => {
  it('S0.4 / Roadmap §6 — NO PROVIDER OR MODEL NAME in the room, fabric or data model', () => {
    // The headline criterion of S0.4, and the one the NUL was most able to falsify: `agent.ts`
    // constructs adapters. It was never in the searched corpus until S1.3 removed the byte.
    const PROVIDERS =
      /anthropic|openai|chatgpt|gpt-\d|azure|bedrock|claude-3|claude-(sonnet|haiku|opus)|\bsonnet\b|\bhaiku\b|gemini|llama/i;
    expect(matches(productSource, PROVIDERS, false)).toEqual([]);
  });

  it('M-3 — EXACTLY ONE construction site for a decision event', () => {
    // `appendDecision` takes a Verdict, so a decision cannot be invented without an evaluation.
    // That is a property of the signature; this is the property of the LAYOUT — one caller, so the
    // audit line, the reason code and the mandate hash are written in one readable place.
    const callers = source
      .filter(
        (f) => /^(apps|packages)\//.test(f) && !f.includes('.test.') && !f.endsWith('events.ts'),
      )
      .filter((f) => /\bappendDecision\s*\(/.test(code(f)));
    expect(callers).toEqual(['apps/api/src/commands/requestAction.ts']);
  });

  it('S0.5a — EXACTLY ONE writer of agent turn events', () => {
    // The claim S0.5a's closeout made about a file the search could not read. It holds, and until
    // now it held without evidence: a ripgrep for callers would have reported none in `agent.ts`,
    // which is where the only caller lives.
    const callers = source
      .filter((f) => f.startsWith('apps/api/src/') && !f.endsWith('events.ts'))
      .filter((f) => /\bappendAgentEvent\s*\(/.test(code(f)));
    expect(callers).toEqual(['apps/api/src/agent.ts']);
  });

  it('ADR-006 — `permit` appears nowhere in code, schema, prompt or config', () => {
    // BROKEN WHEN RE-RUN, 27 Jul 2026. Four hits, all English usage — which ADR-006 explicitly
    // refused to except: "A sentence using 'permit' as a verb is REWORDED rather than left,
    // because the exit criterion is a zero-hit grep and a grep cannot distinguish the two."
    //
    // Two of the four predated the ADR (`hooks.test.ts`, `conformance.ts`), so the claim was
    // false at the moment it was written; one arrived after it (migration 008). None of them was
    // in `agent.ts`, so the NUL is not the excuse — the grep was run once and never again.
    const scope = source.filter((f) =>
      /^(apps|packages|prompts|infra|scripts|mandates|tests|\.github)\//.test(f),
    );
    expect(matches(scope, /permit/i, false)).toEqual([]);
  });

  it('S0.5b — no `agent.summon` scope exists anywhere', () => {
    // The scope that must not be invented: an agent authorised to summon another agent is the
    // cross-principal conscription barrier 1 exists to prevent, and it must not arrive as a
    // mandate field before there is a decision to make it one.
    // Scoped to code, schema and config — NOT prose. The red-team ledger names this scope in the
    // row recording that it does not exist, and the assertion caught its own documentation on the
    // first run. Same trap as this file's self-exemption, and the same fix: the claim is about a
    // mandate field and a code path, so that is what is searched.
    const scope = source.filter((f) => !f.startsWith('docs/'));
    expect(matches(scope, /agent\.summon/, false)).toEqual([]);
  });

  it('§21.2 — no hardcoded member id or summon token in the room or the api', () => {
    // The anti-lock-in exit: "same prompt routes through either member via roster config, no
    // app-code change". `agent.ts` HELD a hardcoded `@claude` and a literal member id until
    // S0.5b — and a grep that skipped the file would have passed before the fix as easily as
    // after it. The one exception is the dev fixture, which is dev-only, 404s in production and
    // has to name a member to build a fixture at all.
    // SCOPED TO APP SOURCE AND THE PROMPT, which is what "no app-code change" covers. Three
    // exclusions, each because the file IS the configuration routing comes from:
    //
    //   * `infra/migrations/007…` seeds the member rows — the roster itself;
    //   * `mandates/*.json` are keyed by member, which is what a mandate is;
    //   * `apps/web/app/dev/` is the dev fixture: dev-only, 404s in production, and it must name
    //     a member to build a fixture at all.
    //
    // THE PROMPT IS IN SCOPE, and it failed this assertion when written: it said "you are summoned
    // by name (for example, `@claude`)" — one shared prompt, so Sol was told another member's tag
    // as its own example. Routing was never affected, which is why no test caught it and why the
    // §21.2 claim was still true; a prompt that names one member to all of them is a different
    // defect, and it is fixed rather than excepted.
    const scope = source.filter(
      (f) =>
        (f.startsWith('apps/') || f.startsWith('packages/') || f.startsWith('prompts/')) &&
        !f.includes('.test.') &&
        !f.startsWith('apps/web/app/dev/'),
    );
    expect(matches(scope, /['"`]@(claude|sol)|['"`](claude-main|sol)['"`]|`@claude`/i)).toEqual([]);
  });

  it('UI2 — `mandate_label` is gone as a field', () => {
    // Descriptive text that looked like authority. The roster renders the mandate's own scope
    // array now, so the words a viewer reads are a function of what the evaluator checks.
    // Comments recording its removal are stripped; a live field would fail.
    // `docs/` is excluded on ADR-006's own precedent: a historical document that has been
    // silently edited is no longer evidence of what was decided, so the design record and the RA
    // that cite the removed field keep their wording.
    const scope = source.filter(
      (f) => !f.startsWith('docs/') && !NAMES_WHAT_IT_FORBIDS.includes(f),
    );
    expect(matches(scope, /mandate_label/)).toEqual([]);
  });

  it('S13-N3 — NO CLIENT COMPONENT READS THE MEMBER CREDENTIAL', () => {
    // The second face of S13-N3, guarded structurally. The credential used to be read in the room
    // page and handed to a client component as a prop, which serialised it into the HTML — so
    // anyone who could read the page could connect as that member, permanently.
    //
    // A client component is anything marked `'use client'`. Server files may read the credential
    // and do: the roster fetch presents it as a Bearer header, and the ticket route exchanges it.
    // What must never happen again is the value crossing into a bundle or a payload.
    //
    // The runtime half — that the rendered HTML contains no credential material — is asserted by
    // the capture harness against a real page, because no source-level check can see a payload.
    const clientComponents = source
      .filter((f) => f.startsWith('apps/web/app/') && /\.(tsx|ts)$/.test(f))
      .filter((f) => /^\s*['"]use client['"]/m.test(read(f)));
    expect(
      clientComponents.length,
      'no client components found — the scope is wrong',
    ).toBeGreaterThan(0);
    expect(matches(clientComponents, /PLAYROOM_WEB_TOKEN/)).toEqual([]);
  });

  it('S13-N3 — the room page does not pass a credential to the room', () => {
    // Narrower and blunter than the rule above, aimed at the exact shape that failed: a `token`
    // prop. It is the kind of thing a later slice re-adds for a good reason and a bad outcome.
    expect(code('apps/web/app/r/[id]/page.tsx')).not.toMatch(/token=\{/);
    expect(code('apps/web/app/r/[id]/Room.tsx')).not.toMatch(/token:\s*string/);
  });

  it('S06-N3 — the decision card never says `attempted`', () => {
    // The card asserted intent the product cannot produce. It says who requested what, under
    // whose mandate — and as of S1.3 it names the requester, because both halves are records now.
    expect(code('apps/web/app/DecisionCard.tsx')).not.toMatch(/attempted/i);
  });
});
