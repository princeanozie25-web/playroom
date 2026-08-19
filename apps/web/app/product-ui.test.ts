import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const app = import.meta.dirname;
const read = (...parts: string[]) => readFileSync(resolve(app, ...parts), 'utf8');

describe('shared Playroom product UI', () => {
  it('offers the same persisted theme control across public and application routes', () => {
    expect(read('ThemeToggle.tsx')).toContain("'playroom-landing-theme'");
    expect(read('start', 'page.tsx')).toContain('<ThemeToggle');
    expect(read('join', 'page.tsx')).toContain('<ThemeToggle');
    expect(read('r', '[id]', 'Room.tsx')).toContain('<ThemeToggle');
    expect(read('r', '[id]', 'loops', 'LoopsScreen.tsx')).toContain('<ThemeToggle');
  });

  it('keeps the canonical room transcript semantically valid and labelled', () => {
    const room = read('r', '[id]', 'Room.tsx');
    expect(room).toMatch(/<li\s+ref=\{tailRef\}\s+className="transcript-tail"/);
    expect(room).not.toContain('<div ref={tailRef}');
    expect(room).toContain('role="list" aria-label="Room members"');
    expect(room).toContain('<label className="sr-only" htmlFor="room-message">');
  });

  it('gives room tools complete labels and requires a meaningful payload', () => {
    const tools = read('RoomTools.tsx');
    for (const label of ['Briefing', 'Title', 'Filename', 'Purpose', 'Document text']) {
      expect(tools).toContain(label);
    }
    expect(tools).toContain('required');
    expect(tools).toContain('disabled={!canSetBriefing}');
    expect(tools).toContain('disabled={!canGiveDocument}');
  });

  it('provides intentional dark, mobile, focus, and reduced-motion foundations', () => {
    const css = read('globals.css');
    expect(css).toContain("html[data-landing-theme='dark']");
    expect(css).toContain('@media (max-width: 700px)');
    expect(css).toContain('@media (max-width: 430px)');
    expect(css).toContain(':focus-visible');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('has product-specific recovery surfaces instead of framework defaults', () => {
    expect(read('not-found.tsx')).toContain('Route not found');
    expect(read('error.tsx')).toContain('Try again');
  });
});
