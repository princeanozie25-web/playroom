import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { testPool, uniqueRoomId } from './support.js';
import { createRoom } from '../src/events.js';
import { upsertSubscription } from '../src/push.js';
import {
  DISCLOSED_FIELDS,
  THROTTLE_PER_HOUR,
  allowedOrigins,
  notifyPrincipal,
  originOf,
  resetVapidForTests,
} from '../src/push-send.js';

/**
 * ═══ S-PUSH — THE EGRESS RECORD AND THE ALLOWLIST (SP-2) ═══
 *
 * This is Playroom's first non-provider egress: the server telling a third party the room does not
 * control that something happened here. The controls are the ones this repo already applies to spend
 * and authority — a record per send INCLUDING every refusal, a closed allowlist of vendors, a
 * throttle whose refusal is also a record, and a payload that discloses the minimum.
 *
 * Nothing here reaches a real vendor. The endpoints are synthetic and the sends fail at the network,
 * which is exactly the interesting case: a failure must still be a ROW.
 */

const pool = testPool();
const rooms: string[] = [];
let envBefore: Record<string, string | undefined> = {};

beforeEach(() => {
  envBefore = {
    pub: process.env.PLAYROOM_VAPID_PUBLIC_KEY,
    priv: process.env.PLAYROOM_VAPID_PRIVATE_KEY,
    origins: process.env.PLAYROOM_PUSH_ALLOWED_ORIGINS,
  };
  // A SYNTHETIC KEYPAIR, generated once for these tests and never a real one. Without keys the
  // sender is a no-op, which is its own case below.
  process.env.PLAYROOM_VAPID_PUBLIC_KEY =
    'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkFbx_1sBQXWyLnaLPRRHRSy_JVKrJnnkTKzWLZzYSlfLQzHl1JTZBg';
  process.env.PLAYROOM_VAPID_PRIVATE_KEY = 'UUxI4O8-FbRouAevSmBQ6o18hgE4nSG3qwvJTfKc-ls';
  resetVapidForTests();
});

