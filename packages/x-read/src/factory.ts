import { MockXSource } from './mock.js';
import { TwitterApiIoSource } from './twitterapiio.js';
import { XReadError, type XReadSource } from './source.js';

// @playroom/x-read — the backend factory: the ONE place a backend is chosen, mirroring the model adapters'
// `createAdapter`. A caller asks for a source and names nothing provider-specific; the environment decides
// which backend answers, and the credential is read HERE and handed to the source — never by the caller.

export const X_READ_BACKENDS = ['mock', 'twitterapi.io'] as const;
export type XReadBackend = (typeof X_READ_BACKENDS)[number];

/**
 * Build the X read source the environment selects.
 *   - `X_READ_BACKEND` picks the backend (default `mock`).
 *   - `mock` — deterministic, no credential, no network (CI + offline demo).
 *   - `twitterapi.io` — the managed read API; reads `X_READ_TWITTERAPIIO_KEY`. Absent key → `not_configured`,
 *     so a misconfiguration fails loudly at construction rather than on the first read.
 */
export function createXReadSource(
  env: Record<string, string | undefined> = process.env,
): XReadSource {
  const backend = env.X_READ_BACKEND ?? 'mock';
  switch (backend) {
    case 'mock':
      return new MockXSource();
    case 'twitterapi.io': {
      const apiKey = env.X_READ_TWITTERAPIIO_KEY;
      if (!apiKey) {
        throw new XReadError(
          'not_configured',
          'X_READ_BACKEND=twitterapi.io but X_READ_TWITTERAPIIO_KEY is unset',
        );
      }
      return new TwitterApiIoSource({ apiKey });
    }
    default:
      throw new XReadError('not_configured', `unknown X_READ_BACKEND: ${backend}`);
  }
}
