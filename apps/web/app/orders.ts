import { viewerCredential } from './session';

// THE ORDERS OF A ROOM, FETCHED FROM THE API — no filesystem, no fabric, same discipline as roster.ts.
//
// The loops screen reads this server-side (the room page pattern), so the credential stays in the web
// tier's process and never reaches a browser. Every field is a record or an event fact: status, the
// terms, the counts, the pause reason from the standing_orders projection; last_fired reconstructed
// from the order.cycled log by the API. Nothing here is invented — a chip that showed an order the log
// did not produce is the one thing this surface may not become, exactly as the roster rule says.

export interface OrderView {
  id: string;
  creator_member_id: string;
  trigger_event_type: string;
  trigger_member_id: string;
  action_member_id: string;
  max_cycles: number | null;
  max_unattended_cycles: number;
  expires_at: string | null;
  cycle_count: number;
  unattended_count: number;
  status: string;
  pause_reason: string | null;
  last_fired: string | null;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

/**
 * The room's standing orders, newest config first.
 *
 * A FAILURE HERE IS NOT SWALLOWED (roster.ts's rule): if the API is unreachable the screen fails to
 * render rather than showing an empty list, which would read as "no orders" when the truth is "could
 * not ask" — RT-001's shape at the page level. An empty ARRAY, by contrast, is the honest empty state
 * the screen renders as "no standing orders yet".
 */
export interface OrdersView {
  orders: OrderView[];
  /** Who is asking, resolved by the API from the credential — for rendering authorisation as truth. */
  viewer: { member_id: string; kind: 'human' | 'agent' };
}

export async function loadOrders(roomId: string): Promise<OrdersView> {
  const token = (await viewerCredential())?.token ?? '';
  const res = await fetch(`${API_URL}/rooms/${encodeURIComponent(roomId)}/orders`, {
    cache: 'no-store',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`GET /rooms/${roomId}/orders failed: ${res.status}`);
  const body: unknown = await res.json();
  if (typeof body !== 'object' || body === null || !Array.isArray((body as never)['orders'])) {
    throw new Error('GET /orders returned no orders array');
  }
  return body as OrdersView;
}

/**
 * Forward an order mutation to the API AS THE VIEWER — the credential held server-side, never in the
 * browser. The web route handlers the client form calls are thin wrappers over this: the same proxy
 * shape as app/api/rooms, but the VIEWER'S credential rather than the deployment's, because who
 * creates or edits an order is the creator-only/human-only question the API command enforces, and
 * forwarding the deployment token would ask it about the wrong member. The API's status and body pass
 * through unchanged — a refusal invented here would be a second contract for the same failure.
 */
export async function forwardOrderMutation(
  path: string,
  method: string,
  body: unknown,
): Promise<{ status: number; payload: unknown }> {
  const token = (await viewerCredential())?.token ?? '';
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
    cache: 'no-store',
  });
  const payload: unknown = await res
    .json()
    .catch(() => ({ type: 'error', code: 'api_no_answer', message: 'the api did not answer' }));
  return { status: res.status, payload };
}
