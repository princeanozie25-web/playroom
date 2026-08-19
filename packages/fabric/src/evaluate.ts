import type { LoadedMandate, Mandate } from './mandate.js';

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
 * both ends. S2.1 adds `SIGNATURE_INVALID` (now present, below); C1 adds the two host-gate codes
 * (`RESOURCE_OUT_OF_SCOPE`, `SHELL_NOT_ALLOWLISTED`); `REPLAY` and `LIMIT_EXCEEDED` stay reserved for
 * replay protection and S2.7 limits.
 */
export type ReasonCode =
  | 'ALLOWED_IN_SCOPE'
  | 'NO_MANDATE'
  | 'SIGNATURE_INVALID'
  | 'MANDATE_EXPIRED'
  | 'OUT_OF_SCOPE'
  | 'ROSTER_VIOLATION'
  | 'PROTECTED_ACTION'
  // C1 — the execution gate. A host op whose TYPE the mandate grants, but whose RESOURCE matched no
  // allowed pattern: a write outside the workspace, a push to an ungranted ref. BLOCK (fs/git confinement).
  | 'RESOURCE_OUT_OF_SCOPE'
  // C1 — a `shell.*` command the mandate grants the member to run, but which matched no allowlist pattern.
  // CO_SIGN, not BLOCK: allowlist + co-sign the rest (Prince's ruling) — never a raw shell, but not a wall.
  | 'SHELL_NOT_ALLOWLISTED'
  // C3 — a host grant matched the resource but a fact it `requires` did not hold (e.g. tests have not passed).
  // BLOCK, distinct from a scope refusal: it means "not yet", not "never" — the condition, not the authority.
  | 'CONDITION_UNMET';

export interface ActionRequest {
  /** Action type. An ABSTRACT action (`pr.review`, `pr.merge`) matched against `scope` by type; OR a HOST op
   *  (`fs.*` / `git.*` / `shell.*`) routed to the execution gate and matched against the mandate's host policy. */
  type: string;
  /** What the action is against. For an abstract action, an opaque resource like `repo:...#pr-41` (matched by
   *  nothing today). For a HOST op, the target the gate globs against the mandate's host policy: a
   *  workspace-relative POSIX path (`fs.*`), a git ref (`git.*`), or the exact command line (`shell.*`). */
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
 * Order is Bible §9.2's, minus replay protection (S2.1 — it needs the decisions table and a
 * nonce, neither of which exists) and minus `breaches_limits` (needs usage counters — S2.7).
 * Those two are ABSENT rather than stubbed as always-pass: a branch that always returns
 * "fine" is indistinguishable from an enforced one in a test and in a demo, which is the
 * RT-001 mistake at the policy layer. Their position is held by the comments below so S2.1
 * inserts rather than reorders.
 *
 * S2.1 ALSO added position 0 — authenticity (`sig_valid`) — ahead of every branch below,
 * because expiry, scope, roster and protection are all fields of a document whose signature
 * must verify before a single one of them can be believed. See §0.
 *
 * `counterparties` was the third of those until S1.1b gave rooms a roster — see branch 3.
 *
 * ── THE ORDER IS NOT ARBITRARY (RA-007) ──
 *
 * ESTABLISH STANDING BEFORE EVALUATING THE REQUEST. Expiry, scope and roster all answer
 * *may this member act here at all*; protection and limits answer *what does this particular
 * action need*. NEVER ASK A HUMAN TO APPROVE SOMETHING THAT SHOULD HAVE BEEN REFUSED
 * OUTRIGHT.
 *
 * That is why scope precedes protected — a protected action absent from scope is BLOCK, not
 * CO_SIGN — and, from S1.1c, why the roster check precedes it too. `counterparties` sat at
 * position 5 in Bible §9.2, behind protected actions, which meant a protected action asked
 * for a member who was not in the room returned CO_SIGN: a human invited to sign for an
 * absent member, on the surface that carries the most credibility in the product. Fail-closed
 * and the wrong question.
 *
 * A later slice reordering these branches should reread the principle, not the numbers.
 *
 * @param mandate the member's mandate, or `undefined` if they have none
 * @param roomRoster the ids of the members enrolled in the room the action was requested in,
 *   or `undefined` when the caller has no room context. Undefined means the
 *   `counterparties` branch cannot be evaluated and is SKIPPED — see the branch for why
 *   that is not a hole.
 */
