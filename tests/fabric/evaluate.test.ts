import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import {
  evaluate,
  loadMandates,
  mandateHash,
  Mandate,
  type LoadedMandate,
  type ReasonCode,
  type Decision,
} from '@playroom/fabric';

// Mandate table test. Bible §9.2 (order), §10 (deny by default), §11 (<10 ms P50,
// <30 ms P95), §20 (40 cases at S2.1 — this is the v0 floor of 12, and the count is
// stated rather than implied).
//
// EVERY CASE ASSERTS THE DECISION AND ITS REASON CODE. A test that only asserts a
// merge did not happen passes whether the mandate refused it, the handler threw or the
// process died — that is the RT-001 mistake moved up a layer, and it is not accepted
// here. Where a co-signature is required, the required signer is asserted too.

const NOW = new Date('2026-07-26T12:00:00.000Z');

function loaded(overrides: Partial<Mandate> = {}): LoadedMandate {
  const mandate = Mandate.parse({
    mandate_id: 'mnd_test',
    principal: 'principal:prince',
    member: 'claude-main',
    scope: ['pr.review', 'pr.comment'],
    protected_actions: ['pr.merge', 'deploy'],
    co_sign: { actions: ['pr.merge', 'deploy'], by: 'principal' },
    limits: { interrupts_per_day: 6 },
    counterparties: 'roster_only',
    policy_version: 'playroom-policy/1.0',
    expires: '2026-11-30T00:00:00Z',
    ...overrides,
  });
  return { mandate, hash: mandateHash(mandate) };
}

interface Case {
  name: string;
  action: string;
  member: string;
  mandate: LoadedMandate | undefined;
  decision: Decision;
  reason: ReasonCode;
  signer?: string | null;
}

