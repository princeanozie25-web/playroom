import { afterAll, describe, expect, it } from 'vitest';
import { testPool } from './support.js';
import { listRoutes, selectRoute } from '../src/routes.js';

// ROUTES: HOW A MEMBER IS REACHABLE (Bible §6.1, §6.2).
//
// A member record says a member EXISTS. Before S1.1c nothing said whether they were REACHABLE,
// and the gap was not theoretical: `getAdapterConfig` returns a disabled adapter without
// complaint, and a missing provider key surfaced only as a failed turn. So a member who could
// not possibly answer looked identical — in the roster and in the database — to one that works.
// You found out by summoning them and watching the turn fail.

const pool = testPool();

afterAll(async () => {
  // Only routes this file added; the two seeded ones are left alone.
  await pool.query("DELETE FROM routes WHERE id LIKE 'rt_test_%'");
  await pool.end();
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
