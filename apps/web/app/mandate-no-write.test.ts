import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// ═══ UI3-3c — THE MANDATE SURFACE HAS NO WRITE PATH, PROVEN BY CONSTRUCTION ═══
//
// The trap this must not fall into: a test that renders the surface and then asserts "the mandate did
// not change" passes exactly as well when the guard held as when the test never tried to change
// anything — proof of an outcome, which is no proof at all. So this asserts the MECHANISM: there is
// nothing here that COULD change a mandate. Two independent halves, and both must hold:
//
//   1. the component carries no affordance to call a mutation (no handler, no state, no request), and
//   2. no mutation endpoint exists for such a call to reach — not in the web BFF, not in the api.
//
// Files are read from the repo (vitest's cwd is the repo root), so this is a statement about the source
// that ships, not about a render that happened to leave state alone.

const ROOT = process.cwd();

describe('the mandate surface cannot change a mandate — by construction', () => {
  it('MandateSurface holds no handler, no client state, and no mutating call', () => {
    const src = readFileSync(resolve(ROOT, 'apps/web/app/MandateSurface.tsx'), 'utf8');
    const forbidden: Array<[RegExp, string]> = [
      [/\son[A-Z][a-zA-Z]*\s*=/, 'a JSX event handler (onClick/onChange/…)'],
      [/\bfetch\s*\(/, 'a fetch call'],
      [/\buseState\b|\buseReducer\b|\buseEffect\b/, 'client state or effects'],
      [/\bmutate\b/, 'a mutate() call'],
      [/method\s*:\s*['"`](POST|PUT|PATCH|DELETE)/i, 'a mutating HTTP method'],
      [/'use client'|"use client"/, 'a client-component directive (it needs none)'],
    ];
    for (const [re, what] of forbidden) {
      expect(src, `MandateSurface must not contain ${what}`).not.toMatch(re);
    }
  });

  it('no BFF route exists that a mutation could reach — denominator stated', () => {
    // Walk the web tier's route handlers. A mandate-mutation endpoint would be a route whose PATH names
    // a mandate (app/api/…/mandate/route.ts) — there is none — and none of the routes that DO exist
    // issues a mutating request about a mandate. The count is asserted first so an empty walk (which
    // would make every "none found" vacuously true) fails loudly instead.
    const routes = routeFiles(resolve(ROOT, 'apps/web/app/api'));
    expect(
      routes.length,
      'expected the BFF to have routes — an empty walk proves nothing',
    ).toBeGreaterThan(3);
    for (const file of routes) {
      const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/');
      expect(rel.toLowerCase(), `route path ${rel} must not name a mandate`).not.toContain(
        'mandate',
      );
      const src = readFileSync(file, 'utf8');
      const mutatesAMandate =
        /mandate/i.test(src) && /method\s*:\s*['"`](POST|PUT|PATCH|DELETE)/i.test(src);
      expect(mutatesAMandate, `route ${rel} must not mutate a mandate`).toBe(false);
    }
  });

  it('the api registers no route whose path names a mandate — mutating or otherwise', () => {
    // The other end of the wire. Mandates are code (Bible §9.5): loaded from files, cached, changed by
    // deploy. The api therefore exposes no mandate resource at all, so there is nothing for a future
    // handler to POST to. Asserted against the source that registers every route.
    const server = readFileSync(resolve(ROOT, 'apps/api/src/server.ts'), 'utf8');
    const mandateRoute = /fastify\.(get|post|put|patch|delete)\(\s*['"`][^'"`]*mandate/i;
    expect(server, 'the api must register no mandate route').not.toMatch(mandateRoute);
  });
});

/** Every `route.ts`/`route.tsx` under a directory, recursively. */
function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFiles(p));
    else if (entry.name === 'route.ts' || entry.name === 'route.tsx') out.push(p);
  }
  return out;
}
