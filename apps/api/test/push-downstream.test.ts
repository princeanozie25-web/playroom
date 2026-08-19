import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { testPool, uniqueRoomId } from './support.js';
import { createRoom } from '../src/events.js';
import { raiseInterrupt } from '../src/interrupts.js';
import { upsertSubscription } from '../src/push.js';
import { resetVapidForTests } from '../src/push-send.js';

/**
 * ═══ S-PUSH — THE SEND IS DOWNSTREAM (SP-3) ═══
 *
 * SCC-3's rule, asserted directly: an interrupt whose push FAILED is byte-identical to one whose
 * push was never attempted. Same row, same event, same halt, same everything. The only difference a
 * send makes anywhere is a row in `push_sends`.
 *
 * The inversion this guards against is the tempting one: firing the push on the interrupt path,
 * where the event already is. Then a slow vendor is latency on raising a hand and a vendor outage is
 * an interrupt that fails to record — the claim disappearing because the telling did.
 */

const pool = testPool();
const rooms: string[] = [];
let envBefore: Record<string, string | undefined> = {};

const KEYS = {
  pub: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkFbx_1sBQXWyLnaLPRRHRSy_JVKrJnnkTKzWLZzYSlfLQzHl1JTZBg',
  priv: 'UUxI4O8-FbRouAevSmBQ6o18hgE4nSG3qwvJTfKc-ls',
};

function setKeys(on: boolean): void {
  if (on) {
    process.env.PLAYROOM_VAPID_PUBLIC_KEY = KEYS.pub;
    process.env.PLAYROOM_VAPID_PRIVATE_KEY = KEYS.priv;
  } else {
    delete process.env.PLAYROOM_VAPID_PUBLIC_KEY;
    delete process.env.PLAYROOM_VAPID_PRIVATE_KEY;
  }
  resetVapidForTests();
}

async function clearAgentSpend(): Promise<void> {
  await pool.query(
    `DELETE FROM events
      WHERE event_type IN ('interrupt.raised', 'interrupt.downgraded')
        AND payload ->> 'raised_by' = 'claude-code'
        AND ts >= date_trunc('day', now() AT TIME ZONE 'UTC')`,
  );
}

