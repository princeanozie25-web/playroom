// THE DECISION LIFECYCLE, DERIVED FROM THE LOG (S2.2).
//
// A decision has no status column. Its status is a function of two events — the CO_SIGN decision, and
// its `decision.resolved` if one exists — plus the clock. That is deliberate and it is Bible §15.3:
// nothing may time out INTO an approval or a denial. A resolution is only ever an event a human wrote;
// expiry is only the ABSENCE of one past the window. So the four states are not four rows that a timer
// flips between — they are what the log already says, read the same way every time it is read.

export type DecisionStatus = 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED';

/** How long a co-signature stays open before it EXPIRES, in ms. The config default. */
const DECISION_EXPIRY_DEFAULT_MS = 24 * 60 * 60 * 1000; // 24 hours — a working day's grace, overridable.

/**
 * The co-sign window, in ms. Config default with an env override — and a malformed override is NOT the
 * default (the spend-ceiling discipline, S-LIVE): `PLAYROOM_DECISION_EXPIRY_MS=soon` must refuse
 * loudly rather than silently reverting to 24h, because a window nobody can read is a window nobody
 * set.
 */
export function decisionExpiryMs(): number {
  const raw = process.env.PLAYROOM_DECISION_EXPIRY_MS;
  if (raw === undefined || raw === '') return DECISION_EXPIRY_DEFAULT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `PLAYROOM_DECISION_EXPIRY_MS is not a positive number of milliseconds: ${JSON.stringify(raw)} — ` +
        'unset it to use the default, deliberately',
    );
  }
  return n;
}

/**
 * A decision's status, RECONSTRUCTED from its decision event and its resolution (or its absence).
 *
 * A resolution is terminal and wins over the clock — an APPROVED decision does not become EXPIRED by
 * sitting. Only an UNRESOLVED decision can expire, and only by the window passing; that is the whole
 * of "nothing times out into a resolution". `openedAtIso` is the decision event's `ts`.
 */
export function decisionStatus(
  openedAtIso: string,
  resolution: { resolution: string } | null,
  now: Date,
  expiryMs: number,
): DecisionStatus {
  if (resolution) return resolution.resolution === 'APPROVED' ? 'APPROVED' : 'DENIED';
  const openedAt = new Date(openedAtIso).getTime();
  if (now.getTime() - openedAt > expiryMs) return 'EXPIRED';
  return 'PENDING';
}

/** True once the co-sign window has passed for an UNRESOLVED decision — the approve/deny refusal gate. */
export function isExpired(openedAtIso: string, now: Date, expiryMs: number): boolean {
  return now.getTime() - new Date(openedAtIso).getTime() > expiryMs;
}

/**
 * SUGGESTED NEXT-POLL INTERVAL for a PENDING decision, in ms (SCC-3, SCC3-2 — closes SCC2-N2).
 *
 * A caller that raised a CO_SIGN learns its fate by POLLING (Playroom never calls a laptop back — no
 * webhook, no push, no socket held open to a caller; that property is what makes a connected member
 * safe, and a backoff hint does not trade it away). This is a NUMBER the caller may honour, carried in
 * the poll and the CO_SIGN response body — not a promise, not a contract, and never a connection this
 * server opens.
 *
 * ── WHY 15 SECONDS, AND NOT TWO ──
 *
 * The thing being waited on is a PERSON's signature. A two-second retry would read as machine time —
 * "this is nearly done, keep hammering" — and it is not: it is a human deciding, and the interval must
 * say so. Fifteen seconds is that honesty made a number. It is not minutes either, because the
 * interrupt reaches the signer in real time and the signature can land at any moment, so a blocked
 * caller should resume within a quarter-minute of it rather than sleep through it. The rate that falls
 * out — four polls a minute at most — sits far under the 60/min action throttle, and each poll is one
 * indexed read. A constant, deliberately: the honest interval does not change with how long the person
 * has already taken, and a decaying backoff would just make a caller that waited longest wait longer.
 */
export const DECISION_POLL_HINT_MS = 15_000;
