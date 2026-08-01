import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ═══ SHELL-B3 — FRAMER MOTION: SCOPED, TRUTHFUL, AND KILLED BY REDUCED MOTION ═══
//
// Three mechanisms, each asserted with its denominator, none provable by "it looked fine":
//
//   1. SCOPE. The dependency lives in Chip.tsx and Panel.tsx and nowhere else. Surfaces that need
//      presence import <PanelPresence> from Panel — the framer import cannot spread by convenience,
//      because spreading it fails this test.
//   2. TRUTHFULNESS. Motion may animate only opacity, position (y) and size (layout) — never a
//      colour, background or border, because those channels ENCODE STATE, and a transition that
//      touched them could render a pending thing as settled. The resolved style exists only on the
//      resolved element, which renders only behind the event-derived `resolution`.
//   3. REDUCED MOTION. Both motion-bearing files gate every framer prop behind useReducedMotion():
//      the reduced branch is the EMPTY object — a plain element, not a faster animation.

const APP = resolve(import.meta.dirname);

function sources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      sources(p, acc);
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts')) {
      // Test files excluded: they are checks, not surfaces, and this file necessarily contains the
      // very strings it scans for (the hooks.test.ts precedent — a check satisfied by its own
      // example is no check).
      acc.push(p);
    }
  }
  return acc;
}

const files = sources(APP);
const read = (name: string): string => readFileSync(resolve(APP, name), 'utf8');
const chip = read('Chip.tsx');
const panel = read('Panel.tsx');
const decision = read('DecisionCard.tsx');
const room = read('r/[id]/Room.tsx');

describe('scope — framer-motion lives in Chip and Panel only', () => {
  it('exactly two files import it, out of every source file — denominator stated', () => {
    const importers = files
      .filter((f) => /from ['"]framer-motion['"]/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(APP.length + 1).replace(/\\/g, '/'))
      .sort();
    // The walk must have seen the whole app for "only" to mean anything.
    expect(files.length, 'expected the walk to cover the app').toBeGreaterThan(20);
    expect(importers).toEqual(['Chip.tsx', 'Panel.tsx']);
  });

  it('presence sites use PanelPresence from Panel, never AnimatePresence directly', () => {
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const name = f.slice(APP.length + 1).replace(/\\/g, '/');
      if (name === 'Panel.tsx') continue;
      expect(src, `${name} must not reach for AnimatePresence itself`).not.toContain(
        'AnimatePresence',
      );
    }
  });
});

describe('truthfulness — motion animates no state channel', () => {
  it('Panel and Chip animate only opacity, y and layout — the closed set', () => {
    // Every animation-target object literal in the two files, checked key by key. A colour or
    // background in a motion prop is how a transition starts lying about state.
    for (const [name, src] of [
      ['Panel.tsx', panel],
      ['Chip.tsx', chip],
    ] as const) {
      const targets = src.match(/\{ opacity[^}]*\}/g) ?? [];
      for (const t of targets) {
        const keys = [...t.matchAll(/([a-zA-Z-]+):/g)].map((m) => m[1]);
        for (const k of keys) {
          expect(['opacity', 'y'], `${name} animates forbidden channel "${k}"`).toContain(k);
        }
      }
      for (const forbidden of ['backgroundColor', 'borderColor', 'color:', 'background:']) {
        const motionSlice = src.slice(
          src.indexOf('motionProps') >= 0 ? src.indexOf('motionProps') : 0,
        );
        expect(motionSlice, `${name} must not animate ${forbidden}`).not.toContain(
          `animate: { ${forbidden}`,
        );
      }
    }
    // Chip has no enter/exit at all: layout only. An entering chip is the CSS rise-in's job.
    expect(chip).not.toContain('initial:');
    expect(chip).not.toContain('exit:');
  });

  it('both restate the design.md duration and curve (0.18s, the quint) — pinned', () => {
    for (const src of [panel, chip]) {
      expect(src).toContain('duration: 0.18');
      expect(src).toContain('0.22, 1, 0.36, 1');
    }
  });

  it('the resolved style renders only behind the event-derived resolution', () => {
    // The chain that makes "a pending card never transiently renders as resolved" a property of
    // the code rather than of timing: (a) the ONLY decision-resolved element sits inside the
    // `resolution ?` consequent, before the `: isSigner` alternative; (b) Room sets `resolution`
    // only in the decision.resolved reducer branch. Motion cannot conjure the style because no
    // motion prop carries a style channel (above) — the transition interpolates the pending
    // card's opacity, never its meaning.
    const resolvedUse = decision.indexOf('className="decision-resolved"');
    const branch = decision.indexOf('{resolution ? (');
    const alternative = decision.indexOf(': isSigner ? (');
    expect(decision.match(/decision-resolved/g), 'exactly one resolved element').toHaveLength(1);
    expect(branch, 'the resolution branch exists').toBeGreaterThan(-1);
    expect(resolvedUse).toBeGreaterThan(branch);
    expect(resolvedUse).toBeLessThan(alternative);

    const resolvedAssign = room.indexOf('view.resolution =');
    const resolvedBranch = room.indexOf("ev.event_type === 'decision.resolved'");
    const nextBranch = room.indexOf('} else if (ev.event_type ===', resolvedBranch + 1);
    expect(resolvedBranch, 'the decision.resolved branch exists').toBeGreaterThan(-1);
    expect(resolvedAssign).toBeGreaterThan(resolvedBranch);
    expect(resolvedAssign).toBeLessThan(nextBranch);
  });
});

describe('reduced motion — the gate, not the vibe', () => {
  it('both files call useReducedMotion and reduce to the EMPTY prop set', () => {
    for (const [name, src] of [
      ['Panel.tsx', panel],
      ['Chip.tsx', chip],
    ] as const) {
      expect(src, `${name} must import useReducedMotion`).toMatch(
        /import \{[^}]*useReducedMotion[^}]*\} from 'framer-motion'/,
      );
      expect(src, `${name} must call the hook`).toContain('useReducedMotion()');
      // The reduced branch is {} — a plain element with NO motion props, not a shorter animation.
      expect(src, `${name} must reduce to nothing`).toMatch(/reduce\s*\?\s*\{\}/);
    }
  });

  it('PanelPresence under reduced motion mounts/unmounts with no animation — and still unmounts', () => {
    // Suppressing the animation must never suppress the removal: the reduced branch bypasses
    // AnimatePresence entirely, so the child unmounts synchronously and completely.
    expect(panel).toMatch(/if \(reduce\) return show \? <>\{children\}<\/> : null;/);
  });
});
