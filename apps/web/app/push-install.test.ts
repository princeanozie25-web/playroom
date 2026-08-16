import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * ═══ SPUSH-N2 — ON iOS, A TAB IS NOT REACHABLE, AND THE CONTROL MUST SAY SO ═══
 *
 * SP-4's notification was observed on an iPhone with the app installed to the Home Screen. iOS
 * delivers Web Push ONLY to an installed web app — in a Safari tab a person can turn the control on,
 * read "on · 1 device", and never be woken. That constraint was recorded in the claims sheet and
 * existed nowhere in the product, so its trigger was always going to be the first tester who is not
 * Prince.
 *
 * ── WHAT IS ASSERTED, AND WHY IT IS NOT A SNAPSHOT ───────────────────────────────────
 *
 * A snapshot of the rendered string would pass for the wrong reason the moment someone reworded the
 * copy, and would say nothing about WHEN it is shown. What is asserted here is the CONDITION: that
 * the state exists, that it is decided from display-mode and platform rather than guessed, that it is
 * checked BEFORE the capability check, and that it carries the instruction. There is no DOM here —
 * the same limit `disabled-control.test.ts` and `hooks.test.ts` state, for the same dependency
 * reason — so the mechanism is proven from the source.
 */

const control = readFileSync(resolve(import.meta.dirname, 'PushControl.tsx'), 'utf8');
const strip = (t: string): string =>
  t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const code = strip(control);

describe('the control distinguishes an iOS tab from an installed app', () => {
  it('decides from display-mode AND platform — not from a user-agent guess alone', () => {
    // BOTH standard and iOS-specific display checks, because either being true means installed.
    expect(code).toContain("matchMedia?.('(display-mode: standalone)')");
    expect(code).toContain('standalone === true');
    // Narrowed to Apple touch platforms: desktop Safari DOES deliver push to a tab, and warning
    // there would be a lie in the other direction.
    expect(code).toMatch(/iPad\|iPhone\|iPod/);
    expect(code).toContain('maxTouchPoints');
    // An installed app is never warned.
    expect(code).toMatch(/if \(standalone\) return false;/);
  });

  it('is checked BEFORE the capability check, because a tab can pass that one', () => {
    const install = code.indexOf('iosNeedsInstalling()');
    const supported = code.indexOf('if (!supported) return setState');
    expect(install).toBeGreaterThan(-1);
    expect(supported).toBeGreaterThan(-1);
    // In a tab iOS may report serviceWorker/PushManager/Notification as present, so ordering is the
    // whole mechanism: a person must not pass every other check and still be unreachable.
    expect(install).toBeLessThan(supported);
  });

  it('says what to do about it, not merely that something is wrong', () => {
    const block = code.slice(code.indexOf("state.kind === 'needs-install'"));
    // Whitespace-normalised: the formatter wraps JSX text at the print width, so "Add to Home
    // Screen" is one phrase to a reader and two lines in the file. Matching the raw source would
    // make this test fail on a reflow and pass on a reworded sentence — exactly backwards.
    const shown = block.slice(0, block.indexOf('</span>')).replace(/\s+/g, ' ');
    // The instruction, not a diagnosis: the two words a person has to find on their own phone.
    expect(shown).toMatch(/Add to Home Screen/i);
    expect(shown).toMatch(/Share/i);
    // And it names the platform it applies to, so a reader on any other device knows it is not them.
    expect(shown).toMatch(/iPhone/i);
  });

  it('the state is part of the union, so an unhandled case cannot compile away silently', () => {
    expect(code).toContain("| { kind: 'needs-install' }");
    // It is a DISTINCT state rather than a reuse of `unsupported`: the browser is capable, the
    // context is not, and the fixes are different sentences.
    expect(code).toContain("state.kind === 'unsupported'");
    expect(code).toContain("state.kind === 'needs-install'");
  });
});