beforeEach(async () => {
  envBefore = {
    pub: process.env.PLAYROOM_VAPID_PUBLIC_KEY,
    priv: process.env.PLAYROOM_VAPID_PRIVATE_KEY,
    origins: process.env.PLAYROOM_PUSH_ALLOWED_ORIGINS,
  };
  // The mandate budget is member-wide and daily rather than room-scoped. The integration suite
  // deliberately shares one test database, so this file must establish the same pristine budget
  // precondition as the other interrupt suites instead of depending on their execution order.
  await clearAgentSpend();
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
    await pool.query('DELETE FROM interrupts WHERE room_id = $1', [room]);
    await pool.query('DELETE FROM events WHERE room_id = $1', [room]);
    await pool.query('DELETE FROM room_members WHERE room_id = $1', [room]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [room]);
  }
  rooms.length = 0;
  await pool.query("DELETE FROM push_subscriptions WHERE endpoint LIKE '%sp3-test%'");
  await clearAgentSpend();
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

/** A subscription pointing at an ALLOWED origin that cannot answer — the vendor-outage case. */
async function deadSubscription(): Promise<void> {
  process.env.PLAYROOM_PUSH_ALLOWED_ORIGINS = 'https://sp3-test.invalid';
  await upsertSubscription(pool, {
    principalId: 'principal:prince',
    memberId: 'prince',
    endpoint: `https://sp3-test.invalid/push/sp3-test-${Date.now()}`,
    p256dh: KEYS.pub,
    auth: 'k8JV6sjdbhAi1n3_LDBLvA',
  });
}

/** The interrupt as the database holds it, plus the event the room renders from. */
async function recordOf(roomId: string) {
  const { rows: interrupts } = await pool.query(
    `SELECT urgency, raised_by, addressed_to, about_kind, about_id, task_id
       FROM interrupts WHERE room_id = $1`,
    [roomId],
  );
  const { rows: events } = await pool.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM events WHERE room_id = $1 AND event_type = 'interrupt.raised'`,
    [roomId],
  );
  // The ids differ by construction (a uuid per raise), so they are excluded from the comparison and
  // everything else is included.
  // EXCLUDED, WITH REASONS. `interrupt_id` is a fresh uuid per raise. `budget_remaining` is a
  // function of the RAISER'S OWN HISTORY — how many claims they have made today — so two raises by
  // one member can never carry the same number, and it has nothing to do with the send path. It is
  // asserted separately below, where its decrement is the point.
  const scrubIds = (o: Record<string, unknown>) => {
    const { interrupt_id: _i, budget_remaining: _b, ...rest } = o;
    return rest;
  };
  return { interrupts, events: events.map((e) => scrubIds(e.payload)) };
}

async function raise(roomId: string, urgency: 'BLOCKER' | 'DECISION' | 'FYI' = 'DECISION') {
  return raiseInterrupt(pool, {
    roomId,
    urgency,
    raisedBy: 'claude-code',
    addressedTo: 'prince',
    aboutKind: 'hand',
    // A FIXED about_id, not one built from the room: the uniqueness index is per-room, so the same
    // value in two rooms is legal — and the byte-identical comparison below is worthless if the
    // fixture makes the two rows differ by construction. (It did, in the first version of this test.)
    aboutId: 'sp3-hand',
    summary: 'a hand raised while the room was closed',
  });
}

describe('an interrupt is byte-identical whether or not a push happened', () => {
  it('sends OFF versus sends ON-and-FAILING produce the same record and the same event', async () => {
    // A: notifications are not configured at all — nothing is attempted.
    setKeys(false);
    const roomOff = await room('sp3-off');
    const off = await raise(roomOff);
    expect(off.ok).toBe(true);

    // B: notifications ARE configured, a subscription exists, and the vendor cannot be reached.
    setKeys(true);
    const roomFail = await room('sp3-fail');
    await deadSubscription();
    const failed = await raise(roomFail);
    expect(failed.ok).toBe(true);

    // Let the fire-and-forget send finish so the comparison is made after everything has settled.
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const { rows } = await pool.query<{ n: string }>(
        'SELECT count(*) AS n FROM push_sends WHERE room_id = $1',
        [roomFail],
      );
      if (Number(rows[0].n) > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const a = await recordOf(roomOff);
    const b = await recordOf(roomFail);
    // BYTE-IDENTICAL, field by field. The room id is the only thing that differs, so it is not in
    // the projection either comparison reads.
    expect(b.interrupts).toEqual(a.interrupts);
    expect(b.events.map((e) => ({ ...e, room: undefined }))).toEqual(
      a.events.map((e) => ({ ...e, room: undefined })),
    );

    // And the ONLY difference anywhere is the send row.
    const { rows: offSends } = await pool.query('SELECT id FROM push_sends WHERE room_id = $1', [
      roomOff,
    ]);
    const { rows: failSends } = await pool.query<{ outcome: string }>(
      'SELECT outcome FROM push_sends WHERE room_id = $1',
      [roomFail],
    );
    expect(offSends).toHaveLength(0);
    expect(failSends).toHaveLength(1);
    expect(['failed', 'gone']).toContain(failSends[0].outcome);

    // THE BUDGET MOVED BY EXACTLY ONE, and by the raise — not by the send. A failed notification
    // must not refund a claim any more than it may undo one.
    const budgetOf = async (roomId: string) => {
      const { rows } = await pool.query<{ payload: { budget_remaining: number | null } }>(
        `SELECT payload FROM events WHERE room_id = $1 AND event_type = 'interrupt.raised'`,
        [roomId],
      );
      return rows[0].payload.budget_remaining;
    };
    expect(await budgetOf(roomFail)).toBe((await budgetOf(roomOff))! - 1);
  });

  it('the raise SUCCEEDS with every subscription dead, and with the vendor unreachable', async () => {
    setKeys(true);
    const roomId = await room('sp3-dead');
    await deadSubscription();
    await deadSubscription(); // two dead addresses, so the loop runs more than once
    const r = await raise(roomId, 'BLOCKER');
    expect(r.ok, 'a dead vendor changed the outcome of raising a hand').toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.interrupt.urgency).toBe('BLOCKER');
    expect(r.event).not.toBeNull();
  });
});

describe('the send is downstream, structurally and not just in wall-clock', () => {
  it('raiseInterrupt returns BEFORE the send has been recorded', async () => {
    setKeys(true);
    const roomId = await room('sp3-order');
    await deadSubscription();

    const r = await raise(roomId);
    expect(r.ok).toBe(true);
    // AT THE MOMENT THE RAISE RETURNS, the send has not been recorded — it is still in flight. This
    // is the structural proof of "downstream": a blocking implementation could not produce it, and
    // it does not depend on a timing threshold that a slow CI box could break.
    const { rows: atReturn } = await pool.query('SELECT id FROM push_sends WHERE room_id = $1', [
      roomId,
    ]);
    expect(
      atReturn,
      'the send completed before the raise returned — it is not downstream',
    ).toHaveLength(0);

    // ...and it does arrive, so this is not a test that passes because nothing ever sends.
    const deadline = Date.now() + 20000;
    let eventually = 0;
    while (Date.now() < deadline && eventually === 0) {
      const { rows } = await pool.query<{ n: string }>(
        'SELECT count(*) AS n FROM push_sends WHERE room_id = $1',
        [roomId],
      );
      eventually = Number(rows[0].n);
      if (eventually === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(eventually).toBe(1);
  });

  it('the raise path stays inside its measured budget with sends on and failing', async () => {
    setKeys(true);
    const roomId = await room('sp3-latency');
    await deadSubscription();

    const samples: number[] = [];
    for (let i = 0; i < 8; i++) {
      const t0 = performance.now();
      await raiseInterrupt(pool, {
        roomId,
        urgency: 'DECISION',
        raisedBy: 'prince', // a human raiser has no mandate and therefore no budget to exhaust
        addressedTo: 'prince',
        aboutKind: 'hand',
        aboutId: `sp3-latency-${i}-${Date.now()}`,
        summary: 'timing the raise with a broken vendor downstream',
      });
      samples.push(performance.now() - t0);
    }
    const p50 = samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];
    // SP-1 published the baseline with nothing downstream: p50 40.7ms, p95 45.3ms (n=90, Neon over
    // the public internet). The bound here is deliberately loose — this asserts the send is not on
    // the path, not a percentile. An awaited send to an unreachable host would be seconds.
    expect(p50, `raise p50 was ${p50.toFixed(1)}ms with a broken vendor downstream`).toBeLessThan(
      400,
    );
  });
});

describe('only what should send, sends — and an agent gains no new reach', () => {
  it('an FYI raises normally and sends nothing', async () => {
    setKeys(true);
    const roomId = await room('sp3-fyi');
    await deadSubscription();
    const r = await raise(roomId, 'FYI');
    expect(r.ok).toBe(true);
    await new Promise((res) => setTimeout(res, 800));
    const { rows } = await pool.query('SELECT id FROM push_sends WHERE room_id = $1', [roomId]);
    expect(rows, 'an FYI woke a phone').toHaveLength(0);
  });

  it('THE ONLY WAY TO CAUSE A SEND IS TO RAISE AN INTERRUPT — asserted at source', () => {
    const SRC = resolve(import.meta.dirname, '..', 'src');
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // Every file that reaches the sender, and there is exactly one: the interrupt module. An agent
    // therefore gains NO new capability from this slice — it can cause a notification only by
    // raising an interrupt it was already allowed to raise, under the budget that already prices
    // it, addressed to a member it was already allowed to address.
    const callers: string[] = [];
    for (const f of ['interrupts.ts', 'server.ts', 'agent.ts', 'push.ts']) {
      const body = strip(readFileSync(resolve(SRC, f), 'utf8'));
      if (body.includes('notifyPrincipal(')) callers.push(f);
    }
    expect(callers).toEqual(['interrupts.ts']);

    const interrupts = strip(readFileSync(resolve(SRC, 'interrupts.ts'), 'utf8'));
    // FIRE-AND-FORGET, asserted: `void`, never `await`. An awaited send would put a vendor on the
    // raise path, which is the inversion SCC-3's rule forbids.
    expect(interrupts).toContain('void notifyForInterrupt(');
    expect(interrupts).not.toContain('await notifyForInterrupt(');
    // And it happens AFTER the row and the event exist — the dispatch sits below the halt block and
    // immediately above the return, so nothing it does can precede the record.
    const dispatch = interrupts.indexOf('void notifyForInterrupt(');
    const insert = interrupts.indexOf('INSERT INTO interrupts');
    const ret = interrupts.indexOf('return { ok: true, interrupt, event, halt }');
    expect(dispatch).toBeGreaterThan(insert);
    expect(dispatch).toBeLessThan(ret);
  });
});
