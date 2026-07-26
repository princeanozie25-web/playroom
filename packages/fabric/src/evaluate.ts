import type { LoadedMandate } from './mandate.js';

// Mandate evaluation. Bible §9.2, minus the branches whose inputs do not exist yet.
//
// PURE. No I/O, no clock beyond the `now` passed in, no logging, no throwing. The
// caller logs (Bible §9.2: "every outcome is audited with the mandate hash") and the
// caller emits the decision event. Keeping this function pure is what makes the
// 12-case table a table rather than a set of integration tests, and it is why the
// measured P50 is microseconds against the Bible §11 budget of <10 ms.

export type Decision = 'ALLOW' | 'CO_SIGN' | 'BLOCK';

/**
 * Reason codes. SCREAMING_SNAKE per Bible §9.3's example (`PROTECTED_ACTION`).
 *
 * An OPEN string on the wire (see CONTRIBUTING: closed unions for what you dispatch
 * on, open strings for what will grow) — but a closed union HERE, inside the
 * evaluator, because this is precisely the place that dispatches on it and controls
 * both ends. S2.1 adds `REPLAY`, `ROSTER_VIOLATION`, `LIMIT_EXCEEDED`,
 * `SIGNATURE_INVALID`.
 */
export type ReasonCode =
  'ALLOWED_IN_SCOPE' | 'NO_MANDATE' | 'MANDATE_EXPIRED' | 'OUT_OF_SCOPE' | 'PROTECTED_ACTION';

export interface ActionRequest {
  /** Action type, e.g. `pr.review`, `pr.merge`. Matched against scope exactly. */
  type: string;
  /** What the action is against, e.g. `repo:playroom/playroom#pr-41`. */
  resource: string;
}

export interface Verdict {
  decision: Decision;
  reason_code: ReasonCode;
  /** Set only when a human must co-sign; null otherwise. Never a guess. */
  required_signer: string | null;
  /** The hash of the mandate this verdict was reached under; null when there was none. */
  effective_mandate_hash: string | null;
  policy_version: string | null;
}

/**
 * Evaluate one action for one member against that member's mandate.
 *
 * Order is Bible §9.2's, minus replay protection (S2.1 — it needs the decisions table
 * and a nonce, neither of which exists), minus the `counterparties` branch (needs a
 * roster — S1.1) and minus `breaches_limits` (needs usage counters — S2.7). Those three
 * are ABSENT rather than stubbed as always-pass: a branch that always returns "fine" is
 * indistinguishable from an enforced one in a test and in a demo, which is the RT-001
 * mistake at the policy layer. Their position in the order is held by the comments below
 * so S2.1 inserts rather than reorders.
 *
 * @param mandate the member's mandate, or `undefined` if they have none
 */
export function evaluate(
  action: ActionRequest,
  member: string,
  mandate: LoadedMandate | undefined,
  now: Date = new Date(),
): Verdict {
  // A member with no mandate has no authority. Not "default authority", not "ask a
  // human" — none. This is the deny-by-default line at its bluntest (Bible §10).
  if (!mandate) {
    return {
      decision: 'BLOCK',
      reason_code: 'NO_MANDATE',
      required_signer: null,
      effective_mandate_hash: null,
      policy_version: null,
    };
  }

  const { mandate: m, hash } = mandate;
  const base = { effective_mandate_hash: hash, policy_version: m.policy_version };

  // A mandate held by someone else grants this member nothing. Loading is keyed by
  // member so this should be unreachable — which is exactly why it is checked, rather
  // than trusted to a Map lookup that a later refactor could widen.
  if (m.member !== member) {
    return { decision: 'BLOCK', reason_code: 'NO_MANDATE', required_signer: null, ...base };
  }

  // 1. Expiry. (S2.1 adds `|| !sig_valid()` here, once mandates are signed.)
  if (new Date(m.expires).getTime() <= now.getTime()) {
    return { decision: 'BLOCK', reason_code: 'MANDATE_EXPIRED', required_signer: null, ...base };
  }

  // 2. Scope. THE DENY-BY-DEFAULT LINE, and the single most important branch in this
  // function: an action type that is not explicitly listed is BLOCKED. An unknown
  // action is denied, never permitted by omission (Bible §10). Note this is checked
  // BEFORE protected_actions, so a protected action absent from scope is a BLOCK and
  // not a CO_SIGN — the order matters and it is the Bible's.
  if (!m.scope.includes(action.type)) {
    return { decision: 'BLOCK', reason_code: 'OUT_OF_SCOPE', required_signer: null, ...base };
  }

  // 3. (S2.1) replay protection — `if replayed(nonce, resource_hash) return BLOCK`.

  // 4. Protected actions pause for a human. The signer comes from the mandate's own
  // co_sign block, never from a default: `by: "principal"` resolves to the mandate's
  // principal, which is the person who granted the authority in the first place.
  if (m.protected_actions.includes(action.type)) {
    return {
      decision: 'CO_SIGN',
      reason_code: 'PROTECTED_ACTION',
      required_signer: m.co_sign.by === 'principal' ? m.principal : m.co_sign.by,
      ...base,
    };
  }

  // 5. (S1.1) counterparties — `roster_only` needs a roster to check against.
  // 6. (S2.7) limits — needs per-day usage counters.

  return { decision: 'ALLOW', reason_code: 'ALLOWED_IN_SCOPE', required_signer: null, ...base };
}
