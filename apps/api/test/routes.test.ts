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
import { listRoutes, selectRoute } from '../src/routes.js';

// ROUTES: HOW A MEMBER IS REACHABLE (Bible §6.1, §6.2).
//
// A member record says a member EXISTS. Before S1.1c nothing said whether they were REACHABLE,
// and the gap was not theoretical: `getAdapterConfig` returns a disabled adapter without
// complaint, and a missing provider key surfaced only as a failed turn. So a member who could
// not possibly answer looked identical — in the roster and in the database — to one that works.
// You found out by summoning them and watching the turn fail.
//
// Three refusals now exist for three different situations, and keeping them apart is the point:
//   UNKNOWN_MEMBER  nobody is called that
//   NOT_IN_ROOM     they exist, but not here
//   no usable route they are here, and cannot be reached
// Each has a different remedy, so each gets its own sentence.

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
  // Any route this file added; the two seeded ones are left alone.
  await pool.query("DELETE FROM routes WHERE id LIKE 'rt_test_%'");
  await pool.end();
  await server.close();
});

describe('route records', () => {
  it('seeds exactly one hosted route per agent member, and none for a human', async () => {
    expect((await listRoutes(pool, 'claude-main')).map((r) => ({ ...r }))).toEqual([
      {
        id: 'rt_claude-main',
        member_id: 'claude-main',
        type: 'hosted',
        status: 'available',
        capabilities: ['text', 'stream'],
        data_classes: [],
        adapter_id: 'claude-main',
      },
    ]);
    // `prince` is reachable by being a person at a keyboard, which this table does not model.
    expect(await listRoutes(pool, 'prince')).toEqual([]);
  });

  it('does NOT claim a tool_call capability — no adapter carries one', async () => {
    // S06-N3 and RA-003 in a queryable form. `tool_call`'s ABSENCE is why an agent cannot
    // initiate a structured action, and recording capabilities makes that a fact rather than a
    // paragraph in a claims sheet.
    for (const m of ['claude-main', 'sol']) {
      for (const r of await listRoutes(pool, m)) {
        expect(r.capabilities).not.toContain('tool_call');
      }
    }
  });

  it('refuses a hosted route with no adapter, and a non-hosted route with one', async () => {
    await expect(
      pool.query(
        "INSERT INTO routes (id, member_id, type, adapter_id) VALUES ('rt_test_bad1', 'sol', 'hosted', NULL)",
      ),
    ).rejects.toThrow(/routes_hosted_has_adapter/);
    await expect(
      pool.query(
        "INSERT INTO routes (id, member_id, type, adapter_id) VALUES ('rt_test_bad2', 'sol', 'connected', 'sol')",
      ),
    ).rejects.toThrow(/routes_hosted_has_adapter/);
  });

  it('refuses a route for a member that does not exist', async () => {
    await expect(
      pool.query(
        "INSERT INTO routes (id, member_id, type, adapter_id) VALUES ('rt_test_ghost', 'nobody', 'hosted', 'sol')",
      ),
    ).rejects.toThrow(/foreign key/i);
  });
});

describe('selectRoute', () => {
  it('picks the only available route, and says that is why', async () => {
    const s = await selectRoute(pool, 'claude-main');
    expect(s.route?.id).toBe('rt_claude-main');
    expect(s.reason).toBe('only_available_route');
    expect(s.failed_constraint).toBeNull();
  });

  it('distinguishes NO ROUTES from ALL ROUTES UNAVAILABLE', async () => {
    // Two different facts with two different remedies: one is a configuration error — somebody
    // enrolled a member and never said how to reach them — and the other is an operational
    // state, a provider down or a key missing. Collapsing them tells an operator to check the
    // wrong thing.
    const none = await selectRoute(pool, 'prince');
    expect(none.route).toBeNull();
    expect(none.reason).toBe('no_routes_configured');
    expect(none.failed_constraint).toBe('member has no route');

    await pool.query(
      "INSERT INTO routes (id, member_id, type, status, adapter_id) VALUES ('rt_test_down', 'prince', 'hosted', 'unavailable', 'sol')",
    );
    const down = await selectRoute(pool, 'prince');
    expect(down.route).toBeNull();
    expect(down.reason).toBe('all_routes_unavailable');
    expect(down.failed_constraint).toContain('unavailable');
    await pool.query("DELETE FROM routes WHERE id = 'rt_test_down'");
  });

  it('treats a DEGRADED route as usable — a slow route is still a route', async () => {
    await pool.query(
      "INSERT INTO routes (id, member_id, type, status, adapter_id) VALUES ('rt_test_slow', 'prince', 'hosted', 'degraded', 'sol')",
    );
    const s = await selectRoute(pool, 'prince');
    expect(s.route?.id).toBe('rt_test_slow');
    expect(s.reason).toBe('only_available_route');
    await pool.query("DELETE FROM routes WHERE id = 'rt_test_slow'");
  });
});

