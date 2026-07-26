import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  httpCreateRoom,
  scriptedAdapter,
  startTestServer,
  testPool,
  uniqueRoomId,
  type TestServer,
} from './support.js';

// A ROOM CAN ONLY ADDRESS ITS OWN.
//
// Until S1.1b any room could summon any member, which was not a bug anyone had hit and was
// not a property the product should have. Tokens now resolve against THAT room's membership.
//
// The refusals are the point. A token naming a member who is not in this room is a DIFFERENT
// MISTAKE from a token naming nobody: one is fixed by adding them to the room, the other by
// correcting a typo. Fail-closed must distinguish refused from misconfigured, and collapsing
// both into "no member is called that" would send someone hunting for a typo that is not
// there.

const pool = testPool();
let server: TestServer;
const rooms: string[] = [];

function room(prefix: string): string {
  const id = uniqueRoomId(prefix);
  rooms.push(id);
  return id;
}

beforeAll(async () => {
  server = await startTestServer({
    adapterFactory: (id) =>
      scriptedAdapter(id, [
        { kind: 'text_delta', text: `${id} here` },
        { kind: 'done', tokens_in: 4, tokens_out: 2, stop_reason: 'end_turn' },
      ]),
  });
});

afterAll(async () => {
  for (const id of rooms) {
    await pool.query('DELETE FROM events WHERE room_id = $1', [id]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [id]);
  }
  await pool.end();
  await server.close();
});

describe('per-room summon resolution', () => {
  it('summons a member who IS in the room, exactly as before', async () => {
    const id = room('roster-in');
    expect((await httpCreateRoom(server.httpBase, id)).status).toBe(201);
    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();

    c.send('@sol are you there?', 'in-1');
    await c.waitForType('agent.turn.completed');
    expect(c.ofType('summon')).toHaveLength(1);
    c.close();
  });

  it('REFUSES a member who is not in this room, and says which mistake it was', async () => {
    // Sol is removed from this room only. She still exists, still has a mandate, and is still
    // in every other room — which is precisely why the sentence must not say "nobody is
    // called that".
    const id = room('roster-out');
    expect((await httpCreateRoom(server.httpBase, id)).status).toBe(201);
    await pool.query('DELETE FROM room_members WHERE room_id = $1 AND member_id = $2', [id, 'sol']);

    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();
    c.send('@sol can you look at this?', 'out-1');
    await c.waitForEvents(2);
    await new Promise((r) => setTimeout(r, 800));

    const bodies = c.bodies();
    expect(bodies[1]).toBe('@sol is not in this room.');
    // No summon, no turn — the refusal is the whole response.
    expect(c.ofType('summon')).toHaveLength(0);
    expect(c.ofType('agent.turn.started')).toHaveLength(0);
    c.close();
  });

  it('still says "no member is called that" for a token naming nobody', async () => {
    // The other refusal, unchanged. Two sentences, because two remedies.
    const id = room('roster-unknown');
    expect((await httpCreateRoom(server.httpBase, id)).status).toBe(201);
    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();
    c.send('@nobody hello', 'unk-1');
    await c.waitForEvents(2);

    expect(c.bodies()[1]).toBe('No member of this room is called @nobody.');
    c.close();
  });

  it('distinguishes the two in one message', async () => {
    const id = room('roster-both');
    expect((await httpCreateRoom(server.httpBase, id)).status).toBe(201);
    await pool.query('DELETE FROM room_members WHERE room_id = $1 AND member_id = $2', [id, 'sol']);

    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();
    c.send('@sol and @nobody, please', 'both-1');
    await c.waitForEvents(2);
    await new Promise((r) => setTimeout(r, 800));

    const notice = c.bodies()[1];
    expect(notice).toContain('@sol is not in this room.');
    expect(notice).toContain('No member of this room is called @nobody.');
    c.close();
  });

  it('follows a membership change WITHOUT a restart', async () => {
    // S11a-N2's replacement, asserted. The token table was a boot-time process snapshot,
    // which was defensible while membership was configuration. It is data now: a member
    // removed mid-session must stop being addressable on the very next message, not at the
    // next deploy.
    const id = room('roster-live');
    expect((await httpCreateRoom(server.httpBase, id)).status).toBe(201);
    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();

    c.send('@sol first time', 'live-1');
    await c.waitForType('agent.turn.completed');
    expect(c.ofType('summon')).toHaveLength(1);

    // Same process, same server, no restart.
    await pool.query('DELETE FROM room_members WHERE room_id = $1 AND member_id = $2', [id, 'sol']);

    c.send('@sol second time', 'live-2');
    await new Promise((r) => setTimeout(r, 1500));
    expect(c.ofType('summon')).toHaveLength(1); // still one — the second was refused
    expect(c.bodies()).toContain('@sol is not in this room.');
    c.close();
  });
});

