import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import webpush from 'web-push';
import { deleteByEndpoint, markDelivered, subscriptionsFor } from './push.js';

/**
 * THE SENDER — Playroom's first non-provider egress (S-PUSH).
 *
 * Everything outbound before this was a model call through packages/adapters: work a member was
 * summoned to do. This is different in kind — the server telling a third party THE ROOM DOES NOT
 * CONTROL that something happened here. So it carries the discipline this repo applies to spend and
 * to authority: an allowlist, a record per send INCLUDING the refusals, a throttle whose refusal is
 * also a record, and a payload that discloses the minimum.
 *
 * ── A NOTIFICATION IS A TELLING, NEVER A DOING ───────────────────────────────────────
 *
 * By the time anything here runs, the interrupt is recorded, the claim is made and the room already
 * shows it. NOTHING in this file may change any of that. `notifyPrincipal` therefore cannot throw:
 * every path returns, and a vendor that is slow, broken or hostile produces a row saying so and
 * nothing else. SCC-3's rule — a refused notification must not undo the interrupt — is enforced by
 * this function having no way to reach one.
 *
 * ── WHAT TRAVELS, AND WHAT NEVER DOES ────────────────────────────────────────────────
 *
 * Three fields: the room id, the urgency word, and a timestamp. Never the interrupt's summary, never
 * a briefing, never mandate content, never anyone's message. The notification says that something
 * needs you, in this room, now — and the room is where you find out what, behind the fabric that
 * decides who may read it.
 *
 * The URGENCY WORD IS A DELIBERATE DISCLOSURE (R3): it reaches the vendor so the notification can say
 * "blocked" rather than "something", and it is named in the send record as a disclosure rather than
 * left as a detail nobody noticed.
 */

/** What the payload carries, recorded verbatim on every send row so history cannot be rewritten. */
export const DISCLOSED_FIELDS = 'room_id, urgency(BLOCKER|DECISION), sent_at';

/**
 * THE URGENCIES THAT WAKE A PHONE. BLOCKER halts a task and DECISION is waiting on a person; FYI is
 * DEFINED as the level that does not interrupt (protocol.ts), so pushing one would contradict its own
 * meaning and teach the recipient to ignore the channel — the one failure that cannot be undone.
 */
const SENDING_URGENCIES = new Set(['BLOCKER', 'DECISION']);

/**
 * WHERE A NOTIFICATION MAY BE SENT. A closed list of the browser vendors' push services, checked by
 * ORIGIN — never by what the endpoint claims elsewhere in the URL.
 *
 * A subscription's endpoint arrives from a browser, and a browser can be lied to. Without this, a
 * crafted subscription would make this server POST to any origin its author chose, which is a
 * server-side request forgery with a governance record attached. The list is overridable by env for
 * a vendor this predates, and the DEFAULT is closed.
 */
export function allowedOrigins(): string[] {
  const configured = process.env.PLAYROOM_PUSH_ALLOWED_ORIGINS?.trim();
  if (configured)
    return configured
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
  return [
    'https://fcm.googleapis.com', // Chrome, Edge, Android
    'https://updates.push.services.mozilla.com', // Firefox
    'https://web.push.apple.com', // Safari, iOS
  ];
}

/** The origin of an endpoint, or null if it is not even a URL. Null is refused, never assumed safe. */
export function originOf(endpoint: string): string | null {
  try {
    return new URL(endpoint).origin;
  } catch {
    return null;
  }
}

/** How many sends one person may receive in the window, and why that number. */
export const THROTTLE_PER_HOUR = 20;

export type SendOutcome = 'delivered' | 'refused_endpoint' | 'refused_throttle' | 'failed' | 'gone';

