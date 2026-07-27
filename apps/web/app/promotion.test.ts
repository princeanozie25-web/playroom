import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// A PROMOTION ROW COMES FROM THE LOG AND FROM NOWHERE ELSE.
//
// ── WHY THIS IS A SOURCE-LEVEL TEST, AND WHAT THAT DOES NOT COVER ──
//
// There is no DOM here. `hooks.test.ts` states the same limit for the same reason: adding one means
// jsdom and a testing library, and the other half of the guarantee is the film harness failing a
// take on a zero-match selector. So this proves the room has ONE construction site for a promotion
// and that it is the `context.promoted` branch — not that the element reaches the screen.
//
// That is the half worth having in CI anyway. The failure this is aimed at is not a broken render;
// it is a second way to make one of these rows — a prop, a helper, a fixture — which is how a
// disclosure that never happened ends up looking like one that did. Same rule the DECISION card,
// the task chip and the interrupt chip are held to.

const APP = resolve(import.meta.dirname);
const room = readFileSync(resolve(APP, 'r/[id]/Room.tsx'), 'utf8');
const component = readFileSync(resolve(APP, 'PromotionRow.tsx'), 'utf8');
const css = readFileSync(resolve(APP, 'globals.css'), 'utf8');

/**
 * The component with its comments removed.
 *
 * Needed because the first version of the accent assertion below failed on the word "accent"
 * inside the comment EXPLAINING that there is no accent. A source-level test that reads prose
 * is a test that can be satisfied, or broken, by prose.
 */
const code = component.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// A CONSTRUCTION, not a type. `kind: 'promotion';` inside a type alias declares the shape;
// `kind: 'promotion',` inside an object literal makes one. Counting both reported two sites for a
// room that has one, which is how this test first went red.
const CONSTRUCTION = /kind:\s*'promotion',/g;

describe('the room has one construction site for a promotion', () => {
  it('creates a promotion item exactly once', () => {
    expect(room.match(CONSTRUCTION) ?? []).toHaveLength(1);
  });

  it('and that site is inside the `context.promoted` branch', () => {
    // Positional, which is crude and is the point: the construction has to sit after the branch
    // that tests the event type and before the next branch. A promotion built anywhere else in this
    // reducer would move out of that window.
    const branch = room.indexOf("ev.event_type === 'context.promoted'");
    const site = room.search(/kind:\s*'promotion',/);
    const nextBranch = room.indexOf('} else if (ev.event_type ===', branch + 1);
    expect(branch, 'the `context.promoted` branch is gone').toBeGreaterThan(-1);
    expect(nextBranch, 'no branch follows — the window is unbounded').toBeGreaterThan(branch);
    expect(site).toBeGreaterThan(branch);
    expect(site).toBeLessThan(nextBranch);
  });

  it('every field the row shows is read off the event payload', () => {
    // No derived fields, no defaults, no `??` fallback inventing a purpose or an approver. A room
    // that can describe a disclosure differently from the way it was recorded is a room whose
    // transcript is not the record.
    for (const field of [
      'promotion_id',
      'source_principal',
      'representation',
      'purpose',
      'approved_by',
      'content',
    ]) {
      expect(room, `${field} is not read from the payload`).toContain(
        `${field}: ev.payload.${field}`,
      );
    }
  });
});

describe('the component cannot be given a promotion that did not happen', () => {
  it('takes exactly two props — the view from the log, and the roster', () => {
    // A third prop is how a fixture gets in. The roster is a lookup for names, not a source of
    // content: nothing about the disclosure comes from it.
    const props = component.match(/^}: \{$[\s\S]*?^}\)/m)?.[0] ?? '';
    expect(props).toContain('promotion: PromotionItemView');
    expect(props).toContain('roster: Map<string, RosterMember>');
    expect(props.match(/^\s{2}\w+[?]?:/gm) ?? []).toHaveLength(2);
  });

  it('has no default for any field of the view', () => {
    // `?? ''` on a purpose would render a disclosure with no stated reason as though it had one.
    // The one `??` this component is allowed is on the WORDING of `representation`, which falls
    // back to the raw value rather than to a friendlier lie.
    const fallbacks = component.match(/\?\?/g) ?? [];
    expect(fallbacks).toHaveLength(1);
    expect(component).toContain('REPRESENTATION_WORDS[promotion.representation] ??');
  });
});

describe('§5.2 — it is visually distinct, and the text stays text', () => {
  it('renders no principal accent', () => {
    // An accent answers "whose authority does this carry". A promotion carries none: it is a record
    // that something was shared, not somebody acting. Every other row that names a member sets
    // `data-accent`; this one must not — asserted on the code, not the comments.
    expect(code).not.toContain('data-accent');
    expect(code).not.toContain('accent');
    // And the stylesheet does not reintroduce one through the class.
    const block = css.slice(css.indexOf('.promotion {'));
    expect(block.slice(0, block.indexOf('}'))).not.toContain('accent');
  });

  it('is not built out of the message or turn classes', () => {
    // The distinctness has to be structural rather than a tweak to a shared class, or the next
    // restyle of `.msg-body` silently restyles a disclosure.
    expect(code).not.toContain('msg-body');
    expect(code).not.toContain('turn-body');
    expect(code).not.toContain('turn-head');
    expect(code).toContain('className="promotion"');
  });

  it('preserves whitespace and parses no markup — A4-F8, §13', () => {
    // This is the one surface in the room carrying text from OUTSIDE the room, so it is the last
    // place to begin interpreting markup. Asserted on the stylesheet because that is where the
    // property lives; `pre-wrap` is what makes rendering-as-text legible rather than mangled.
    const block = css.slice(css.indexOf('.promotion-body {'));
    expect(css).toContain('.promotion-body {');
    expect(block.slice(0, block.indexOf('}'))).toContain('white-space: pre-wrap');
    // And nothing renders it as HTML.
    expect(component).not.toContain('dangerouslySetInnerHTML');
  });
});
