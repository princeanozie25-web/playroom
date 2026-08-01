import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ═══ SHELL-B2 — MOTION EXISTS, AND REDUCED-MOTION ACTUALLY SUPPRESSES IT ═══
//
// The trap this must not fall into, named in the brief: a test proving "no animation ran" passes
// equally when the reduce query worked and when nothing was animated in the first place. So this
// asserts BOTH halves of the mechanism, each with its denominator:
//
//   1. MOTION EXISTS — the sheet declares a non-zero, counted set of animations and transitions.
//      If the motion layer is ever deleted, this half fails: there would be nothing to suppress.
//   2. THE KILL DOMINATES BY CASCADE ARITHMETIC — the reduce block is universal (*, ::before,
//      ::after) and !important for BOTH `animation` and `transition`, and every motion declaration
//      outside it is NON-important. In CSS, an !important declaration on any selector beats a
//      non-important declaration on any other, regardless of specificity or order — so suppression
//      is a property of the arithmetic, not of an enumeration someone must remember to extend.
//
// Source-level, like every web test here (no jsdom — a dependency this slice may not add beyond the
// one it names). What this cannot see: a browser actually applying the media query. What it proves:
// the one stylesheet ships motion, and ships exactly one mechanism that suppresses all of it.

const css = readFileSync(resolve(import.meta.dirname, 'globals.css'), 'utf8');

// The reduce block, extracted once. Everything outside it is "the motion set".
const REDUCE_RE = /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/;
const reduceBlock = css.match(REDUCE_RE)?.[0] ?? '';
const outside = css.replace(REDUCE_RE, '');
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');
const sheet = stripComments(outside);

describe('half 1 — motion exists, counted (there is something to suppress)', () => {
  const animations = sheet.match(/^\s*animation:.*$/gm) ?? [];
  const transitions = sheet.match(/^\s*transition:[\s\S]*?;/gm) ?? [];
  const keyframes = sheet.match(/@keyframes ([a-z-]+)/g) ?? [];

  it('declares the animations of SHELL-B2 and the state indicators — denominator stated', () => {
    // 6 animation declarations: rise-in (item enter), pop-in (disclosure), settle (card resolve),
    // fade-in (spend footer), shimmer (caret), pulse (reconnecting dot). A count, not a >0, so a
    // silently dropped animation fails this rather than shrinking the set unnoticed.
    expect(animations).toHaveLength(6);
  });

  it('declares the transitions of SHELL-B2 — emphasis and in-place field updates', () => {
    // 4 transition declarations: control emphasising (one grouped rule), task dot, interrupt
    // urgency rule, order/loop status colour.
    expect(transitions).toHaveLength(4);
  });

  it('every @keyframes is used and every animation resolves to a defined @keyframes', () => {
    const defined = keyframes.map((k) => k.replace('@keyframes ', ''));
    expect(defined.length).toBeGreaterThan(0);
    for (const name of defined) {
      expect(sheet, `@keyframes ${name} is defined but never used`).toMatch(
        new RegExp(`animation:[^;]*\\b${name}\\b`),
      );
    }
    for (const a of animations) {
      const name = a.match(/animation:\s*([a-z-]+)/)?.[1];
      expect(defined, `animation "${name}" references undefined keyframes`).toContain(name);
    }
  });

  it('transitions and one-shot animations run at the design.md duration (var(--motion))', () => {
    // "150–200ms ease-out" — encoded once as --motion/--ease-out and used everywhere. The two
    // infinite state indicators (shimmer, pulse) are ongoing-state lamps, not transitions, and
    // legitimately run at their own period.
    for (const t of transitions) expect(t).toContain('var(--motion)');
    const oneShot = animations.filter((a) => !a.includes('infinite'));
    expect(oneShot.length).toBe(4);
    for (const a of oneShot) {
      expect(a).toContain('var(--motion)');
      expect(a).toContain('var(--ease-out)');
    }
  });

  it('animates only compositor properties and colours — never layout', () => {
    // SKILL.md's motion law ("don't animate CSS layout properties") checked against what each
    // transition names: only border-color, background-color and color appear.
    for (const t of transitions) {
      const props = [...t.matchAll(/([a-z-]+)\s+var\(--motion\)/g)].map((m) => m[1]);
      expect(props.length).toBeGreaterThan(0);
      for (const p of props) {
        expect(['border-color', 'background-color', 'color']).toContain(p);
      }
    }
  });
});

describe('half 2 — the reduce block dominates by cascade arithmetic', () => {
  it('exists, is universal, and kills BOTH properties with !important', () => {
    expect(reduceBlock, 'no prefers-reduced-motion block in the sheet').not.toBe('');
    expect(reduceBlock).toContain('*,');
    expect(reduceBlock).toContain('*::before');
    expect(reduceBlock).toContain('*::after');
    expect(reduceBlock).toMatch(/animation:\s*none\s*!important/);
    expect(reduceBlock).toMatch(/transition:\s*none\s*!important/);
  });

  it('no motion declaration outside it is !important — so the kill always wins', () => {
    // THE ARITHMETIC HALF. If any animation/transition outside the block were !important, the
    // universal reset would lose to it and "kills all of it" would be quietly false for that rule.
    const important = sheet.match(/^\s*(animation|transition):[^;]*!important/gm) ?? [];
    expect(important, `motion declared !important would survive reduce: ${important}`).toHaveLength(
      0,
    );
  });

  it('is the only reduced-motion block — one mechanism, not a scatter', () => {
    // The MEDIA QUERY, counted — comments quoting design.md's "prefers-reduced-motion kills all
    // of it" are prose, not mechanisms.
    expect(css.match(/@media \(prefers-reduced-motion/g)).toHaveLength(1);
  });
});
