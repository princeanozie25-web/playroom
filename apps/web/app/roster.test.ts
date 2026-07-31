import { describe, expect, it } from 'vitest';
import {
  ACCENT_COUNT,
  discloseLimits,
  discloseList,
  expiryState,
  mandateSummary,
  principalAccent,
  truncateHash,
} from './mandate';

// THE DERIVATIONS THAT PUT WORDS AND COLOUR ON SCREEN.
//
// M-3's rule is that what a viewer reads is a function of the mandate the evaluator checks,
// never a hand-written caption. `mandateSummary` is now the thing standing between those two,
// so it is the thing that has to be tested — a compact summary is exactly where a plausible
// but wrong phrase would survive unnoticed.
//
// The block that asserted "config names every principal the roster refers to" is GONE from
// here: after S1.1a that is a property of the `members`/`principals` tables and of the API
// that serves them, and asserting it in a unit test would mean either a live server or a
// mock of one. It moved to apps/api/test/members.test.ts, against the real records.

describe('mandateSummary — derived, never written', () => {
  it('marks protected actions so "may ask" cannot read as "may do"', () => {
    expect(mandateSummary(['pr.review', 'pr.comment', 'pr.merge'], ['pr.merge', 'deploy'])).toBe(
      'review + comment, merge (co-sign)',
    );
  });

  it('says "only" when nothing in scope is gated', () => {
    expect(mandateSummary(['pr.review', 'pr.comment'], ['pr.merge', 'deploy'])).toBe(
      'review + comment only',
    );
  });

  it('handles a scope that is entirely protected', () => {
    expect(mandateSummary(['pr.merge'], ['pr.merge'])).toBe('merge (co-sign)');
  });

  it('returns NULL for no mandate — an absent mandate must never read as unrestricted', () => {
    expect(mandateSummary(null, null)).toBeNull();
    expect(mandateSummary([], ['pr.merge'])).toBeNull();
  });

  it('only ever uses verbs that came from the scope', () => {
    // The guard against the summary acquiring vocabulary of its own. Every word except the
    // two grammar tokens must be traceable to a scope entry.
    const summary = mandateSummary(['repo.clone', 'secret.read'], ['secret.read']) ?? '';
    for (const word of summary.split(/[^a-z]+/i).filter(Boolean)) {
      expect(['clone', 'read', 'co', 'sign', 'only']).toContain(word);
    }
  });

  it('does not lose a granted action to brevity', () => {
    // Understating authority is a different lie from overstating it, and just as bad.
    const scope = ['pr.review', 'pr.comment', 'pr.merge'];
    const summary = mandateSummary(scope, ['pr.merge']) ?? '';
    for (const action of scope) expect(summary).toContain(action.split('.')[1]);
  });
});

describe('principal accents', () => {
  it('assigns by index, so two principals cannot be handed one colour', () => {
    const assigned = Array.from({ length: ACCENT_COUNT }, (_, i) => principalAccent(i));
    expect(new Set(assigned).size).toBe(ACCENT_COUNT);
  });

  it('wraps beyond the palette — the honest limit, not a silent collision', () => {
    expect(principalAccent(ACCENT_COUNT)).toBe(principalAccent(0));
  });

  it('survives four principals without two looking alike', () => {
    expect(ACCENT_COUNT).toBeGreaterThanOrEqual(4);
  });
});

describe('expiryState — expiry is a STATE, not a date (UI3-3)', () => {
  const now = new Date('2026-07-31T00:00:00Z');
  it('null is undisclosed — a member with no mandate has no expiry to render', () => {
    expect(expiryState(null, now)).toEqual({ kind: 'undisclosed' });
  });
  it('a FUTURE instant is live', () => {
    expect(expiryState('2026-11-30T00:00:00Z', now)).toEqual({
      kind: 'live',
      at: '2026-11-30T00:00:00Z',
    });
  });
  it('a PAST instant is expired — the trap: it must not read as live with a stale date beside it', () => {
    expect(expiryState('2026-01-01T00:00:00Z', now)).toEqual({
      kind: 'expired',
      at: '2026-01-01T00:00:00Z',
    });
  });
  it('exactly now is expired — the boundary denies rather than grants (<= now)', () => {
    expect(expiryState('2026-07-31T00:00:00Z', now)).toEqual({
      kind: 'expired',
      at: '2026-07-31T00:00:00Z',
    });
  });
  it('an unparseable instant discloses no state — never defaults to live', () => {
    expect(expiryState('not-a-date', now)).toEqual({ kind: 'undisclosed' });
  });
});

describe('discloseList / discloseLimits — undisclosed, empty and present stay three facts (UI3-3)', () => {
  it('null is undisclosed (no mandate); [] is empty (a real "none"); values are present', () => {
    expect(discloseList(null)).toEqual({ kind: 'undisclosed' });
    expect(discloseList([])).toEqual({ kind: 'empty' });
    expect(discloseList(['pr.merge'])).toEqual({ kind: 'present', value: ['pr.merge'] });
  });
  it('null limits is undisclosed; {} is empty; entries are present', () => {
    expect(discloseLimits(null)).toEqual({ kind: 'undisclosed' });
    expect(discloseLimits({})).toEqual({ kind: 'empty' });
    expect(discloseLimits({ interrupts_per_day: 6 })).toEqual({
      kind: 'present',
      value: [['interrupts_per_day', 6]],
    });
  });
});

describe('truncateHash — recognisable on screen, whole value kept for copy (UI3-3)', () => {
  const full = 'sha256:' + 'a'.repeat(64);
  it('keeps the scheme and both ends, and is far shorter than the original', () => {
    const t = truncateHash(full);
    expect(t.startsWith('sha256:')).toBe(true);
    expect(t).toContain('…');
    expect(t.length).toBeLessThan(full.length);
  });
  it('leaves a short value untouched — nothing to truncate', () => {
    expect(truncateHash('sha256:abcd')).toBe('sha256:abcd');
  });
});