describe('membership records', () => {
  it('refuses to enrol a member that does not exist — foreign key', async () => {
    const id = room('roster-fk');
    expect((await httpCreateRoom(server.httpBase, id)).status).toBe(201);
    await expect(
      pool.query('INSERT INTO room_members (room_id, member_id) VALUES ($1, $2)', [id, 'no-such']),
    ).rejects.toThrow(/foreign key/i);
  });

  it('refuses to enrol into a room that does not exist — foreign key', async () => {
    await expect(
      pool.query('INSERT INTO room_members (room_id, member_id) VALUES ($1, $2)', [
        'no-such-room',
        'sol',
      ]),
    ).rejects.toThrow(/foreign key/i);
  });

  it('cannot enrol the same member twice — the composite key is the record', async () => {
    const id = room('roster-dupe');
    expect((await httpCreateRoom(server.httpBase, id)).status).toBe(201);
    await expect(
      pool.query('INSERT INTO room_members (room_id, member_id) VALUES ($1, $2)', [id, 'sol']),
    ).rejects.toThrow(/duplicate key/i);
  });
});

describe('events.actor_member_id', () => {
  it('links an event to the member who wrote it, when the actor IS one', async () => {
    const id = room('actor-link');
    expect((await httpCreateRoom(server.httpBase, id)).status).toBe(201);
    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();
    c.send('hello from a real member', 'link-1');
    await c.waitForEvents(1);

    const { rows } = await pool.query<{ actor_id: string; actor_member_id: string | null }>(
      "SELECT actor_id, actor_member_id FROM events WHERE room_id = $1 AND event_type = 'message'",
      [id],
    );
    expect(rows[0]).toEqual({ actor_id: 'prince', actor_member_id: 'prince' });
    c.close();
  });

  it('leaves it NULL only for `system` — a client can no longer produce a non-member actor', async () => {
    // THIS TEST'S PREMISE CHANGED IN S1.2, and the change is the point.
    //
    // It used to send as 'not-a-member-at-all' and assert the event was written with a NULL
    // link — because a caller could name any actor and rejecting them required knowing who they
    // really were. The wire has no author field now, so the only actor a client can produce is
    // the authenticated member. The NULL case survives for exactly one writer: `system`, the
    // room speaking, which is not a member and has no principal.
    //
    // Migration 010 turned that into a constraint: every event names a member OR is the room
    // speaking. Nothing else, and the third possibility is gone rather than tolerated.
    const id = room('actor-system');
    expect((await httpCreateRoom(server.httpBase, id)).status).toBe(201);
    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();
    // A tag naming nobody makes the ROOM speak — the one remaining NULL writer.
    c.send('@nobody hello', 'sys-1');
    await c.waitForEvents(2);

    const { rows } = await pool.query<{ actor_id: string; actor_member_id: string | null }>(
      `SELECT actor_id, actor_member_id FROM events
        WHERE room_id = $1 AND event_type = 'message' ORDER BY seq`,
      [id],
    );
    expect(rows[0]).toEqual({ actor_id: 'prince', actor_member_id: 'prince' });
    expect(rows[1]).toEqual({ actor_id: 'system', actor_member_id: null });
    c.close();
  });

  it('REFUSES a non-member, non-system actor at the database — migration 010', async () => {
    // The constraint stated as a test. No client can reach this any more; a hand-run INSERT or
    // a future command that forgot the stamp still can, and that is what the check is for.
    const id = room('actor-check');
    expect((await httpCreateRoom(server.httpBase, id)).status).toBe(201);
    await expect(
      pool.query(
        `INSERT INTO events (room_id, actor_id, actor_member_id, event_type, payload)
         VALUES ($1, 'someone-invented', NULL, 'message', '{"body":"x"}')`,
        [id],
      ),
    ).rejects.toThrow(/events_actor_is_member_or_system/);
  });

  it('refuses an event naming a member that does not exist — the foreign key holds', async () => {
    const id = room('actor-fk');
    expect((await httpCreateRoom(server.httpBase, id)).status).toBe(201);
    await expect(
      pool.query(
        `INSERT INTO events (room_id, actor_id, actor_member_id, event_type, payload)
         VALUES ($1, 'x', 'ghost-member', 'message', '{"body":"x"}')`,
        [id],
      ),
    ).rejects.toThrow(/foreign key/i);
  });
});