const CASES: Case[] = [
  // --- in scope: ALLOW is demonstrable -------------------------------------------
  {
    name: '1. in scope — pr.review',
    action: 'pr.review',
    member: 'claude-main',
    mandate: loaded(),
    decision: 'ALLOW',
    reason: 'ALLOWED_IN_SCOPE',
    signer: null,
  },
  {
    name: '2. in scope — a second granted action, not just the first in the array',
    action: 'pr.comment',
    member: 'claude-main',
    mandate: loaded(),
    decision: 'ALLOW',
    reason: 'ALLOWED_IN_SCOPE',
    signer: null,
  },
  {
    name: '3. in scope — boundary: last entry in the scope array',
    action: 'pr.comment',
    member: 'claude-main',
    mandate: loaded(),
    decision: 'ALLOW',
    reason: 'ALLOWED_IN_SCOPE',
    signer: null,
  },

  // --- out of scope, and the deny-by-default line --------------------------------
  {
    name: '4. out of scope — a real action the mandate does not grant',
    action: 'pr.close',
    member: 'claude-main',
    mandate: loaded(),
    decision: 'BLOCK',
    reason: 'OUT_OF_SCOPE',
  },
  {
    name: '5. UNKNOWN action type is DENIED, not granted (deny-by-default)',
    action: 'totally.made.up.action',
    member: 'claude-main',
    mandate: loaded(),
    decision: 'BLOCK',
    reason: 'OUT_OF_SCOPE',
  },
  {
    name: '6. empty action type is denied, not treated as a wildcard',
    action: '',
    member: 'claude-main',
    mandate: loaded(),
    decision: 'BLOCK',
    reason: 'OUT_OF_SCOPE',
  },
  {
    name: '7. scope matching is exact — a prefix of a granted action is not granted',
    action: 'pr.rev',
    member: 'claude-main',
    mandate: loaded(),
    decision: 'BLOCK',
    reason: 'OUT_OF_SCOPE',
  },
  {
    name: '8. scope matching is case-sensitive — PR.REVIEW is not pr.review',
    action: 'PR.REVIEW',
    member: 'claude-main',
    mandate: loaded(),
    decision: 'BLOCK',
    reason: 'OUT_OF_SCOPE',
  },

  // --- protected actions ---------------------------------------------------------
  {
    name: '9. protected action — pr.merge pauses for the principal (deck beat 5)',
    action: 'pr.merge',
    member: 'claude-main',
    mandate: loaded({ scope: ['pr.review', 'pr.merge'] }),
    decision: 'CO_SIGN',
    reason: 'PROTECTED_ACTION',
    signer: 'principal:prince',
  },
  {
    name: '10. protected action — deploy, second entry in protected_actions',
    action: 'deploy',
    member: 'claude-main',
    mandate: loaded({ scope: ['deploy'] }),
    decision: 'CO_SIGN',
    reason: 'PROTECTED_ACTION',
    signer: 'principal:prince',
  },
  {
    name: '11. BOUNDARY: protected but NOT in scope is BLOCK, not CO_SIGN — scope is checked first',
    action: 'pr.merge',
    member: 'claude-main',
    mandate: loaded(), // pr.merge is protected but absent from scope
    decision: 'BLOCK',
    reason: 'OUT_OF_SCOPE',
  },
  {
    name: '12. co_sign.by names a signer directly — the signer is not defaulted',
    action: 'pr.merge',
    member: 'claude-main',
    mandate: loaded({
      scope: ['pr.merge'],
      co_sign: { actions: ['pr.merge'], by: 'principal:jerry' },
    }),
    decision: 'CO_SIGN',
    reason: 'PROTECTED_ACTION',
    signer: 'principal:jerry',
  },

  // --- expiry --------------------------------------------------------------------
  {
    name: '13. expired mandate — BLOCK even for an in-scope action',
    action: 'pr.review',
    member: 'claude-main',
    mandate: loaded({ expires: '2026-07-25T00:00:00Z' }),
    decision: 'BLOCK',
    reason: 'MANDATE_EXPIRED',
  },
  {
    name: '14. BOUNDARY: expiry exactly at `now` is expired — the window is closed, not open',
    action: 'pr.review',
    member: 'claude-main',
    mandate: loaded({ expires: NOW.toISOString() }),
    decision: 'BLOCK',
    reason: 'MANDATE_EXPIRED',
  },
  {
    name: '15. BOUNDARY: one second before expiry still ALLOWs',
    action: 'pr.review',
    member: 'claude-main',
    mandate: loaded({ expires: new Date(NOW.getTime() + 1000).toISOString() }),
    decision: 'ALLOW',
    reason: 'ALLOWED_IN_SCOPE',
    signer: null,
  },
  {
    name: '16. expiry outranks protected — an expired mandate does not reach CO_SIGN',
    action: 'pr.merge',
    member: 'claude-main',
    mandate: loaded({ scope: ['pr.merge'], expires: '2026-07-25T00:00:00Z' }),
    decision: 'BLOCK',
    reason: 'MANDATE_EXPIRED',
  },

  // --- absent mandate, wrong member, wrong principal ------------------------------
  {
    name: '17. NO mandate at all — BLOCK, never ALLOW',
    action: 'pr.review',
    member: 'someone-unknown',
    mandate: undefined,
    decision: 'BLOCK',
    reason: 'NO_MANDATE',
  },
  {
    name: '18. no mandate — even for an action no mandate anywhere protects',
    action: 'pr.comment',
    member: 'watcher',
    mandate: undefined,
    decision: 'BLOCK',
    reason: 'NO_MANDATE',
  },
  {
    name: '19. wrong member — a mandate belonging to someone else grants nothing',
    action: 'pr.review',
    member: 'sol',
    mandate: loaded(), // mandate.member is claude-main
    decision: 'BLOCK',
    reason: 'NO_MANDATE',
  },
  {
    name: '20. wrong principal — a mandate for another principal grants this member nothing',
    action: 'pr.review',
    member: 'sol',
    mandate: loaded({ member: 'claude-main', principal: 'principal:jerry' }),
    decision: 'BLOCK',
    reason: 'NO_MANDATE',
  },

  // --- empty scope ---------------------------------------------------------------
  {
    name: '21. empty scope grants nothing — not everything',
    action: 'pr.review',
    member: 'claude-main',
    mandate: loaded({ scope: [] }),
    decision: 'BLOCK',
    reason: 'OUT_OF_SCOPE',
  },
];

