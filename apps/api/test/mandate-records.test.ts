import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  listMembers,
  MandatePrincipalMismatchError,
  UnknownMandateMemberError,
} from '../src/members.js';
import { testPool } from './support.js';

// MANDATES POINT AT RECORDS, AND SAY SO WHEN THEY DO NOT.
//
// BEFORE this slice: `loadMandates()` keyed a map by whatever the `member` field said, and
// nothing cross-checked it against anything. A mandate naming a member that did not exist sat
// in that map unread, and the member it was MEANT for was left with no mandate — which
// evaluates to BLOCK/NO_MANDATE. So a typo produced a silently powerless agent whose only
// symptom was that it had stopped being able to do anything.
//
// Deny-by-default is correct and is not what was wrong. What was wrong is that it made a
// BROKEN configuration indistinguishable from a DELIBERATE one. That is the A4-F1 shape at
// the authority layer: the failure and the intended state produce the same observation.
//
// AFTER: the load path throws, naming the member. The server loads members in an awaited
// onReady hook, so a mandate pointing at nobody stops the process from starting rather than
// producing a room where one agent quietly cannot act.

const pool = testPool();
const MANDATES_DIR = resolve(import.meta.dirname, '../../../mandates');

afterAll(async () => {
  await pool.end();
});

/** Run `fn` with an extra mandate file present, then put the directory back. */
function withExtraMandate<T>(name: string, body: unknown, fn: () => Promise<T>): Promise<T> {
  // A COPY of the real mandates plus one more, in a temp dir. The real mandates/ is never
  // written to: a test that edits the repository's own authority documents and restores them
  // on the way out is one crash away from leaving a broken mandate behind.
  const dir = mkdtempSync(join(tmpdir(), 'playroom-mandates-'));
  for (const f of readdirSync(MANDATES_DIR).filter((f) => f.endsWith('.json'))) {
    writeFileSync(join(dir, f), readFileSync(join(MANDATES_DIR, f), 'utf8'));
  }
  writeFileSync(join(dir, name), JSON.stringify(body));
  const previous = process.env.PLAYROOM_MANDATES_DIR;
  process.env.PLAYROOM_MANDATES_DIR = dir;
  return fn().finally(() => {
    if (previous === undefined) delete process.env.PLAYROOM_MANDATES_DIR;
    else process.env.PLAYROOM_MANDATES_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
}

const validMandate = (member: string, principal: string) => ({
  mandate_id: `mnd_${member.replace(/-/g, '_')}_test`,
  principal,
  member,
  scope: ['pr.review'],
  protected_actions: ['pr.merge', 'deploy'],
  co_sign: { actions: ['pr.merge', 'deploy'], by: 'principal' },
  limits: { interrupts_per_day: 6, postage_per_day: 200 },
  counterparties: 'roster_only',
  policy_version: 'playroom-policy/1.0',
  expires: '2026-11-30T00:00:00Z',
});

afterEach(() => {
  delete process.env.PLAYROOM_MANDATES_DIR;
});

describe('a mandate naming a member that does not exist', () => {
  it('FAILS LOUDLY at load, naming the member and what is known', async () => {
    await withExtraMandate(
      'ghost.json',
      validMandate('ghost-member', 'principal:prince'),
      async () => {
        await expect(listMembers(pool)).rejects.toThrow(UnknownMandateMemberError);
        await expect(listMembers(pool)).rejects.toThrow(/ghost-member/);
        // The message must say what IS known, or the reader learns only that they were wrong.
        await expect(listMembers(pool)).rejects.toThrow(/claude-main/);
      },
    );
  });

  it('does not merely leave the intended member powerless, which is what happened before', async () => {
    // The regression guard for the old behaviour. Previously this configuration loaded
    // cleanly and the room simply contained an agent that could do nothing. If this ever
    // resolves instead of rejecting, that failure mode is back.
    await withExtraMandate(
      'typo.json',
      validMandate('claude-mian', 'principal:prince'),
      async () => {
        await expect(listMembers(pool)).rejects.toThrow(UnknownMandateMemberError);
      },
    );
  });
});

describe('a mandate whose principal disagrees with the binding', () => {
  it('FAILS LOUDLY — the record is the authority on who a member acts for', async () => {
    // Two representations of one fact now exist: `members.principal_id` (the binding) and
    // the mandate's own `principal` field. They can disagree, and a disagreement about WHOSE
    // AUTHORITY A MEMBER CARRIES is not something to resolve by preferring one silently.
    // The decision event's `principal` is read from the mandate (requestAction.ts), so a
    // mismatch would attribute a refusal to the wrong principal on screen.
    await withExtraMandate(
      'claude-main.json',
      validMandate('claude-main', 'principal:jerry'),
      async () => {
        await expect(listMembers(pool)).rejects.toThrow(MandatePrincipalMismatchError);
        await expect(listMembers(pool)).rejects.toThrow(/principal:jerry/);
        await expect(listMembers(pool)).rejects.toThrow(/principal:prince/);
      },
    );
  });
});

describe('the compact summary still has exactly one source', () => {
  it('serves the ARRAYS and no rendered summary, so there is nothing to drift from', async () => {
    // Third slice running in which this could quietly acquire a duplicate: the roster now
    // travels over HTTP, and a `mandate_summary` string in that payload would be a second
    // representation of the member's authority — able to disagree with the array the
    // evaluator checks, which is precisely what `mandate_label` was.
    //
    // The assertion is split across the workspace boundary because the derivation lives in
    // apps/web and cannot be imported here (separate TS projects, and importing across would
    // be worse than testing each half where it lives):
    //   * HERE — the payload carries the arrays and NO rendered summary of any name.
    //   * apps/web/app/roster.test.ts — `mandateSummary` over exactly these arrays produces
    //     "review + comment, merge (co-sign)" and "review + comment only".
    const members = await listMembers(pool);

    const claude = members.find((m) => m.id === 'claude-main');
    // `summon.initiate` joined claude-main's scope in S1.8 — the smallest honest grant that lets ONE
    // agent initiate a summon through the tool-call channel; sol/ada/bo are default-closed.
    expect(claude?.scope).toEqual(['pr.review', 'pr.comment', 'pr.merge', 'summon.initiate']);
    expect(claude?.protected_actions).toEqual(['pr.merge', 'deploy']);
    const sol = members.find((m) => m.id === 'sol');
    expect(sol?.scope).toEqual(['pr.review', 'pr.comment']);

    // No pre-rendered authority text under ANY plausible name.
    for (const m of members) {
      const keys = Object.keys(m);
      for (const forbidden of ['mandate_summary', 'summary', 'mandate_label', 'scope_text']) {
        expect(keys, `${m.id} carries a rendered summary: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
