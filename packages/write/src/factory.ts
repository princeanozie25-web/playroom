import { MockWriteBackend } from './mock.js';
import { WriteError, type WriteBackend } from './types.js';

/**
 * The backends the seam knows how to build. Only `mock` is IMPLEMENTED today: real backends (an X poster, a
 * GitHub commenter, an SMTP/API email sender) are credential-gated and land as their own, separately-reviewed
 * slices — each a distinct credential holder in this package, added to this factory the way x-read's factory
 * adds twitterapi.io. Naming them here (and failing loudly for the unbuilt ones) is the extension point.
 */
export const WRITE_BACKENDS = ['mock', 'x', 'github', 'email'] as const;
export type WriteBackendName = (typeof WRITE_BACKENDS)[number];

/**
 * Pick a write backend from the environment. Defaults to the Mock — so a deployment that has not deliberately
 * configured a real, credentialed writer performs nothing real, and a governed reply reaches "APPROVED, then
 * the mock recorded it" rather than an accidental post. Selecting an unbuilt real backend throws at
 * construction (not at first write), so a misconfiguration fails loudly.
 */
export function createWriteBackend(env: NodeJS.ProcessEnv = process.env): WriteBackend {
  const name = (env.WRITE_BACKEND ?? 'mock') as WriteBackendName;
  if (name === 'mock') return new MockWriteBackend();
  // The real backends are not built yet — a room that asks for one should fail to boot, not post through a
  // half-wired sender. Each will read its OWN credential env and live in its own file (ADR-020 follow-up).
  throw new WriteError(
    'not_configured',
    `write backend "${name}" is not implemented yet — only "mock" exists; real posters are a credential-gated follow-up`,
  );
}