async function record(
  pool: Pool,
  row: {
    principalId: string;
    roomId: string;
    interruptId: string | null;
    urgency: string;
    endpointOrigin: string;
    outcome: SendOutcome;
    detail: string | null;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO push_sends
       (id, principal_id, room_id, interrupt_id, urgency, endpoint_origin, disclosed, outcome, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      `psend_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      row.principalId,
      row.roomId,
      row.interruptId,
      row.urgency,
      row.endpointOrigin,
      DISCLOSED_FIELDS,
      row.outcome,
      row.detail,
    ],
  );
}

/** Sends to this principal inside the throttle window. The window is rolling, not a calendar hour. */
async function sendsInWindow(pool: Pool, principalId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM push_sends
      WHERE principal_id = $1 AND outcome = 'delivered' AND created_at > now() - interval '1 hour'`,
    [principalId],
  );
  return Number(rows[0].n);
}

let vapidReady: boolean | null = null;

/**
 * Configure the library once, from secrets. Returns false when the deployment has no keys, which is
 * the honest "notifications are off" state rather than an error — the raise path must behave
 * identically on a deployment that never intends to send.
 */
function vapidConfigured(): boolean {
  if (vapidReady !== null) return vapidReady;
  const publicKey = process.env.PLAYROOM_VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.PLAYROOM_VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.PLAYROOM_VAPID_SUBJECT?.trim() || 'mailto:prince@playroom.invalid';
  if (!publicKey || !privateKey) {
    vapidReady = false;
    return false;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidReady = true;
  return true;
}

/** Test seam: forget the cached configuration so a test can toggle the env between cases. */
export function resetVapidForTests(): void {
  vapidReady = null;
}

export interface NotifyInput {
  principalId: string;
  roomId: string;
  interruptId: string | null;
  urgency: string;
}

/**
 * Tell one person that something needs them. NEVER THROWS, never returns anything the caller acts
 * on — the interrupt it follows is already committed, and this function's only outputs are rows in
 * `push_sends` and, at most, a buzz on a phone.
 */
export async function notifyPrincipal(
  pool: Pool,
  input: NotifyInput,
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void },
): Promise<void> {
  try {
    // FYI never sends. No record either: nothing was attempted, and a row would imply something was.
    if (!SENDING_URGENCIES.has(input.urgency)) return;
    if (!vapidConfigured()) return;

    const subs = await subscriptionsFor(pool, input.principalId);
    if (subs.length === 0) return;

    // THE THROTTLE, RECORDED. One row for the refusal — not one per subscription, because the thing
    // being refused is the claim on this person, not each address it would have reached.
    if ((await sendsInWindow(pool, input.principalId)) >= THROTTLE_PER_HOUR) {
      await record(pool, {
        principalId: input.principalId,
        roomId: input.roomId,
        interruptId: input.interruptId,
        urgency: input.urgency,
        endpointOrigin: '(throttled before any endpoint was chosen)',
        outcome: 'refused_throttle',
        detail: `more than ${THROTTLE_PER_HOUR} delivered in the last hour`,
      });
      log?.warn(
        { principal: input.principalId, limit: THROTTLE_PER_HOUR },
        'push refused: this person has been told enough this hour',
      );
      return;
    }

    // The payload. Built here and nowhere else, so there is one place to read to know what leaves.
    const payload = JSON.stringify({
      room: input.roomId,
      urgency: input.urgency,
      at: new Date().toISOString(),
    });

    for (const sub of subs) {
      const origin = originOf(sub.endpoint);
      if (origin === null || !allowedOrigins().includes(origin)) {
        // REFUSED BEFORE THE SEND, and recorded as a refusal. A crafted endpoint is the SSRF this
        // list exists to stop, and a silent skip would leave no evidence it was attempted.
        await record(pool, {
          principalId: input.principalId,
          roomId: input.roomId,
          interruptId: input.interruptId,
          urgency: input.urgency,
          endpointOrigin: origin ?? '(unparseable)',
          outcome: 'refused_endpoint',
          detail: 'origin is not on the push allowlist',
        });
        log?.warn(
          { principal: input.principalId, origin: origin ?? '(unparseable)' },
          'push refused: endpoint origin is not allowed',
        );
        continue;
      }

      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          { TTL: 3600, urgency: input.urgency === 'BLOCKER' ? 'high' : 'normal' },
        );
        await record(pool, {
          principalId: input.principalId,
          roomId: input.roomId,
          interruptId: input.interruptId,
          urgency: input.urgency,
          endpointOrigin: origin,
          outcome: 'delivered',
          detail: null,
        });
        await markDelivered(pool, sub.id);
      } catch (err) {
        // Read the status off the error SHAPE rather than an instanceof: the class travels through
        // the default export too, and a duck-typed read cannot break the way the named import did.
        const status =
          typeof (err as { statusCode?: unknown })?.statusCode === 'number'
            ? (err as { statusCode: number }).statusCode
            : 0;
        // 404/410 is the vendor saying this subscription no longer exists (RFC 8030) — the ONLY
        // reliable signal, so it is the only moment the row is honestly removable.
        const gone = status === 404 || status === 410;
        if (gone) await deleteByEndpoint(pool, sub.endpoint);
        await record(pool, {
          principalId: input.principalId,
          roomId: input.roomId,
          interruptId: input.interruptId,
          urgency: input.urgency,
          endpointOrigin: origin,
          outcome: gone ? 'gone' : 'failed',
          // THE STATUS CODE AND NOTHING ELSE. A vendor's error body can echo the request, which
          // means it can contain the endpoint or the encrypted payload; putting it in a row or a log
          // would defeat every other precaution in this file (S-SCRUB).
          detail: status ? `vendor status ${status}` : 'vendor unreachable',
        });
        log?.warn(
          { principal: input.principalId, origin, status },
          gone ? 'push subscription is gone; address deleted' : 'push send failed',
        );
      }
    }
  } catch (err) {
    // THE LAST GUARD. Anything unforeseen — a pool error, a bad row — dies here rather than reaching
    // the raise path that called it. `err.name` only: an error's message can carry a query, and a
    // query here carries an endpoint.
    log?.warn(
      { principal: input.principalId, error_class: err instanceof Error ? err.name : 'Error' },
      'push send path failed; the interrupt is unaffected',
    );
  }
}
