import { describe, expect, it } from 'vitest';
import { loadPrincipals, loadRoster } from './roster';
import { ACCENT_COUNT, mandateSummary, principalAccent } from './mandate';

// THE DERIVATIONS THAT PUT WORDS AND COLOUR ON SCREEN.
//
// M-3's rule is that what a viewer reads is a function of the mandate the evaluator checks,
// never a hand-written caption. `mandateSummary` is now the thing standing between those two,
// so it is the thing that has to be tested — a compact summary is exactly where a plausible
// but wrong phrase would survive unnoticed.

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

describe('config as it actually stands', () => {
  it('names every principal the roster refers to, so no identifier can reach the screen', () => {
    const known = new Set(loadPrincipals().map((p) => p.id));
    for (const m of loadRoster()) {
      expect(known, `${m.id} refers to ${m.principal}, which config does not name`).toContain(
        m.principal,
      );
      expect(m.principal_name).toBeTruthy();
      expect(m.accent).not.toBeNull();
    }
  });

  it('gives the two current members different accents', () => {
    const roster = loadRoster();
    expect(roster.length).toBeGreaterThanOrEqual(2);
    expect(new Set(roster.map((m) => m.accent)).size).toBe(roster.length);
  });
});
