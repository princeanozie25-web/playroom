import { afterAll, describe, expect, it } from 'vitest';
import { httpCreateRoom, startTestServer, testPool, type TestServer } from './support.js';
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
    expect((await httpCreateRoom(server.httpBase, room)).status).toBe(201);

    const res = await fetch(`${server.httpBase}/rooms/${room}/members`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Array<{ id: string; principal_name: string }> };
    // A new room gets every current member — today's behaviour, recorded rather than narrowed.
    expect(body.members.map((m) => m.id).sort()).toEqual(['claude-main', 'prince', 'sol']);

    const ghost = await fetch(`${server.httpBase}/rooms/no-such-room-here/members`);
    expect(ghost.status).toBe(404);

    await pool.query('DELETE FROM rooms WHERE id = $1', [room]);
  });

  it('a member removed from a room is no longer in its roster', async () => {
    // The path that makes per-room scoping observable. There is no product surface for
    // removing a member yet — invites and their inverse need an authenticated actor (S1.2) —
    // but membership is data, and the read must follow it.
    const room = `members-remove-${Date.now()}`;
    expect((await httpCreateRoom(server.httpBase, room)).status).toBe(201);
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
    expect((await httpCreateRoom(server.httpBase, room)).status).toBe(201);
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