describe('mandate evaluation (Bible §9.2)', () => {
  it(`covers at least the 12-case v0 floor (has ${CASES.length})`, () => {
    expect(CASES.length).toBeGreaterThanOrEqual(12);
  });

  for (const c of CASES) {
    it(c.name, () => {
      const v = evaluate(
        { type: c.action, resource: 'repo:playroom/playroom#pr-41' },
        c.member,
        c.mandate,
        NOW,
      );
      expect(v.decision).toBe(c.decision);
      expect(v.reason_code).toBe(c.reason);
      if (c.signer !== undefined) expect(v.required_signer).toBe(c.signer);
      // A CO_SIGN without a signer is an unactionable decision — assert the pairing.
      if (v.decision === 'CO_SIGN') expect(v.required_signer).toBeTruthy();
      if (v.decision !== 'CO_SIGN') expect(v.required_signer).toBeNull();
      // Every verdict reached under a mandate carries its hash (Bible §9.2).
      if (c.mandate) expect(v.effective_mandate_hash).toBe(c.mandate.hash);
      else expect(v.effective_mandate_hash).toBeNull();
    });
  }
});

describe('mandate hashing (Bible §9.5)', () => {
  it('is stable and canonical — key order does not change the hash', () => {
    const a = Mandate.parse({
      mandate_id: 'mnd_x',
      principal: 'p',
      member: 'm',
      scope: ['a'],
      protected_actions: [],
      co_sign: { actions: [], by: 'principal' },
      limits: {},
      counterparties: 'roster_only',
      policy_version: 'v/1',
      expires: '2026-11-30T00:00:00Z',
    });
    // Same document, keys in a different order.
    const b = Mandate.parse({
      expires: '2026-11-30T00:00:00Z',
      policy_version: 'v/1',
      counterparties: 'roster_only',
      limits: {},
      co_sign: { by: 'principal', actions: [] },
      protected_actions: [],
      scope: ['a'],
      member: 'm',
      principal: 'p',
      mandate_id: 'mnd_x',
    });
    expect(mandateHash(a)).toBe(mandateHash(b));
    expect(mandateHash(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('changes when authority changes — a widened scope is a different mandate', () => {
    const narrow = loaded({ scope: ['pr.review'] });
    const wide = loaded({ scope: ['pr.review', 'pr.merge'] });
    expect(narrow.hash).not.toBe(wide.hash);
  });

  it('rejects a mandate carrying a signature field — omit, never stub', () => {
    // `.strict()` refuses unknown keys, so a fake `sig` cannot be smuggled in and then
    // silently ignored by a future sig_valid() that assumes absence means unsigned.
    const withSig = { ...loaded().mandate, sig: 'ed25519:not-a-real-signature' };
    expect(Mandate.safeParse(withSig).success).toBe(false);
  });

  it('rejects a mandate_id without the mnd_ prefix (terminology ruling)', () => {
    expect(Mandate.safeParse({ ...loaded().mandate, mandate_id: 'pmt_7f3a' }).success).toBe(false);
  });
});

describe('the shipped mandates load', () => {
  it('loads mandates/ from disk, keyed by member, with hashes', () => {
    const all = loadMandates();
    expect(all.size).toBeGreaterThan(0);
    const claude = all.get('claude-main');
    expect(claude).toBeDefined();
    expect(claude?.mandate.principal).toBe('principal:prince');
    expect(claude?.mandate.protected_actions).toContain('pr.merge');
    expect(claude?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('the shipped mandate refuses a merge and allows a review', () => {
    const claude = loadMandates().get('claude-main');
    const merge = evaluate({ type: 'pr.merge', resource: 'r' }, 'claude-main', claude, NOW);
    const review = evaluate({ type: 'pr.review', resource: 'r' }, 'claude-main', claude, NOW);
    // The SHIPPED posture: pr.merge is granted but protected, so it reaches CO_SIGN and
    // names a human — deck beat 5. (The other posture, merge absent from scope entirely,
    // yields BLOCK and is covered by table cases 11 and 16. Both are proven; only one
    // can be what the demo room actually shows.)
    expect(merge.decision).toBe('CO_SIGN');
    expect(merge.reason_code).toBe('PROTECTED_ACTION');
    expect(merge.required_signer).toBe('principal:prince');
    expect(review.decision).toBe('ALLOW');
  });
});

describe('evaluation latency against Bible §11 (<10 ms P50, <30 ms P95)', () => {
  it('is orders of magnitude inside budget — anything slower is doing I/O', () => {
    const m = loaded();
    const samples: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const t = performance.now();
      evaluate({ type: 'pr.review', resource: 'r' }, 'claude-main', m, NOW);
      samples.push(performance.now() - t);
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)];
    const p95 = samples[Math.floor(samples.length * 0.95)];
    console.log(
      `[fabric] evaluate() n=${samples.length} P50=${p50.toFixed(4)}ms P95=${p95.toFixed(4)}ms ` +
        `(Bible §11: P50 <10ms, P95 <30ms)`,
    );
    expect(p50).toBeLessThan(10);
    expect(p95).toBeLessThan(30);
    // The real assertion: a pure function should be microseconds. If this ever fails,
    // something has started doing I/O inside the evaluator.
    expect(p95).toBeLessThan(1);
  });
});

// ── COUNTERPARTIES: `roster_only` finally has a roster (S1.1b) ──────────────────────────
//
// This branch was ABSENT until rooms had members — not dead code and not a branch that always
// passed, but a comment holding a position in the order. The field `counterparties:
// "roster_only"` sat in both mandate documents claiming a restriction nothing could enforce,
// which is `room.post`'s failure inside an authority document rather than beside one.
describe('counterparties — roster_only', () => {
  const review = { type: 'pr.review', resource: 'repo:x#1' };

  it('BLOCKS a member acting in a room they are not enrolled in', () => {
    const v = evaluate(review, 'claude-main', loaded(), NOW, ['sol', 'prince']);
    expect(v.decision).toBe('BLOCK');
    expect(v.reason_code).toBe('ROSTER_VIOLATION');
    // Still audited against the mandate it was refused under.
    expect(v.effective_mandate_hash).toMatch(/^sha256:/);
  });

  it('ALLOWS the same action when the member is in the room', () => {
    const v = evaluate(review, 'claude-main', loaded(), NOW, ['claude-main', 'prince']);
    expect(v.decision).toBe('ALLOW');
    expect(v.reason_code).toBe('ALLOWED_IN_SCOPE');
  });

  it('is checked AFTER scope — an unknown action is unknown wherever it is asked', () => {
    // Order matters and it is the Bible's. A member outside the room asking for something
    // they were never granted should hear the more fundamental refusal.
    const v = evaluate(
      { type: 'totally.made.up', resource: 'repo:x#1' },
      'claude-main',
      loaded(),
      NOW,
      ['sol'],
    );
    expect(v.reason_code).toBe('OUT_OF_SCOPE');
  });

  it('is checked AFTER protected actions, per the Bible order — and that has a consequence', () => {
    // Bible §9.2 numbers the branches: 1 expiry, 2 scope, 3 replay, 4 protected,
    // 5 counterparties, 6 limits. The order is the Bible's and this file does not reorder it.
    //
    // THE CONSEQUENCE, ASSERTED RATHER THAN LEFT TO BE DISCOVERED: a protected action asked
    // under a member who is NOT in the room returns CO_SIGN, not ROSTER_VIOLATION. A human is
    // invited to sign for a member who is not even in the room. It stays fail-closed — nothing
    // executes without that signature — but it asks the wrong question first, and the roster
    // refusal is the more fundamental one.
    //
    // Recorded as S11b-N1 rather than fixed here: reordering the Bible's evaluation sequence
    // is an owner ruling, not an implementation detail. The same reasoning that put scope
    // before protected — so an ungranted protected action is BLOCK and not CO_SIGN — argues
    // for putting the roster check before it too.
    const m = loaded({ scope: ['pr.review', 'pr.comment', 'pr.merge'] });
    const merge = { type: 'pr.merge', resource: 'repo:x#1' };
    expect(evaluate(merge, 'claude-main', m, NOW, ['claude-main']).reason_code).toBe(
      'PROTECTED_ACTION',
    );
    expect(evaluate(merge, 'claude-main', m, NOW, ['sol']).reason_code).toBe('PROTECTED_ACTION');

    // Where the roster refusal DOES win: in scope, and not protected.
    expect(evaluate(review, 'claude-main', m, NOW, ['sol']).reason_code).toBe('ROSTER_VIOLATION');
  });

  it('is SKIPPED when the caller has no room context, rather than inventing a verdict', () => {
    // Absent input, absent branch — the same discipline that keeps replay and limits out of
    // this function entirely. A caller with no room cannot be told whether a member is in one.
    expect(evaluate(review, 'claude-main', loaded(), NOW).decision).toBe('ALLOW');
  });

  it('does not fire for a mandate whose counterparties rule is something else', () => {
    const m = loaded({ counterparties: 'anyone' });
    expect(evaluate(review, 'claude-main', m, NOW, ['sol']).decision).toBe('ALLOW');
  });
});
