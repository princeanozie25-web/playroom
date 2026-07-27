import { afterAll, describe, expect, it } from 'vitest';
import {
  Client,
  httpCreateRoom,
  issueTestCredential,
  startTestServer,
  testPool,
  type TestServer,
} from './support.js';
import { listMembers, listRoomMembers, loadRoomTokens } from '../src/members.js';

// THE ROSTER, AS RECORDS AND AS THE ROOM SEES IT.
//
// Two things are asserted, and the second matters more than it looks:
//
//   1. `listMembers` returns what the room needs, from the database.
//   2. WHAT IT RETURNS IS WHAT THE ROOM SHOWED BEFORE THE MOVE. S1.1a changed where the
//      roster comes from and must change nothing a viewer can see. "Same two members, same
//      affiliations, same accents" is the whole exit criterion for the change, and it is the
//      kind of thing that is easy to break and hard to notice — an ordinal off by one
//      recolours the room, a missing join drops an affiliation.

const pool = testPool();
let server: TestServer;

afterAll(async () => {
  await pool.end();
  if (server) await server.close();
});

describe('listMembers', () => {
  it('returns the agents exactly as they rendered before members were records', async () => {
    // `prince` joined the records in S1.1b as a HUMAN member, so the full list is no longer
    // agents-only. The agents' fields are what the roster strip draws and must not move.
    const members = (await listMembers(pool)).filter((m) => m.kind === 'agent');
    expect(members).toEqual([
      {
        id: 'claude-main',
        kind: 'agent',
        display_name: 'Claude',
        principal_id: 'principal:prince',
        principal_name: 'Prince',
        principal_ordinal: 0,
        adapter_id: 'claude-main',
        scope: ['pr.review', 'pr.comment', 'pr.merge'],
        protected_actions: ['pr.merge', 'deploy'],
      },
      {
        id: 'sol',
        kind: 'agent',
        display_name: 'Sol',
        principal_id: 'principal:jerry',
        principal_name: 'Jerry',
        principal_ordinal: 1,
        adapter_id: 'sol',
        scope: ['pr.review', 'pr.comment'],
        protected_actions: ['pr.merge', 'deploy'],
      },
    ]);
  });

  it('names no provider and no model — §6 survives the roster becoming records', async () => {
    // The roster now travels over HTTP to the web tier, which is a new way for a provider
    // name to escape packages/adapters. Asserted against the serialised shape, because that
    // is what actually leaves the process.
    const serialised = JSON.stringify(await listMembers(pool));
    expect(serialised).not.toMatch(/anthropic|openai|gpt-|claude-haiku/i);
  });

  it('orders by principal ordinal, so the roster strip does not reshuffle', async () => {
    const members = await listMembers(pool);
    const ordinals = members.map((m) => m.principal_ordinal);
    expect([...ordinals].sort((a, b) => a - b)).toEqual(ordinals);
  });

  it('carries prince as a HUMAN member bound to his principal, with no adapter', async () => {
    // The film's human was a free string in actor_id with no referent anywhere. S1.1b makes
    // him a record under the same binding every other member has had since 007.
    const prince = (await listMembers(pool)).find((m) => m.id === 'prince');
    expect(prince).toMatchObject({
      kind: 'human',
      display_name: 'Prince',
      principal_id: 'principal:prince',
      adapter_id: null,
    });
  });
});