afterEach(async () => {
  for (const [k, v] of [
    ['PLAYROOM_VAPID_PUBLIC_KEY', envBefore.pub],
    ['PLAYROOM_VAPID_PRIVATE_KEY', envBefore.priv],
    ['PLAYROOM_PUSH_ALLOWED_ORIGINS', envBefore.origins],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetVapidForTests();
  for (const room of rooms) {
    await pool.query('DELETE FROM push_sends WHERE room_id = $1', [room]);
    await pool.query('DELETE FROM room_members WHERE room_id = $1', [room]);
    await pool.query('DELETE FROM events WHERE room_id = $1', [room]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [room]);
  }
  rooms.length = 0;
  await pool.query("DELETE FROM push_subscriptions WHERE endpoint LIKE '%sp2-test%'");
});
afterAll(async () => {
  await pool.end();
});

async function room(prefix: string): Promise<string> {
  const id = uniqueRoomId(prefix);
  rooms.push(id);
  await createRoom(pool, id, id, 'prince');
  return id;
}
async function subscribe(endpoint: string): Promise<void> {
  await upsertSubscription(pool, {
    principalId: 'principal:prince',
    memberId: 'prince',
    endpoint,
    p256dh:
      'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkFbx_1sBQXWyLnaLPRRHRSy_JVKrJnnkTKzWLZzYSlfLQzHl1JTZBg',
    auth: 'k8JV6sjdbhAi1n3_LDBLvA',
  });
}
async function sends(roomId: string) {
  const { rows } = await pool.query<{
    outcome: string;
    endpoint_origin: string;
    urgency: string;
    disclosed: string;
    detail: string | null;
    interrupt_id: string | null;
  }>(
    `SELECT outcome, endpoint_origin, urgency, disclosed, detail, interrupt_id
       FROM push_sends WHERE room_id = $1 ORDER BY created_at`,
    [roomId],
  );
  return rows;
}

describe('the allowlist refuses an endpoint the room does not control', () => {
  it('a send to an unlisted origin is REFUSED and RECORDED, never attempted', async () => {
    const roomId = await room('sp2-allow');
    // The shape this list exists to stop: a crafted subscription pointing the server at an origin of
    // the author's choosing. Without the check that is a server-side request forgery with a
    // governance record attached.
    await subscribe('https://evil.example.com/sp2-test-forged');

    await notifyPrincipal(pool, {
      principalId: 'principal:prince',
      roomId,
      interruptId: 'int_forged',
      urgency: 'BLOCKER',
    });

    const rows = await sends(roomId);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('refused_endpoint');
    expect(rows[0].endpoint_origin).toBe('https://evil.example.com');
    expect(rows[0].detail).toBe('origin is not on the push allowlist');
    // THE REFUSAL IS THE RECORD. A silent skip would leave no evidence it was ever attempted.
    expect(rows[0].interrupt_id).toBe('int_forged');
  });

  it('refuses an endpoint that is not even a URL, rather than assuming it is safe', async () => {
    const roomId = await room('sp2-unparseable');
    await subscribe('not-a-url-sp2-test');
    await notifyPrincipal(pool, {
      principalId: 'principal:prince',
      roomId,
      interruptId: null,
      urgency: 'DECISION',
    });
    const rows = await sends(roomId);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('refused_endpoint');
    expect(rows[0].endpoint_origin).toBe('(unparseable)');
  });

  it('the default list is closed, and is the vendors’ push services only', () => {
    delete process.env.PLAYROOM_PUSH_ALLOWED_ORIGINS;
    expect(allowedOrigins()).toEqual([
      'https://fcm.googleapis.com',
      'https://updates.push.services.mozilla.com',
      'https://web.push.apple.com',
    ]);
    // Every entry is an https origin with no path — the thing an allowlist can actually compare.
    for (const o of allowedOrigins()) expect(originOf(o)).toBe(o);
  });
});

describe('a send that fails is a row, not a silence', () => {
  it('an allowed origin that cannot be reached records `failed` with the status only', async () => {
    const roomId = await room('sp2-failed');
    // An allowed origin that will not answer: the vendor path is exercised and fails at the network,
    // which is the case a real outage produces.
    process.env.PLAYROOM_PUSH_ALLOWED_ORIGINS = 'https://sp2-test.invalid';
    await subscribe('https://sp2-test.invalid/push/sp2-test-unreachable');

    await notifyPrincipal(pool, {
      principalId: 'principal:prince',
      roomId,
      interruptId: 'int_unreachable',
      urgency: 'BLOCKER',
    });

    const rows = await sends(roomId);
    expect(rows).toHaveLength(1);
    expect(['failed', 'gone']).toContain(rows[0].outcome);
    // S-SCRUB: the detail is a status or a phrase, never the vendor's body — which can echo the
    // request, and the request contains the endpoint and the encrypted payload.
    expect(rows[0].detail ?? '').not.toContain('sp2-test.invalid');
    expect(rows[0].detail ?? '').not.toContain('BEl62iUYgUivxIkv');
    expect(rows[0].detail ?? '').not.toContain('k8JV6sjdbhAi1n3');
  });

  it('never throws, whatever happens — the interrupt it follows is already committed', async () => {
    const roomId = await room('sp2-nothrow');
    process.env.PLAYROOM_PUSH_ALLOWED_ORIGINS = 'https://sp2-test.invalid';
    await subscribe('https://sp2-test.invalid/push/sp2-test-boom');
    await expect(
      notifyPrincipal(pool, {
        principalId: 'principal:prince',
        roomId,
        interruptId: null,
        urgency: 'BLOCKER',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('the throttle is a refusal on the record, not a drop', () => {
  it(`records refused_throttle once past ${THROTTLE_PER_HOUR} in the hour, and sends nothing more`, async () => {
    const roomId = await room('sp2-throttle');
    process.env.PLAYROOM_PUSH_ALLOWED_ORIGINS = 'https://sp2-test.invalid';
    await subscribe('https://sp2-test.invalid/push/sp2-test-throttle');

    // Fill the window with DELIVERED rows directly: the throttle counts what actually reached this
    // person, and manufacturing them is how the boundary gets tested without a vendor.
    for (let i = 0; i < THROTTLE_PER_HOUR; i++) {
      await pool.query(
        `INSERT INTO push_sends (id, principal_id, room_id, urgency, endpoint_origin, disclosed, outcome)
         VALUES ($1, 'principal:prince', $2, 'BLOCKER', 'https://sp2-test.invalid', $3, 'delivered')`,
        [`psend_fill_${i}_${Date.now()}`, roomId, DISCLOSED_FIELDS],
      );
    }

    await notifyPrincipal(pool, {
      principalId: 'principal:prince',
      roomId,
      interruptId: 'int_throttled',
      urgency: 'BLOCKER',
    });

    const rows = await sends(roomId);
    const throttled = rows.filter((r) => r.outcome === 'refused_throttle');
    expect(throttled, 'the throttle dropped a send silently').toHaveLength(1);
    expect(throttled[0].detail).toContain(String(THROTTLE_PER_HOUR));
    expect(throttled[0].interrupt_id).toBe('int_throttled');
    // ONE row for the refusal, not one per address: what was refused is the claim on this person.
    expect(rows.filter((r) => r.outcome === 'failed')).toHaveLength(0);
  });
});

describe('only the urgencies that should send, send', () => {
  it('an FYI reaches no vendor and writes no send row', async () => {
    const roomId = await room('sp2-fyi');
    process.env.PLAYROOM_PUSH_ALLOWED_ORIGINS = 'https://sp2-test.invalid';
    await subscribe('https://sp2-test.invalid/push/sp2-test-fyi');

    await notifyPrincipal(pool, {
      principalId: 'principal:prince',
      roomId,
      interruptId: 'int_fyi',
      urgency: 'FYI',
    });
    // FYI is DEFINED as the level that does not interrupt. No row, because nothing was attempted —
    // a record would imply something was.
    expect(await sends(roomId)).toHaveLength(0);
  });

  it('a deployment with no VAPID keys sends nothing and records nothing', async () => {
    const roomId = await room('sp2-unconfigured');
    delete process.env.PLAYROOM_VAPID_PUBLIC_KEY;
    delete process.env.PLAYROOM_VAPID_PRIVATE_KEY;
    resetVapidForTests();
    await subscribe('https://fcm.googleapis.com/fcm/send/sp2-test-nokeys');

    await notifyPrincipal(pool, {
      principalId: 'principal:prince',
      roomId,
      interruptId: null,
      urgency: 'BLOCKER',
    });
    expect(await sends(roomId)).toHaveLength(0);
  });
});

/**
 * PAYLOAD MINIMALITY — THE CONTROL THIS ASSERTS: nothing the fabric governs may leave the system in a
 * push payload. Written in the shape of the S1.8 injection test: it reads the ONE construction site
 * and proves what cannot be reached from there, rather than sampling outputs and hoping.
 *
 * The payload travels through a browser vendor's infrastructure. Room content, briefing text, mandate
 * content and another principal's message are all things the room decides who may read; a payload
 * that carried any of them would have moved that decision to a third party.
 */
describe('the payload discloses the minimum, and the control is named', () => {
  const SRC = resolve(import.meta.dirname, '..', 'src');
  const sender = readFileSync(resolve(SRC, 'push-send.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('the payload is built at exactly one site, from exactly three fields', () => {
    const sites = sender.match(/JSON\.stringify\(\{/g) ?? [];
    expect(sites, 'a second payload construction site appeared').toHaveLength(1);
    const start = sender.indexOf('const payload = JSON.stringify({');
    const body = sender.slice(start, sender.indexOf('});', start));
    expect(body).toContain('room: input.roomId');
    expect(body).toContain('urgency: input.urgency');
    expect(body).toContain('at:');
    // Keys counted by NAME, not by "name:" — S-DIAL added `tone` as a SHORTHAND property, which the
    // colon-only regex this line used to carry silently skipped. A minimality assertion that cannot
    // see a new field is worse than none, so it counts names and lists them.
    const keys = (body.match(/^\s*(\w+)\s*[,:]/gm) ?? []).map((k) => k.trim().replace(/[,:]$/, ''));
    expect(new Set(keys)).toEqual(new Set(['room', 'urgency', 'tone', 'at']));
  });

  it('the sender cannot reach room content, a briefing, a mandate or a message', () => {
    // THE INPUT TYPE IS THE CONTROL. NotifyInput carries a principal, a room ID, an interrupt ID and
    // an urgency — there is no field through which text could arrive, so the payload cannot contain
    // any regardless of what a caller intends.
    const inputType = sender.slice(
      sender.indexOf('export interface NotifyInput'),
      sender.indexOf('}', sender.indexOf('export interface NotifyInput')),
    );
    expect(inputType).toContain('principalId');
    expect(inputType).toContain('roomId');
    expect(inputType).toContain('interruptId');
    expect(inputType).toContain('urgency');
    expect((inputType.match(/^\s+\w+:/gm) ?? []).length).toBe(4);

    // And nothing in the file reaches for one anyway.
    for (const forbidden of [
      'summary',
      'activeBriefing',
      'briefing',
      'mandate',
      'assembleContext',
      'messagesAfterSeq',
      'payload.body',
    ]) {
      expect(sender, `the sender references "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it('every send row names what was disclosed, including the urgency word', () => {
    // R3: the urgency string is visible to the vendor. That is deliberate, and it is recorded as a
    // named disclosure rather than left as a detail nobody noticed.
    // WIDENED ONCE, BY S-DIAL, which added `tone`. This assertion moving is the point rather than
    // the inconvenience: the constant is what every future send row copies, so changing it is a
    // deliberate act that a test makes visible. Rows written before the widening still carry the
    // narrower string — the column is written at INSERT and never updated.
    expect(DISCLOSED_FIELDS).toBe(
      'room_id, urgency(BLOCKER|DECISION), tone(FINISHED|NEEDS-YOU), sent_at',
    );
    expect(sender).toContain('disclosed');
  });

  it('no key material or endpoint can reach a log line or a recorded detail', () => {
    // Every log call in this file, checked for the two things that must never be in one.
    for (const call of sender.match(/log\?\.(info|warn)\([\s\S]*?\)/g) ?? []) {
      expect(call, 'a log line carries an endpoint').not.toContain('endpoint:');
      expect(call, 'a log line carries key material').not.toContain('p256dh');
      expect(call, 'a log line carries key material').not.toContain('sub.auth');
    }
    // The vendor's error BODY is never recorded — only its status code.
    expect(sender).not.toContain('err.body');
    expect(sender).toContain('vendor status');
  });
});