describe('route.selected is recorded (§6.2)', () => {
  it('emits which route, for which member, and why — alongside the summon', async () => {
    const id = room('route-selected');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();

    c.send('@sol hello', 'rs-1');
    await c.waitForType('agent.turn.completed');

    const selected = c.ofType('route.selected');
    expect(selected).toHaveLength(1);
    const ev = selected[0];
    if (ev.event_type !== 'route.selected') throw new Error('narrowing');
    expect(ev.payload).toMatchObject({
      member: 'sol',
      route_id: 'rt_sol',
      route_type: 'hosted',
      reason: 'only_available_route',
    });
    // It references the summon it belongs to, so the log says how THAT ask was routed.
    expect(ev.payload.summon_id).toBe(
      (c.ofType('summon')[0] as { payload: { summon_id: string } }).payload.summon_id,
    );
    // And it names no provider — §6 survives the route becoming a record on the wire.
    expect(JSON.stringify(ev.payload)).not.toMatch(/anthropic|openai|gpt-/i);
    c.close();
  });

  it('renders NOTHING in the transcript — it is a record, not something a member said', async () => {
    // buildItems is an allowlist with no fallthrough, so a new event type cannot become an
    // agent bubble by accident. Asserted at the event level: the room received it and the
    // message list is unchanged by it.
    const id = room('route-quiet');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();
    c.send('@sol hello', 'rq-1');
    await c.waitForType('route.selected');
    // One human message, and no system notice — the route record is silent on screen.
    expect(c.bodies()).toEqual(['@sol hello']);
    c.close();
  });
});

describe('a member with no usable route', () => {
  it('is REFUSED, names the failed constraint, and no summon is written', async () => {
    // §6.2's failure rule. Never a silent downgrade and never a silent nothing: the room says
    // which constraint failed, and because no summon exists nothing downstream believes a turn
    // was asked for.
    const id = room('route-none');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    await pool.query("UPDATE routes SET status = 'unavailable' WHERE member_id = 'sol'");
    try {
      const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
      await c.open();
      c.send('@sol are you there?', 'rn-1');
      await c.waitForEvents(2);
      await new Promise((r) => setTimeout(r, 900));

      const bodies = c.bodies();
      expect(bodies[1]).toMatch(/^sol cannot be reached: every route is unavailable/);
      expect(c.ofType('summon')).toHaveLength(0);
      expect(c.ofType('route.selected')).toHaveLength(0);
      expect(c.ofType('agent.turn.started')).toHaveLength(0);
      c.close();
    } finally {
      await pool.query("UPDATE routes SET status = 'available' WHERE member_id = 'sol'");
    }
  });

  it('is a DIFFERENT sentence from not-in-room and from unknown', async () => {
    // Three situations, three remedies, three sentences. This is the assertion that stops them
    // collapsing into one unhelpful refusal as the code grows.
    const id = room('route-distinct');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    await pool.query('DELETE FROM room_members WHERE room_id = $1 AND member_id = $2', [
      id,
      'claude-main',
    ]);
    await pool.query("UPDATE routes SET status = 'unavailable' WHERE member_id = 'sol'");
    try {
      const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
      await c.open();

      c.send('@nobody', 'd-1');
      await c.waitForEvents(2);
      c.send('@claude', 'd-2');
      await new Promise((r) => setTimeout(r, 900));
      c.send('@sol', 'd-3');
      await new Promise((r) => setTimeout(r, 1200));

      // Filtered by AUTHOR, not by text. A first attempt filtered out anything starting with
      // '@' and silently dropped "@claude is not in this room." — the room's own sentence
      // begins with the token it is refusing.
      const notices = c.events
        .filter((e) => e.event_type === 'message' && e.actor_id === 'system')
        .map((e) => (e as { payload: { body: string } }).payload.body);
      expect(notices).toContain('No member of this room is called @nobody.');
      expect(notices).toContain('@claude is not in this room.');
      expect(notices.some((n) => n.startsWith('sol cannot be reached'))).toBe(true);
      expect(new Set(notices).size).toBe(3); // three distinct sentences
      c.close();
    } finally {
      await pool.query("UPDATE routes SET status = 'available' WHERE member_id = 'sol'");
    }
  });
});
