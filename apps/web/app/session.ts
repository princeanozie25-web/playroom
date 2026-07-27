import { cookies } from 'next/headers';

/**
 * WHERE A TESTER'S CREDENTIAL LIVES — an httpOnly cookie, and nothing else (S-LIVE).
 *
 * ── WHY A COOKIE AND NOT A SESSIONS TABLE ──
 *
 * The BFF has to authenticate to the api on this person's behalf, which means it needs their token
 * on every request. A `sessions` table mapping an opaque id to a credential would have to store the
 * token in PLAINTEXT to do that — `member_credentials` deliberately keeps only a hash, and a second
 * table holding the readable version would undo that on the first bad backup.
 *
 * So the token stays in the one place that can hold a secret without the database holding it: the
 * browser's cookie jar, `httpOnly` so no script can read it, `sameSite=lax` so it does not travel to
 * other origins, `secure` off localhost.
 *
 * ── AND WHY THIS DOES NOT REOPEN S13-N3 ──
 *
 * S13-N3 was two specific faces: the credential in a WebSocket URL, and the page HTML shipping the
 * server's own long-lived credential to every browser. Neither returns. This token is not in a URL,
 * not in the page, and not reachable from JavaScript; it is a per-person, expiring credential that
 * the person's own redemption created. The socket still gets a single-use ticket and nothing else.
 *
 * The honest difference from before: the browser now holds A credential where previously it held
 * none, and every act it authenticates is attributed to that person rather than to me.
 */

const COOKIE = 'playroom_member';

/** Read the viewer's credential, if they have redeemed one. Server-side only. */
export async function sessionToken(): Promise<string | undefined> {
  const jar = await cookies();
  return jar.get(COOKIE)?.value;
}

/**
 * The credential the BFF should authenticate with, and WHO it belongs to.
 *
 * A REDEEMED SESSION WINS OVER THE DEPLOYMENT'S OWN TOKEN, always. `PLAYROOM_WEB_TOKEN` is mine —
 * it acts as `prince` — so if the fallback took precedence, or applied when a session existed, a
 * tester's acts would be recorded as MINE. That is not a degraded experience; it is the audit log
 * telling a lie, and attribution is the product.
 *
 * The fallback stays because the capture harness and my own browser depend on it, and because a
 * deployment with no testers yet should still open.
 */
export async function viewerCredential(): Promise<
  { token: string; source: 'session' | 'deployment' } | undefined
> {
  const session = await sessionToken();
  if (session) return { token: session, source: 'session' };
  const deployment = process.env.PLAYROOM_WEB_TOKEN;
  return deployment ? { token: deployment, source: 'deployment' } : undefined;
}

/** Cookie options for a credential that expires when the credential does. */
export function cookieOptions(expiresAt: string | null): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge?: number;
} {
  // MAX-AGE FROM THE CREDENTIAL, not a constant. A cookie outliving its credential is a browser
  // that looks signed in and cannot connect — the failure mode is a person staring at a room that
  // will not open, with nothing on screen explaining why.
  const maxAge = expiresAt
    ? Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000))
    : undefined;
  return {
    httpOnly: true,
    sameSite: 'lax',
    // `secure` would make the cookie undeliverable over plain http, which is what a phone on the
    // local network gets today with no deployment. Keyed off the runtime rather than hardcoded so
    // it turns itself on the moment this is served over HTTPS.
    secure: process.env.NODE_ENV === 'production' && process.env.PLAYROOM_INSECURE_COOKIES !== '1',
    path: '/',
    ...(maxAge === undefined ? {} : { maxAge }),
  };
}

export const SESSION_COOKIE = COOKIE;
