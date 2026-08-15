import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ERROR_PUSH_MALFORMED, ERROR_PUSH_NOT_HUMAN } from '@playroom/shared';
import { issueTestCredential, startTestServer, testPool, type TestServer } from './support.js';
import { countFor, deleteSubscription, subscriptionsFor, upsertSubscription } from '../src/push.js';

/**
 * ═══ S-PUSH — WHOSE PHONE, AND WHO MAY SAY SO (SP-1) ═══
 *
 * A subscription is an address for a PERSON's attention. The rules it has to carry are the ones
 * every other authority record here carries, and for the same reasons:
 *
 *   · it belongs to a HUMAN PRINCIPAL — one person, several browsers, several rows
 *   · an AGENT has no path to one, refused by KIND (the self-authorisation rule)
 *   · no principal can register or read another's — not "is refused", but HAS NOWHERE TO ASK
 *   · OFF DELETES the row, because a control that leaves the address behind lies about itself
 *   · key material never comes back out of this server
 */

const pool = testPool();
let server: TestServer | undefined;
const LABEL = 'sp1-push';

/** A synthetic endpoint on a real vendor origin — no browser is involved in these tests. */
const endpointFor = (n: number) =>
  `https://fcm.googleapis.com/fcm/send/sp1-test-${n}-${Date.now()}`;

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
  await pool.query("DELETE FROM push_subscriptions WHERE endpoint LIKE '%sp1-test-%'");
  await pool.query(`DELETE FROM member_credentials WHERE label = '${LABEL}'`);
});
afterAll(async () => {
  await pool.end();
});

