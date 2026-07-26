import type { Pool } from 'pg';

/**
 * ROUTE SELECTION (Bible §6.1, §6.2).
 *
 * A member record says a member EXISTS. A route says they are REACHABLE. Before S1.1c nothing
 * could tell those apart: `getAdapterConfig` returns a disabled adapter without complaint, a
 * missing provider key surfaced only as a failed turn, and so a member who could not possibly
 * answer looked identical to one that works — you found out by summoning them and watching the
 * turn fail.
 *
 * NO RANKING, NO PREFERENCE, NO FAILOVER. Every member has exactly one route today, so
 * selection is not a decision, and a selector built before there is a choice is the pattern
 * this project has avoided four times over. What is built is the SEAM and the RECORD: the
 * structure holds more than one route, the logic picks the only available one, and the reason
 * it records says exactly that. When a second route exists, the reason stops being trivial and
 * nothing else has to move.
 */

export interface RouteRecord {
  id: string;
  member_id: string;
  type: 'hosted' | 'connected' | 'bridged';
  status: 'available' | 'degraded' | 'unavailable';
  capabilities: string[];
  /** INERT. Structure for S1.5; no context assembly consults it. See migration 009. */
  data_classes: string[];
  adapter_id: string | null;
}

/**
 * Why a route was chosen, or why none could be.
 *
 * `reason` is carried into the `route.selected` event. With one route it is trivially
 * `only_available_route` — that is honest, and the value is the record rather than the
 * sophistication. A trivial reason written down beats a sophisticated one inferred.
 */
export type RouteReason =
  'only_available_route' | 'no_routes_configured' | 'all_routes_unavailable';

export interface RouteSelection {
  route: RouteRecord | null;
  reason: RouteReason;
  /**
   * The constraint that failed, for §6.2's failure rule: a task with no usable route goes to
   * `input-required` and NAMES the failed constraint. Null when a route was found.
   */
  failed_constraint: string | null;
}

export async function listRoutes(pool: Pool, memberId: string): Promise<RouteRecord[]> {
  const { rows } = await pool.query<RouteRecord>(
    `SELECT id, member_id, type, status, capabilities, data_classes, adapter_id
       FROM routes WHERE member_id = $1 ORDER BY id`,
    [memberId],
  );
  return rows;
}

/**
 * Choose the route a summon will run on.
 *
 * Two distinct failures, and they are NOT the same fact:
 *
 *   `no_routes_configured`    the member exists and has no route at all. A configuration
 *                             error — somebody enrolled a member and never said how to reach
 *                             them.
 *   `all_routes_unavailable`  routes exist and every one is unusable. An operational state —
 *                             a provider is down, a key is missing, a bridge is disconnected.
 *
 * Collapsing them would tell an operator to check the wrong thing, which is the same reason
 * `NOT_IN_ROOM` is not `UNKNOWN_MEMBER`. `degraded` still counts as usable: a slow route is a
 * route, and refusing to use it would be worse than the degradation.
 */
export async function selectRoute(pool: Pool, memberId: string): Promise<RouteSelection> {
  const routes = await listRoutes(pool, memberId);

  if (routes.length === 0) {
    return {
      route: null,
      reason: 'no_routes_configured',
      failed_constraint: 'member has no route',
    };
  }

  const usable = routes.filter((r) => r.status !== 'unavailable');
  if (usable.length === 0) {
    return {
      route: null,
      reason: 'all_routes_unavailable',
      failed_constraint: `every route is unavailable (${routes.map((r) => r.type).join(', ')})`,
    };
  }

  // The only available one. Not a preference — there is nothing to prefer between.
  return { route: usable[0], reason: 'only_available_route', failed_constraint: null };
}