describe('a room roster, scoped', () => {
  it('GET /rooms/:id/members returns only that room, and 404s for a room that is not there', async () => {
    server = await startTestServer();
    const room = `members-scope-${Date.now()}`;
    expect((await httpCreateRoom(server.httpBase, room, server.token)).status).toBe(201);

    const res = await fetch(`${server.httpBase}/rooms/${room}/members`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Array<{ id: string; principal_name: string }> };
    // A new room gets every current member — today's behaviour, recorded rather than narrowed.
    expect(body.members.map((m) => m.id).sort()).toEqual(['claude-main', 'prince', 'sol']);

    const ghost = await fetch(`${server.httpBase}/rooms/no-such-room-here/members`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(ghost.status).toBe(404);

    await pool.query('DELETE FROM rooms WHERE id = $1', [room]);
  });

  it('a member removed from a room is no longer in its roster', async () => {
    // The path that makes per-room scoping observable. There is no product surface for
    // removing a member yet — invites and their inverse need an authenticated actor (S1.2) —
    // but membership is data, and the read must follow it.
    const room = `members-remove-${Date.now()}`;
    expect((await httpCreateRoom(server.httpBase, room, server.token)).status).toBe(201);
    await pool.query('DELETE FROM room_members WHERE room_id = $1 AND member_id = $2', [
      room,
      'sol',
    ]);

    const inRoom = await listRoomMembers(pool, room);
    expect(inRoom.map((m) => m.id).sort()).toEqual(['claude-main', 'prince']);
    // The full-roster read still sees sol — the member exists, they are just not here.
    expect((await listMembers(pool)).map((m) => m.id)).toContain('sol');

    await pool.query('DELETE FROM rooms WHERE id = $1', [room]);
  });

  it('the summon tokens for a room resolve the same tags as before', async () => {
    // `@claude` must still mean claude-main. The display name moved from adapters.yaml to a
    // member record in S1.1a and resolution became per-room in S1.1b; this is the tag the
    // film types, checked through both moves.
    const room = `members-tokens-${Date.now()}`;
    expect((await httpCreateRoom(server.httpBase, room, server.token)).status).toBe(201);
    await loadRoomTokens(pool, room);

    const { summonRuling } = await import('../src/agent.js');
    const ruling = summonRuling({
      type: 'event',
      seq: 1,
      room_id: room,
      ts: '2026-07-26T00:00:00.000Z',
      actor_id: 'prince',
      event_type: 'message',
      payload: { body: '@claude and @sol' },
    });
    expect(ruling.rule).toBe('ACTIVATED');
    expect(ruling.members).toEqual(['claude-main', 'sol']);

    await pool.query('DELETE FROM rooms WHERE id = $1', [room]);
  });
});

describe('who may read a roster (S1.2)', () => {
  it('REFUSES an unauthenticated read — 401, and the two credential codes stay apart', async () => {
    // S11a-N1's other half. The rows were scoped to a room in S1.1b and who may ask was left
    // open, with the finding saying so. A roster is not a room id: it names people, the
    // principals they act for, and the actions each of them has been fenced from.
    const room = `roster-auth-${Date.now()}`;
    expect((await httpCreateRoom(server.httpBase, room, server.token)).status).toBe(201);

    const none = await fetch(`${server.httpBase}/rooms/${room}/members`);
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ type: 'error', code: 'credential_required' });

    const bad = await fetch(`${server.httpBase}/rooms/${room}/members`, {
      headers: { authorization: 'Bearer prm_nonsense' },
    });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ type: 'error', code: 'credential_invalid' });

    // A token in the wrong PLACE is not a credential. Accepting `?token=` here would put a
    // secret into every access log and browser history on the way — the socket does it only
    // because the browser WebSocket API cannot set headers.
    const inUrl = await fetch(`${server.httpBase}/rooms/${room}/members?token=${server.token}`);
    expect(inUrl.status).toBe(401);

    await pool.query('DELETE FROM rooms WHERE id = $1', [room]);
  });

  it('a caller who is NOT IN THE ROOM gets exactly what a non-existent room gives', async () => {
    // The one place a refusal deliberately does NOT distinguish two mistakes. `sol` holds a
    // legitimate credential; if a non-member were told "you are not in this room" it could
    // enumerate room ids by trying, and cross-principal leakage is what the product exists to
    // prevent. The distinction is moved to the server's log, not lost.
    const room = `roster-outsider-${Date.now()}`;
    expect((await httpCreateRoom(server.httpBase, room, server.token)).status).toBe(201);
    await pool.query('DELETE FROM room_members WHERE room_id = $1 AND member_id = $2', [
      room,
      'sol',
    ]);
    const solToken = await issueTestCredential('sol', 'roster-outsider');

    const outsider = await fetch(`${server.httpBase}/rooms/${room}/members`, {
      headers: { authorization: `Bearer ${solToken}` },
    });
    const ghost = await fetch(`${server.httpBase}/rooms/definitely-not-a-room/members`, {
      headers: { authorization: `Bearer ${solToken}` },
    });
    expect(outsider.status).toBe(404);
    expect(ghost.status).toBe(404);
    // Byte-identical bodies, not merely the same status — a different sentence would be the
    // same oracle with extra steps.
    const normalise = (body: string, id: string): string => body.replaceAll(id, '<room>');
    expect(normalise(await outsider.text(), room)).toBe(
      normalise(await ghost.text(), 'definitely-not-a-room'),
    );

    // And a member who IS in the room still reads it. The scoping must not be a wall.
    const insider = await fetch(`${server.httpBase}/rooms/${room}/members`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(insider.status).toBe(200);

    await pool.query("DELETE FROM member_credentials WHERE label = 'roster-outsider'");
    await pool.query('DELETE FROM rooms WHERE id = $1', [room]);
  });
});

