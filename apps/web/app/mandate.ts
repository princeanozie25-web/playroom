// PURE, AND CLIENT-SAFE. No `node:` imports, no filesystem, nothing that cannot be bundled.
//
// These functions live here rather than in roster.ts because roster.ts is SERVER ONLY — it
// reads adapters.yaml and pulls in @playroom/fabric, which reaches node:crypto. Importing a
// VALUE from it into a component broke the production build immediately:
//
//   Module build failed: Reading from "node:crypto" is not handled by plugins
//
// The previous `import type { RosterMember }` was type-only and erased at compile time, so
// the boundary held by accident. `pnpm typecheck` passed; only `next build` failed. Recorded
// as UI2-N2: that boundary is enforced by a comment and by which builds happen to run, and a
// pure module is a better fence than either.

/** ACCENT_COUNT distinct principal accents exist; see globals.css for the palette. */
export const ACCENT_COUNT = 4;

/**
 * A principal's accent is its INDEX in the config list, not a value it chooses.
 *
 * Two principals therefore cannot be handed the same colour by mistake, and adding one
 * cannot recolour an existing member. Beyond ACCENT_COUNT it wraps and two principals do look
 * alike — the honest limit of a palette this size, recorded as UI2-N1 rather than left as a
 * silent collision, and resolved when S1.1 makes principals real records.
 */
export function principalAccent(index: number): number {
  return index % ACCENT_COUNT;
}

/**
 * A short, human summary of what a member may do — DERIVED FROM THE MANDATE (M-3).
 *
 * Derived at RENDER TIME from the same `scope` and `protected_actions` the chip already
 * holds, so there is no second representation of the fact to drift from the first. The verb
 * after the dot, because `pr.review` is a namespaced action and "review" is what a person
 * says. Protected actions are grouped and marked, because scope alone makes "may ask" and
 * "may do" look identical:
 *
 *   scope [pr.review, pr.comment]                         → "review + comment only"
 *   scope [pr.review, pr.comment, pr.merge] (merge gated)  → "review + comment, merge (co-sign)"
 *
 * Returns null for no mandate, and renders nothing then — never "unrestricted", which is the
 * one thing an absent mandate must not look like.
 *
 * NOTHING HERE INVENTS A WORD. Every verb comes from a scope entry; "only" and "(co-sign)"
 * are the two pieces of grammar, and both are functions of the mandate's own fields.
 */
export function mandateSummary(
  scope: string[] | null,
  protectedActions: string[] | null,
): string | null {
  if (!scope || scope.length === 0) return null;
  const verb = (action: string): string => action.split('.').pop() ?? action;
  const gated = new Set(protectedActions ?? []);
  const free = scope.filter((a) => !gated.has(a)).map(verb);
  const held = scope.filter((a) => gated.has(a)).map(verb);
  if (held.length === 0) return `${free.join(' + ')} only`;
  if (free.length === 0) return `${held.join(' + ')} (co-sign)`;
  return `${free.join(' + ')}, ${held.join(' + ')} (co-sign)`;
}

// ── THE MANDATE SURFACE DERIVATIONS (UI3-3) ─────────────────────────────────────────────
//
// Pure so they can be tested without a DOM, and so the component renders a DERIVED state rather than
// deciding truth inline. The one rule these enforce: a switch is never shown in a position the mandate
// does not hold. There is no third "off-because-we-don't-know" state — undisclosed and empty are told
// apart, and expiry is a STATE, not a date printed next to live-looking authority.

/**
 * Three states every mandate field collapses to, kept distinct on purpose:
 *  - `undisclosed` — the server sent null (the member has no mandate). NOT "off", NOT "none".
 *  - `empty` — a mandate that carries an empty value: a real "none" (nothing gated / no limits declared).
 *  - `present` — a value to render.
 * `off` is deliberately absent: a read-only mandate surface has no false third position.
 */
export type Disclosed<T> =
  { kind: 'undisclosed' } | { kind: 'empty' } | { kind: 'present'; value: T };

export function discloseList(value: readonly string[] | null): Disclosed<readonly string[]> {
  if (value == null) return { kind: 'undisclosed' };
  if (value.length === 0) return { kind: 'empty' };
  return { kind: 'present', value };
}

export function discloseLimits(
  value: Record<string, number> | null,
): Disclosed<ReadonlyArray<readonly [string, number]>> {
  if (value == null) return { kind: 'undisclosed' };
  const entries = Object.entries(value);
  if (entries.length === 0) return { kind: 'empty' };
  return { kind: 'present', value: entries };
}

/**
 * Expiry as a STATE. Absent → undisclosed; a past (or now) instant → expired; otherwise live. A mandate
 * past its `expires` must never read as live authority with a stale date beside it, so the surface asks
 * this, never formats the raw string. An unparseable instant discloses no state rather than defaulting
 * to live — the safe direction (the schema validates real mandates, so this only guards the impossible).
 */
export type ExpiryState =
  { kind: 'undisclosed' } | { kind: 'live'; at: string } | { kind: 'expired'; at: string };

export function expiryState(expires: string | null, now: Date): ExpiryState {
  if (expires == null) return { kind: 'undisclosed' };
  const t = Date.parse(expires);
  if (Number.isNaN(t)) return { kind: 'undisclosed' };
  return t <= now.getTime() ? { kind: 'expired', at: expires } : { kind: 'live', at: expires };
}

/**
 * A hash is an identifier: show enough of it to recognise, keep all of it for copying. `sha256:abcdef…wxyz`
 * — the scheme, the leading bytes and the trailing bytes, which is what an eye actually checks. The full
 * value stays in the DOM (the component makes it copyable); this only shortens the DISPLAY.
 */
export function truncateHash(hash: string): string {
  const idx = hash.indexOf(':');
  const scheme = idx >= 0 ? hash.slice(0, idx + 1) : '';
  const body = idx >= 0 ? hash.slice(idx + 1) : hash;
  if (body.length <= 14) return hash;
  return `${scheme}${body.slice(0, 6)}…${body.slice(-4)}`;
}
