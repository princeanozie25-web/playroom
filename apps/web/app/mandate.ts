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