describe('the oracle is closed everywhere, not just at the front door (S12-N1)', () => {
  it('GET /rooms/:id requires a credential, and refuses a token in the query string', async () => {
    const roomId = `oracle-auth-${Date.now()}`;
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);

    const none = await fetch(`${server.httpBase}/rooms/${roomId}`);
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ type: 'error', code: 'credential_required' });

    // A token in the wrong PLACE is not a credential — it would be written to every access log
    // and browser history on the way. Same rule as the roster route.
    const inUrl = await fetch(`${server.httpBase}/rooms/${roomId}?token=${server.token}`);
    expect(inUrl.status).toBe(401);

    const ok = await fetch(`${server.httpBase}/rooms/${roomId}`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: roomId });

    await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
  });

  it('THE SILENCE HOLDS END TO END — every route answers a non-member the same way', async () => {
    // The ruling's condition: "an oracle anywhere undoes silence everywhere". The handshake going
    // quiet is worth nothing if a sibling route answers the same question one request later, so
    // this asserts the whole surface at once rather than each route in isolation.
    const roomId = `oracle-end-${Date.now()}`;
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    await pool.query('DELETE FROM room_members WHERE room_id = $1 AND member_id = $2', [
      roomId,
      'sol',
    ]);
    const solToken = await issueTestCredential('sol', 'roster-outsider');
    const bearer = { authorization: `Bearer ${solToken}` };
    const ghostId = 'oracle-no-such-room';

    for (const path of ['', '/members']) {
      const outsider = await fetch(`${server.httpBase}/rooms/${roomId}${path}`, {
        headers: bearer,
      });
      const ghost = await fetch(`${server.httpBase}/rooms/${ghostId}${path}`, { headers: bearer });
      expect(outsider.status, `GET /rooms/:id${path} status`).toBe(404);
      expect(ghost.status).toBe(404);
      const normalise = (body: string, id: string): string => body.replaceAll(id, '<room>');
      expect(normalise(await outsider.text(), roomId), `GET /rooms/:id${path} body`).toBe(
        normalise(await ghost.text(), ghostId),
      );
    }

    // AND THE CREATE ROUTE, which used to return an existing room's title and creation date to
    // anyone who guessed the id — an oracle for content, not merely for existence. It is closed
    // twice over now, and both halves are asserted because they fail independently.
    //
    // FIRST: it takes a credential at all (RT-002, closed in S1.3c).
    const anonymous = await fetch(`${server.httpBase}/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: roomId, title: 'a title I chose' }),
    });
    expect(anonymous.status).toBe(401);

    // SECOND: even an authenticated member learns nothing by guessing. `sol` is not in this room;
    // a collision and a fresh create return the same body, so the response cannot be used to
    // discover that the room exists or what it is called.
    const collide = await fetch(`${server.httpBase}/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer },
      body: JSON.stringify({ id: roomId, title: 'a title I chose' }),
    });
    expect(collide.status).toBe(201);
    expect(await collide.json()).toEqual({ id: roomId });

    await pool.query("DELETE FROM member_credentials WHERE label = 'roster-outsider'");
    await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
  });
});

describe('creating a room requires a credential (RT-002, closed in S1.3c)', () => {
  it('REFUSES an unauthenticated create, in the standard shape', async () => {
    const res = await fetch(`${server.httpBase}/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: `rt002-${Date.now()}`, title: 'no credential here' }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ type: 'error', code: 'credential_required' });

    const bad = await fetch(`${server.httpBase}/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer prm_nope' },
      body: JSON.stringify({ id: `rt002-bad-${Date.now()}` }),
    });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ code: 'credential_invalid' });
  });

  it('ENROLS THE CREATOR in the same transaction, so the room can actually be opened', async () => {
    // The property that makes creation and enrolment one act rather than two: after S1.3b's front
    // door, a room with no members is a room NOBODY can open — including the member who just made
    // it, and there is no product surface to fix it from.
    const roomId = `rt002-enrol-${Date.now()}`;
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);

    const { rows } = await pool.query<{ member_id: string }>(
      'SELECT member_id FROM room_members WHERE room_id = $1 ORDER BY member_id',
      [roomId],
    );
    expect(rows.map((r) => r.member_id)).toContain('prince');

    // And the door opens for them, which is the only assertion that proves the row is the right
    // one rather than merely present.
    const c = new Client(`${server.wsBase}/rooms/${roomId}/ws?after=0`, server.token);
    await c.open();
    c.send('the creator can open their own room', 'rt002-1');
    await c.waitForEvents(1);
    expect(c.events[0].actor_id).toBe('prince');
    c.close();

    await pool.query('DELETE FROM events WHERE room_id = $1', [roomId]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
  });
});
