import { describe, expect, it } from 'vitest';
import { startTestServer } from './support.js';

/**
 * ═══ SLIVE-N1 — POST /redeem is throttled per IP, before any code goes out ═══
 *
 * The only unauthenticated write, and a 4-character code is ~810k possibilities — off localhost, a
 * script could grind through them. The throttle is the "before any code goes out" floor: it lets a
 * real tester redeem (once, maybe a retry) while making a brute-force take lifetimes per address.
 * Asserted as behaviour, with a low limit injected so the test drives it without a real deployment.
 *
 * The throttle is checked BEFORE the code is, so a throttled attempt is a 429 that learns nothing more
 * than a wrong code's 404 — the limit cannot be turned into its own oracle. And it is PER IP: a
 * different address is unaffected, so one abuser cannot lock every tester out.
 */

function redeem(base: string, ip: string) {
  return fetch(`${base}/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ code: 'ZZZZ', display_name: 'nobody' }), // a wrong code — 404 until throttled
  });
}

describe('SLIVE-N1: the /redeem throttle', () => {
  it('throttles one IP to 429 after its budget, and leaves another IP alone', async () => {
    const server = await startTestServer({ redeemRateMax: 3 });
    try {
      const abuser = '198.51.100.5';
      // The first three attempts are within budget — a wrong code is a 404, unthrottled.
      for (let i = 0; i < 3; i += 1) {
        expect((await redeem(server.httpBase, abuser)).status).toBe(404);
      }
      // The fourth crosses the limit → 429, and it is a 429 that reveals nothing about the code.
      expect((await redeem(server.httpBase, abuser)).status).toBe(429);

      // A DIFFERENT address is untouched — the limit is per IP, not a global gate a single abuser
      // could slam shut on every tester at once.
      expect((await redeem(server.httpBase, '203.0.113.9')).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
