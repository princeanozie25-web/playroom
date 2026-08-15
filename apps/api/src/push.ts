import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

/**
 * PUSH SUBSCRIPTIONS — the set of places this server may send a notification (S-PUSH).
 *
 * ── THERE IS NO PARAMETER FOR WHOSE ──────────────────────────────────────────────────
 *
 * Every function here takes the principal it is acting for, and that value comes from the
 * AUTHENTICATED credential at the route, never from a request body. A caller cannot register a
 * subscription against someone else's principal or read someone else's addresses, because there is
 * nowhere to put the request — the same construction §7.1's assembly uses for private stores, and
 * the same reason UI3-1 made an order's wiring immutable by having no field for it.
 *
 * ── THE KEY MATERIAL NEVER COMES BACK OUT ────────────────────────────────────────────
 *
 * `p256dh` and `auth` are the browser's own RFC 8291 encryption material. They go in on subscribe
 * and are read ONLY by the sender. No function here returns them, so no route can leak them by
 * forgetting to strip a field — `countFor` answers "is this thing on" with a number, which is the
 * whole of what a person needs to see.
 */

export interface PushSubscriptionRow {
  id: string;
  principal_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Register a browser, or refresh the one that already claims this endpoint.
 *
 * UPSERT ON THE ENDPOINT, because the endpoint IS the browser: a permission re-grant or a vendor
 * rotation produces the same URL with fresh keys, and inserting a second row would send that phone
 * two of every notification. The principal is overwritten too — deliberately: if a different person
 * signs in on the same browser and subscribes, the address now belongs to them, and the row that
 * says otherwise would send this person's claims to that one.
 */
export async function upsertSubscription(
  pool: Pool,
  input: {
    principalId: string;
    memberId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
  },
): Promise<PushSubscriptionRow> {
  const { rows } = await pool.query<PushSubscriptionRow>(
    `INSERT INTO push_subscriptions (id, principal_id, endpoint, p256dh, auth, created_by_member)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (endpoint) DO UPDATE
       SET principal_id = EXCLUDED.principal_id,
           p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           created_by_member = EXCLUDED.created_by_member
     RETURNING id, principal_id, endpoint, p256dh, auth`,
    [
      `push_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      input.principalId,
      input.endpoint,
      input.p256dh,
      input.auth,
      input.memberId,
    ],
  );
  return rows[0];
}

/**
 * Turn it off — and OFF MEANS DELETED, not flagged.
 *
 * Scoped to the principal, so one person cannot unsubscribe another's browser by knowing its
 * endpoint. Returns whether a row went, so the caller can tell "turned off" from "was not on".
 */
export async function deleteSubscription(
  pool: Pool,
  principalId: string,
  endpoint: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    'DELETE FROM push_subscriptions WHERE principal_id = $1 AND endpoint = $2',
    [principalId, endpoint],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Every live address for this person. THE SENDER'S ONLY LOOKUP, and the only function that returns
 * key material — which is why it takes a principal and not a filter.
 */
export async function subscriptionsFor(
  pool: Pool,
  principalId: string,
): Promise<PushSubscriptionRow[]> {
  const { rows } = await pool.query<PushSubscriptionRow>(
    `SELECT id, principal_id, endpoint, p256dh, auth FROM push_subscriptions
      WHERE principal_id = $1 ORDER BY created_at`,
    [principalId],
  );
  return rows;
}

/** How many browsers this person has turned on. The honest answer to "is this thing on". */
export async function countFor(pool: Pool, principalId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    'SELECT count(*) AS n FROM push_subscriptions WHERE principal_id = $1',
    [principalId],
  );
  return Number(rows[0].n);
}

/**
 * Forget an address the VENDOR has told us is dead (404/410, RFC 8030) — the only reliable signal
 * that a subscription no longer exists, and therefore the only moment it can honestly be removed.
 *
 * NOT scoped to a principal: this is the sender acting on the vendor's word, not a person acting on
 * their own row, and the endpoint is unique. A dead address that lingers is a delivery someone
 * believes in that does not exist.
 */
export async function deleteByEndpoint(pool: Pool, endpoint: string): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [
    endpoint,
  ]);
  return (rowCount ?? 0) > 0;
}

/** The vendor accepted a send. Diagnostic only — nothing branches on it. */
export async function markDelivered(pool: Pool, id: string): Promise<void> {
  await pool.query('UPDATE push_subscriptions SET last_ok_at = now() WHERE id = $1', [id]);
}
