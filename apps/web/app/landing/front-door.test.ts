import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const component = readFileSync(resolve(import.meta.dirname, 'LandingPage.tsx'), 'utf8');
const themeToggle = readFileSync(resolve(import.meta.dirname, '..', 'ThemeToggle.tsx'), 'utf8');
const allCss = readFileSync(resolve(import.meta.dirname, '..', 'globals.css'), 'utf8');
const publicCss = allCss.split('/* ── PUBLIC LANDING')[1] ?? '';

function keyframeBlocks(css: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;
  while ((cursor = css.indexOf('@keyframes', cursor)) !== -1) {
    const start = cursor;
    const open = css.indexOf('{', start);
    if (open === -1) break;
    let depth = 1;
    cursor = open + 1;
    while (cursor < css.length && depth > 0) {
      if (css[cursor] === '{') depth += 1;
      if (css[cursor] === '}') depth -= 1;
      cursor += 1;
    }
    blocks.push(css.slice(start, cursor));
  }
  return blocks;
}

describe('Front Door product experience', () => {
  it('connects both real product actions throughout the landing page', () => {
    expect(component.match(/href="\/start"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(component.match(/href="\/join"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(component).not.toContain('Join the pilot');
  });

  it('labels local simulations and keeps roadmap work explicit', () => {
    expect(component).toContain('no request leaves this page');
    expect(component).toMatch(/No backend request or\s+production action is made/);
    expect(component).toContain('Planned, not claimed');
    // Roadmap names real planned work (now in visitor-facing outcome language, not changelog entries).
    expect(component).toContain('GitHub, email');
  });

  it('ships interactive trust stages, mandate verdicts, and theme persistence', () => {
    expect(component).toContain('role="tablist"');
    expect(component).toContain("verdict: 'ALLOW'");
    expect(component).toContain("verdict: 'CO_SIGN'");
    expect(component).toContain("verdict: 'BLOCK'");
    expect(component).toContain('ThemeToggle');
    expect(themeToggle).toContain("'playroom-landing-theme'");
  });

  it('keeps public animation compositor-only and governed by the universal kill switch', () => {
    expect(publicCss).toContain('@keyframes landing-page-enter');
    expect(publicCss).toContain('@keyframes landing-stage-in');
    for (const block of keyframeBlocks(publicCss)) {
      expect(block).not.toMatch(/\b(top|left|width|height):/);
    }
    expect(allCss.match(/@media \(prefers-reduced-motion/g)).toHaveLength(1);
    expect(allCss).toMatch(/animation:\s*none\s*!important/);
    expect(allCss).toMatch(/transition:\s*none\s*!important/);
  });
});
