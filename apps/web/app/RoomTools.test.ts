import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RoomTools } from './RoomTools';

/**
 * SOURCE-LEVEL, by the same constraint hooks.test.ts states: this repo's vitest cannot RENDER a
 * component (classic JSX runtime, no `import React`), so the wiring is proven by reading the source and
 * by the type checker, not by a DOM. What these assert — the right frames, with the right fields — is
 * what makes the tool a real surface rather than a form that posts nothing.
 */
const SRC = readFileSync(resolve(import.meta.dirname, 'RoomTools.tsx'), 'utf8');

describe('RoomTools wires the room surface to the wire', () => {
  it('sends a briefing_set frame carrying content and purpose', () => {
    expect(SRC).toContain("type: 'briefing_set'");
    expect(SRC).toMatch(/content:\s*brief\.content/);
    expect(SRC).toMatch(/purpose:\s*brief\.purpose/);
  });

  it('sends a document_upload frame carrying every field the command needs', () => {
    expect(SRC).toContain("type: 'document_upload'");
    for (const field of ['title:', 'purpose:', 'provenance:', 'declared_type:', 'content:']) {
      expect(SRC, `document_upload is missing ${field}`).toContain(field);
    }
  });

  it('clears a stale refusal before each submit — a prior error never lingers over a new try', () => {
    // onClear() is called at the top of BOTH submit handlers (briefing and document).
    expect((SRC.match(/onClear\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('accepts the props the room passes it (checked by the type checker, not rendered)', () => {
    // Builds the element; never renders it — the body would need the automatic JSX runtime this config
    // lacks. The value is the TYPE check: a required prop removed or retyped fails tsc -b, which
    // apps/web is under. createElement does not call the component body, so this is render-safe.
    const el = createElement(RoomTools, { send: () => {}, refusal: null, onClear: () => {} });
    expect(el.type).toBe(RoomTools);
  });
});
