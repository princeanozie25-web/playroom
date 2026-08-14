import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// A RAISED HAND IS VISIBLE IN THE ROOM, BY THE SAME PATH AS EVERY OTHER CLAIM (SL2-3).
//
// SCC-3 gave a connected member a way to ask for attention without requesting a protected action:
// a bare hand, `about_kind` 'hand'. The question this file answers is narrow and worth asserting —
// does a hand actually SHOW, or did it get a new about_kind the surface silently ignores?
//
// It shows because the surface never looks at about_kind: an interrupt chip is built from
// `interrupt.raised` and keyed on URGENCY, so a hand is rendered by the same branch that renders an
// order's DECISION. That is a property of the code, so it is asserted against the code.
//
// Source-level, like briefing.test.ts and for the same reason (no DOM here — see hooks.test.ts). It
// proves the room CONSTRUCTS the row; it does not prove the row reached a screen. The 390px capture
// is the other half and is still outstanding (S17-N4), and what a chip in the room CANNOT do —
// reach a phone whose room is closed — is SL2-N4 on the claims sheet, not a claim made here.

const APP = resolve(import.meta.dirname);
const room = readFileSync(resolve(APP, 'r/[id]/Room.tsx'), 'utf8');
const chip = readFileSync(resolve(APP, 'InterruptChip.tsx'), 'utf8');
const code = chip.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('a hand is an interrupt, and the room renders interrupts', () => {
  it('builds an interrupt item from `interrupt.raised`, and from nothing else', () => {
    expect(room.match(/kind: 'interrupt',/g) ?? []).toHaveLength(1);
    const branch = room.indexOf("ev.event_type === 'interrupt.raised'");
    const site = room.indexOf("kind: 'interrupt',", branch);
    expect(branch, 'the interrupt.raised branch is gone').toBeGreaterThan(-1);
    expect(site).toBeGreaterThan(branch);
    // And there is a render branch for it in the item list, not just a built item nobody draws.
    expect(room).toContain("it.kind === 'interrupt'");
  });

  it('never reads `about_kind`, so a bare hand cannot be a kind the surface skips', () => {
    // This is the whole claim. SCC-3 added a new about_kind; if either the view or the chip
    // switched on it, adding 'hand' would have needed a matching branch and its absence would
    // have rendered nothing at all.
    expect(chip).not.toContain('about_kind');
    const view = room.slice(room.indexOf("ev.event_type === 'interrupt.raised'"));
    expect(view.slice(0, view.indexOf('} else if'))).not.toContain('about_kind');
  });

  it('reads as a claim on a person, keyed on urgency — including the blocking one', () => {
    for (const urgency of ['BLOCKER', 'DECISION', 'FYI']) {
      expect(code, `${urgency} has no words a person would read`).toContain(urgency);
    }
    // Only the member a claim is addressed to may lower it, and an FYI is not lowerable at all.
    expect(code).toContain('viewer === interrupt.addressed_to');
    expect(code).toContain("interrupt.urgency !== 'FYI'");
  });
});
