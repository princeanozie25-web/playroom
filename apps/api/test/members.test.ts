import { afterAll, describe, expect, it } from 'vitest';
import { httpCreateRoom, startTestServer, testPool, type TestServer } from './support.js';
import { listMembers } from '../src/members.js';

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
    // `prince` became a HUMAN member record in this commit (migration 008), so the full list
    // is no longer agents-only. The AGENTS' fields are what the roster strip draws and are
    // what must not move.
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
});

describe('GET /members', () => {
  it('serves the roster to the web tier, with no filesystem read on that side', async () => {
    server = await startTestServer();
    const res = await fetch(`${server.httpBase}/members`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Array<{ id: string; principal_name: string }> };
    // prince is a member as of this commit, and the endpoint is not room-scoped yet.
    expect(body.members.map((m) => m.id).sort()).toEqual(['claude-main', 'prince', 'sol']);
  });

  it('the summon tokens the server loaded resolve the same tags as before', async () => {
    // `@claude` must still mean claude-main. The display name moved from adapters.yaml to a
    // member record between S11a-1 and S11a-2, and this tag is what the film types.
    const room = `members-tokens-${Date.now()}`;
    expect((await httpCreateRoom(server.httpBase, room)).status).toBe(201);
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
    await pool.query('DELETE FROM events WHERE room_id = $1', [room]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [room]);
  });
});