// ── THE EXECUTION GATE (C1, ADR-012) ────────────────────────────────────────────────────────────
//
// A host operation lives in a fixed namespace — `fs.*`, `git.*`, `shell.*` — so it is recognisable from
// its type alone, without a registry. An abstract action (`pr.merge`, `deploy`, `summon.initiate`) is
// none of these and takes the type-level `scope` path unchanged.
const HOST_ACTION_PREFIXES = ['fs.', 'git.', 'shell.'] as const;
function isHostAction(type: string): boolean {
  return HOST_ACTION_PREFIXES.some((p) => type.startsWith(p));
}

/** One host grant entry — a resource pattern for an action, optionally gated on facts (C3). */
type HostGrant = { action: string; resource: string; requires?: readonly string[] };

/**
 * Glob-match a host resource against a mandate pattern. `**` matches any run of characters INCLUDING `/`;
 * `*` matches within a single path segment (never `/`); every other character is literal. Anchored — the
 * whole resource must match. Pure, and compiled per call: a mandate carries a handful of patterns, so this
 * stays microseconds, inside the §11 budget. The resource conventions (workspace-relative paths, git refs,
 * exact command lines) are the caller's contract; the evaluator only matches strings.
 */
function matchResourceGlob(resource: string, pattern: string): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 1;
      } else {
        re += '[^/]*';
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      re += `\\${c}`; // escape a regex metacharacter so it matches literally
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`).test(resource);
}

/**
 * Resolve a host op against the mandate's resource-scoped policy — the whole of C1's new authority logic.
 * Standing (authenticity, expiry, roster) is already established by the caller; this answers only *what
 * does this particular host op need*. Deny-by-default holds at the host layer exactly as at the abstract
 * one: a type the mandate grants NOWHERE is OUT_OF_SCOPE. A protected pattern outranks an allowed one (a
 * member may push, but a push to `main` still pauses). An unmatched resource under a granted type is
 * BLOCKED for `fs.*`/`git.*` (confinement) but ESCALATED to a human for `shell.*` (Prince's ruling:
 * allowlist + co-sign the rest). The gate DECIDES; it never runs anything (RT-005 preserved — a Local
 * Node executes only on ALLOW).
 */
function evaluateHostOp(
  action: ActionRequest,
  m: Mandate,
  facts: readonly string[],
  base: { effective_mandate_hash: string | null; policy_version: string | null },
): Verdict {
  const signer = m.co_sign.by === 'principal' ? m.principal : m.co_sign.by;
  const grants = (m.host_scope ?? []).filter((g) => g.action === action.type);
  const protectedGrants = (m.host_protected ?? []).filter((g) => g.action === action.type);

  // Deny-by-default: the mandate grants this host action nowhere. An unlisted power is not a granted one.
  if (grants.length === 0 && protectedGrants.length === 0) {
    return { decision: 'BLOCK', reason_code: 'OUT_OF_SCOPE', required_signer: null, ...base };
  }

  const resourceMatches = (g: HostGrant) => matchResourceGlob(action.resource, g.resource);
  // C3: a grant APPLIES only when its resource matches AND every fact it `requires` holds. The caller
  // assembled `facts` from the event log; here it is a pure membership test, so the evaluator stays pure.
  const factsMet = (g: HostGrant) => (g.requires ?? []).every((k) => facts.includes(k));
  const applies = (g: HostGrant) => resourceMatches(g) && factsMet(g);

  // Protected resource wins over an allowed one — checked first, so a push to a protected ref co-signs even
  // when a broader `host_scope` pattern would also have matched it.
  if (protectedGrants.some(applies)) {
    return {
      decision: 'CO_SIGN',
      reason_code: 'PROTECTED_ACTION',
      required_signer: signer,
      ...base,
    };
  }
  // C3: a PROTECTED pattern that matched the resource but whose required facts are unmet GATES here — BEFORE a
  // broader `host_scope` grant could ALLOW the same resource. Protection outranks scope even when its condition
  // reads "not yet" (line 170-171 extended to the temporal case): the push to `main` waits for tests, it must
  // not fall through to an overlapping `refs/heads/*`. Without this, an unconditional scope grant that also
  // covers the protected resource silently steals ALLOW — the push lands with neither the tests nor the co-sign.
  if (protectedGrants.some((g) => resourceMatches(g) && !factsMet(g))) {
    return { decision: 'BLOCK', reason_code: 'CONDITION_UNMET', required_signer: null, ...base };
  }
  if (grants.some(applies)) {
    return { decision: 'ALLOW', reason_code: 'ALLOWED_IN_SCOPE', required_signer: null, ...base };
  }

  // C3: nothing applied. If a grant matched the RESOURCE but its facts were unmet, the only barrier is the
  // temporal condition — say so, so the caller (and a human) can read "not yet" rather than "never". This is
  // the Drift rail: a push to a protected ref granted `requires: [tests_passed]` reads CONDITION_UNMET until
  // the fact holds, then resolves to its underlying verdict (here, CO_SIGN).
  const resourceMatchedButUnmet = [...grants, ...protectedGrants].some(
    (g) => resourceMatches(g) && !factsMet(g),
  );
  if (resourceMatchedButUnmet) {
    return { decision: 'BLOCK', reason_code: 'CONDITION_UNMET', required_signer: null, ...base };
  }

  // Granted type, resource matched no grant at all. A shell command off the allowlist goes to a human rather
  // than being refused outright; anything else (a write, a push) confined to its patterns is blocked outside.
  if (action.type.startsWith('shell.')) {
    return {
      decision: 'CO_SIGN',
      reason_code: 'SHELL_NOT_ALLOWLISTED',
      required_signer: signer,
      ...base,
    };
  }
  return {
    decision: 'BLOCK',
    reason_code: 'RESOURCE_OUT_OF_SCOPE',
    required_signer: null,
    ...base,
  };
}

export function evaluate(
  action: ActionRequest,
  member: string,
  mandate: LoadedMandate | undefined,
  now: Date = new Date(),
  roomRoster?: readonly string[],
  // C3 (ADR-014): the TRUE facts the caller assembled from history ("tests_passed", ...). A host grant's
  // `requires` is satisfied only by a key present here. Absent/empty means no temporal condition can be met,
  // so a conditional grant BLOCKs — deny-by-default extends to conditions. Every other branch ignores it.
  facts: readonly string[] = [],
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

  // 0. AUTHENTICITY — the root question, asked before anything the document merely CLAIMS. A
  //    mandate whose signature does not verify against the trust root (mandate.ts) is not a
  //    mandate: it is a JSON file asserting authority without the key that confers it, and its
  //    member, scope, expiry and principal are untrustworthy in the same breath. It is refused
  //    ahead of standing (expiry/scope/roster) and ahead of the request (protected/limits) for
  //    the same RA-007 reason scope precedes protection: never let an unauthentic document reach
  //    a branch that could ALLOW or CO_SIGN. The hash is still surfaced — it names WHICH document
  //    was rejected, without trusting a word inside it. Bible §4.1, §9.2 (first branch).
  if (!mandate.sig_valid) {
    return { decision: 'BLOCK', reason_code: 'SIGNATURE_INVALID', required_signer: null, ...base };
  }

  // A mandate held by someone else grants this member nothing. Loading is keyed by
  // member so this should be unreachable — which is exactly why it is checked, rather
  // than trusted to a Map lookup that a later refactor could widen.
  if (m.member !== member) {
    return { decision: 'BLOCK', reason_code: 'NO_MANDATE', required_signer: null, ...base };
  }

  // 1. Expiry. (Authenticity — `sig_valid` — is checked above at §0, ahead of expiry: a forged
  //    mandate must never be judged on, or saved by, the expiry it claims for itself.)
  if (new Date(m.expires).getTime() <= now.getTime()) {
    return { decision: 'BLOCK', reason_code: 'MANDATE_EXPIRED', required_signer: null, ...base };
  }

  // 2. Scope. THE DENY-BY-DEFAULT LINE, and the single most important branch in this
  // function: an action type that is not explicitly listed is BLOCKED. An unknown
  // action is denied, never granted by omission (Bible §10). Note this is checked
  // BEFORE protected_actions, so a protected action absent from scope is a BLOCK and
  // not a CO_SIGN — the order matters and it is the Bible's.
  //
  // HOST OPS SKIP THIS LINE (C1): `fs.*`/`git.*`/`shell.*` are not granted through the type-level `scope`
  // array but through the resource-scoped host policy, resolved at branch 2b below. Their own
  // deny-by-default (a type granted nowhere in `host_scope`/`host_protected`) lives there, so an unlisted
  // host op is refused just as firmly — the guard here only routes it to the branch that can judge its
  // resource, never past a check.
  if (!isHostAction(action.type) && !m.scope.includes(action.type)) {
    return { decision: 'BLOCK', reason_code: 'OUT_OF_SCOPE', required_signer: null, ...base };
  }

  // 3. COUNTERPARTIES — a STANDING question, and therefore checked BEFORE protected
  // actions (RA-007). `roster_only` means this member may only deal with the room's own
  // members — and until S1.1b there was no roster, so this branch was NEVER WRITTEN. Not
  // dead code, not a branch that always passed: absent, with a comment holding its place.
  // The field sat in both mandate documents claiming a restriction nothing could enforce,
  // which is `room.post`'s shape inside an authority document rather than beside one.
  //
  // What it can check TODAY is the acting member: an action requested under a member's
  // mandate, in a room that member is not enrolled in, is refused. That is the party this
  // evaluator actually knows about.
  //
  // THE OTHER HALF IS STILL ABSENT AND IS NOT FAKED. Bible §9.2 phrases the branch as
  // `action.target not in room.roster`, and no action carries a target — `ActionRequest` is
  // a type and a resource, and `pr.merge` on a repository names no member. Checking a target
  // that never exists would be a branch that always passes, which is the thing this file
  // refuses to ship. When actions gain counterparties, the check extends here.
  //
  // Skipped when `roomRoster` is undefined: a caller with no room context cannot be told
  // whether the member is in a room, and inventing a verdict from an absent input is worse
  // than deferring to the branches that do have theirs. Every production caller passes one.
  if (m.counterparties === 'roster_only' && roomRoster !== undefined) {
    if (!roomRoster.includes(member)) {
      return { decision: 'BLOCK', reason_code: 'ROSTER_VIOLATION', required_signer: null, ...base };
    }
  }

  // 2b. THE EXECUTION GATE (C1, ADR-012). A host file/git/shell op is resource-scoped: it matches
  //     `action.resource` against the mandate's host policy rather than its `type` against `scope`. Placed
  //     AFTER standing (authenticity §0, expiry §1, roster §3) so RA-007 holds — a member not in the room,
  //     or under a forged or expired mandate, is refused before we ever ask what a host op would need. The
  //     gate only decides; nothing here executes (RT-005), which is why closing invariant #7 end-to-end
  //     also needs the Local Node (C2) that runs an op only on this ALLOW and holds its revocable lease.
  if (isHostAction(action.type)) {
    return evaluateHostOp(action, m, facts, base);
  }

  // 4. (S2.1) replay protection — `if replayed(nonce, resource_hash) return BLOCK`.

  // 5. Protected actions pause for a human. The signer comes from the mandate's own
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

  // 6. (S2.7) limits — needs per-day usage counters.

  return { decision: 'ALLOW', reason_code: 'ALLOWED_IN_SCOPE', required_signer: null, ...base };
}
