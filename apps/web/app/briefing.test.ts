import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// A BRIEFING ROW COMES FROM THE LOG AND FROM NOWHERE ELSE (S1.7).
//
// Source-level, exactly as promotion.test.ts and for the same reason: there is no DOM here (see
// hooks.test.ts for why). So this proves the room has exactly the TWO construction sites for a briefing
// row — the `briefing.set` and `briefing.cleared` branches — that every field is read off the event,
// and that the row is visually distinct from a message and stays text. Not that it reaches the screen;
// the capture (S17-4) and the film harness's zero-match-selector failure are the other half.

const APP = resolve(import.meta.dirname);
const room = readFileSync(resolve(APP, 'r/[id]/Room.tsx'), 'utf8');
const component = readFileSync(resolve(APP, 'BriefingRow.tsx'), 'utf8');
const css = readFileSync(resolve(APP, 'globals.css'), 'utf8');

// The component with comments removed, so an assertion about the CODE cannot be satisfied or broken by
// prose that happens to explain the very thing being asserted (the "no accent" trap promotion.test hit).
const code = component.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// A CONSTRUCTION (comma), not a type (semicolon): `kind: 'briefing',` makes one; `kind: 'briefing';`
// in the type alias declares the shape. There are two acts — a set and a clear — so two sites.
const CONSTRUCTION = /kind:\s*'briefing',/g;

describe('the room builds a briefing row only from a briefing event', () => {
  it('creates a briefing item exactly twice — one site per act (set and cleared)', () => {
    expect(room.match(CONSTRUCTION) ?? []).toHaveLength(2);
  });

  it('the set site sits in the `briefing.set` branch and the clear site in `briefing.cleared`', () => {
    for (const branchType of ['briefing.set', 'briefing.cleared'] as const) {
      const branch = room.indexOf(`ev.event_type === '${branchType}'`);
      const site = room.indexOf("kind: 'briefing',", branch);
      const nextBranch = room.indexOf('} else if (ev.event_type ===', branch + 1);
      expect(branch, `the ${branchType} branch is gone`).toBeGreaterThan(-1);
      expect(nextBranch, 'no branch follows — the window is unbounded').toBeGreaterThan(branch);
      expect(site).toBeGreaterThan(branch);
      expect(site).toBeLessThan(nextBranch);
    }
  });

  it('every field the row shows is read off the event payload — nothing derived, nothing defaulted', () => {
    for (const path of [
      'ev.payload.briefing_id',
      'ev.payload.set_by',
      'ev.payload.purpose',
      'ev.payload.content',
      'ev.payload.replaces_hash',
      'ev.payload.cleared_by',
    ]) {
      expect(room, `${path} is not read from the payload`).toContain(path);
    }
  });
});

describe('the component cannot be given a briefing that did not happen', () => {
  it('takes exactly two props — the view from the log, and the roster', () => {
    const props = component.match(/^}: \{$[\s\S]*?^}\)/m)?.[0] ?? '';
    expect(props).toContain('briefing: BriefingItemView');
    expect(props).toContain('roster: Map<string, RosterMember>');
    expect(props.match(/^\s{2}\w+[?]?:/gm) ?? []).toHaveLength(2);
  });

  it('invents nothing — no `??` fallback for an owner, a purpose or content', () => {
    // A `?? ''` on a purpose or content would render a briefing that carries neither as though it did.
    // The variants (set vs cleared) are handled by presence, not by a fallback lie.
    expect(component).not.toContain('??');
  });
});

describe('§5.2 — visibly distinct from a message, and the text stays text', () => {
  it('renders no principal accent — a briefing carries no authority, so it wears none', () => {
    expect(code).not.toContain('data-accent');
    expect(code).not.toContain('accent');
    const block = css.slice(css.indexOf('.briefing {'));
    expect(block.slice(0, block.indexOf('}'))).not.toContain('accent');
  });

  it('is not built out of the message or turn classes, and carries its own label', () => {
    // Distinctness has to be structural, not a tweak to a shared class, or the next restyle of
    // `.msg-body` silently restyles the room's standing brief.
    expect(code).not.toContain('msg-body');
    expect(code).not.toContain('turn-body');
    expect(code).not.toContain('turn-head');
    expect(code).toContain('className="briefing"');
    // The label is what makes it unmistakable as the room's standing brief, not a line someone spoke.
    expect(code).toContain('Room briefing');
  });

  it('preserves whitespace and parses no markup — A4-F8, §13', () => {
    const block = css.slice(css.indexOf('.briefing-body {'));
    expect(css).toContain('.briefing-body {');
    expect(block.slice(0, block.indexOf('}'))).toContain('white-space: pre-wrap');
    expect(component).not.toContain('dangerouslySetInnerHTML');
  });
});