async function post(base: string, path: string, token: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe('a subscription belongs to a human principal', () => {
  it('registers under the CALLER’s principal — there is no field for anyone else’s', async () => {
    server = await startTestServer();
    const token = await issueTestCredential('prince', LABEL);
    const endpoint = endpointFor(1);

    const res = await post(server.httpBase, '/push/subscriptions', token, {
      endpoint,
      keys: { p256dh: 'BPtestp256dhvalue', auth: 'authsecretvalue' },
      // A CLAIM IN THE BODY, IGNORED BY CONSTRUCTION. There is no `principal_id` parameter on the
      // route; this rides along and reaches nothing. The row below proves which one was used.
      principal_id: 'principal:jerry',
    });
    expect(res.status).toBe(201);

    const { rows } = await pool.query<{ principal_id: string; created_by_member: string }>(
      'SELECT principal_id, created_by_member FROM push_subscriptions WHERE endpoint = $1',
      [endpoint],
    );
    expect(rows).toHaveLength(1);
    // The AUTHENTICATED credential's principal, not the one the body asked for.
    expect(rows[0].principal_id).toBe('principal:prince');
    // And the seat that registered it, kept as provenance rather than as authority.
    expect(rows[0].created_by_member).toBe('prince');
  });

  it('one person, several browsers, several rows — and a re-subscribe UPDATES rather than duplicates', async () => {
    const a = endpointFor(2);
    const b = endpointFor(3);
    await upsertSubscription(pool, {
      principalId: 'principal:prince',
      memberId: 'prince',
      endpoint: a,
      p256dh: 'k1',
      auth: 's1',
    });
    await upsertSubscription(pool, {
      principalId: 'principal:prince',
      memberId: 'prince',
      endpoint: b,
      p256dh: 'k2',
      auth: 's2',
    });
    expect(await countFor(pool, 'principal:prince')).toBe(2);

    // The same browser, re-granted: same endpoint, fresh keys. One row, not three.
    await upsertSubscription(pool, {
      principalId: 'principal:prince',
      memberId: 'prince',
      endpoint: a,
      p256dh: 'k1-rotated',
      auth: 's1-rotated',
    });
    expect(await countFor(pool, 'principal:prince')).toBe(2);
    const subs = await subscriptionsFor(pool, 'principal:prince');
    expect(subs.find((s) => s.endpoint === a)?.p256dh).toBe('k1-rotated');
  });

  it('cannot read or delete another principal’s address, even knowing its endpoint', async () => {
    const mine = endpointFor(4);
    await upsertSubscription(pool, {
      principalId: 'principal:jerry',
      memberId: 'jerry',
      endpoint: mine,
      p256dh: 'k',
      auth: 's',
    });

    // Reading is scoped by argument, and the argument is the caller's own principal at the route.
    expect(await subscriptionsFor(pool, 'principal:prince')).toHaveLength(0);
    // Deleting with the right endpoint and the wrong principal removes nothing.
    expect(await deleteSubscription(pool, 'principal:prince', mine)).toBe(false);
    expect(await countFor(pool, 'principal:jerry')).toBe(1);
    // ...and the owner can.
    expect(await deleteSubscription(pool, 'principal:jerry', mine)).toBe(true);
    expect(await countFor(pool, 'principal:jerry')).toBe(0);
  });
});

describe('an agent has no path to a notification address', () => {
  it('refuses an agent credential by KIND, and writes nothing', async () => {
    server = await startTestServer();
    const token = await issueTestCredential('claude-main', LABEL);
    const endpoint = endpointFor(5);

    const res = await post(server.httpBase, '/push/subscriptions', token, {
      endpoint,
      keys: { p256dh: 'k', auth: 's' },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(ERROR_PUSH_NOT_HUMAN);

    const { rows } = await pool.query('SELECT id FROM push_subscriptions WHERE endpoint = $1', [
      endpoint,
    ]);
    expect(rows, 'an agent registered a device').toHaveLength(0);
  });

  it('refuses an agent READING the count too — not just writing', async () => {
    server = await startTestServer();
    const token = await issueTestCredential('claude-main', LABEL);
    const res = await fetch(`${server.httpBase}/push/subscriptions`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(ERROR_PUSH_NOT_HUMAN);
  });
});

describe('the shape is checked, and the refusal never echoes what arrived', () => {
  it('refuses a body with no endpoint or no keys, by name', async () => {
    server = await startTestServer();
    const token = await issueTestCredential('prince', LABEL);
    // DISTINCTIVE values, not 'k' and 's': the first version of this test asserted the message did
    // not contain "k", which the word "keys" fails for reasons that have nothing to do with secrets.
    for (const body of [
      { keys: { p256dh: 'SECRET-P256DH-A', auth: 'SECRET-AUTH-A' } },
      { endpoint: endpointFor(6) },
      { endpoint: endpointFor(7), keys: { p256dh: 'SECRET-P256DH-B' } },
    ]) {
      const res = await post(server.httpBase, '/push/subscriptions', token, body);
      expect(res.status).toBe(400);
      const payload = (await res.json()) as { code: string; message: string };
      expect(payload.code).toBe(ERROR_PUSH_MALFORMED);
      // THE REFUSAL CARRIES NO KEY MATERIAL. A malformed body may still contain a real secret, and
      // a message that quotes what it received puts that secret in a log.
      expect(payload.message).not.toContain('SECRET-');
      expect(payload.message).not.toContain('fcm.googleapis.com');
    }
  });

  it('no route returns key material — the read answers with a count', async () => {
    server = await startTestServer();
    const token = await issueTestCredential('prince', LABEL);
    await upsertSubscription(pool, {
      principalId: 'principal:prince',
      memberId: 'prince',
      endpoint: endpointFor(8),
      p256dh: 'SECRET-P256DH-VALUE',
      auth: 'SECRET-AUTH-VALUE',
    });
    const res = await fetch(`${server.httpBase}/push/subscriptions`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain('SECRET-P256DH-VALUE');
    expect(text).not.toContain('SECRET-AUTH-VALUE');
    expect(text).not.toContain('fcm.googleapis.com'); // not even the address comes back out
    expect(JSON.parse(text)).toEqual({ devices: 1 });
  });
});

/**
 * THE CLIENT HALF, ASSERTED AT SOURCE — there is no DOM here (see hooks.test.ts), so these read the
 * code the way briefing.test.ts and raised-hand.test.ts do. What they hold is the promise the brief
 * made: the prompt is asked for and not sprung, and OFF actually deletes.
 */
describe('the control asks, and its off deletes', () => {
  const APP = resolve(import.meta.dirname, '..', '..', 'web', 'app');
  // COMMENTS STRIPPED, the briefing.test.ts precedent: an assertion about the CODE must not be
  // satisfiable or breakable by prose that happens to explain the very thing being asserted. The
  // first version of this test counted the word in its own explanatory comment.
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const control = strip(readFileSync(resolve(APP, 'PushControl.tsx'), 'utf8'));
  const sw = strip(readFileSync(resolve(APP, '..', 'public', 'sw.js'), 'utf8'));

  it('never requests permission except inside the click handler', () => {
    // One call site, and it is in turnOn — not in an effect, not at module scope. A prompt on load
    // is dismissed by reflex, and on some platforms that dismissal is permanent.
    expect(control.match(/requestPermission/g) ?? []).toHaveLength(1);
    const turnOn = control.slice(control.indexOf('const turnOn'), control.indexOf('const turnOff'));
    expect(turnOn).toContain('requestPermission');
    const effect = control.slice(control.indexOf('useEffect('), control.indexOf('const turnOn'));
    expect(effect).not.toContain('requestPermission');
  });

  it('turning off deletes the row before it unsubscribes the browser', () => {
    const turnOff = control.slice(control.indexOf('const turnOff'));
    const del = turnOff.indexOf('/api/push/unsubscribe');
    const unsub = turnOff.indexOf('sub.unsubscribe()');
    expect(del).toBeGreaterThan(-1);
    expect(unsub).toBeGreaterThan(-1);
    // Server first: a row that survives a browser-side unsubscribe is an address nothing will ever
    // tell us is dead.
    expect(del).toBeLessThan(unsub);
  });

  it('the service worker takes no control of the network, and reads only the three fields', () => {
    // No fetch handler: a room that renders from a cache is a room that can show a briefing, a
    // decision or a spend figure that is no longer true.
    expect(sw).not.toContain("addEventListener('fetch'");
    expect(sw).not.toContain('caches');
    // The payload contract, at the only place that parses it.
    expect(sw).toContain('payload.room');
    expect(sw).toContain('payload.urgency');
    expect(sw).toContain('payload.at');
    for (const forbidden of ['summary', 'body_text', 'briefing', 'mandate', 'message']) {
      expect(sw, `the worker reads "${forbidden}" out of a payload`).not.toContain(
        `payload.${forbidden}`,
      );
    }
  });
});
