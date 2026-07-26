import { principalAccent } from './mandate';

// THE ROSTER, FETCHED FROM THE API — no filesystem, no YAML parser, no fabric.
//
// This module used to read adapters.yaml and mandates/ off the disk with `node:fs`, and
// carried a comment saying SERVER ONLY that was the entire enforcement. UI2-N2 recorded how
// well that held: a single VALUE import of a pure helper into a client component pulled
// `node:fs` and `node:crypto` into the browser bundle and broke `next build`, while
// `pnpm typecheck` stayed green throughout. The previous `import type` had held by accident,
// being erased at compile time.
//
// S1.1a closes it properly rather than more carefully. Members are records now, the API owns
// them, and this file makes an HTTP call — SO THERE IS NO FILESYSTEM READ LEFT IN THIS PATH
// TO LEAK. `yaml` and `@playroom/fabric` leave this workspace's dependencies entirely, which
// is a stronger statement than a comment: the modules that could leak are not reachable.
//
// It stays server-side because the room page is a server component — the browser still never
// makes this call — but that is now a property of where it is used rather than a rule someone
// has to remember.

export interface RosterMember {
  id: string;
  display_name: string;
  principal: string;
  /**
   * The member's granted action scope, READ FROM THEIR MANDATE — not from config.
   *
   * This replaced `mandate_label`, a caption in adapters.yaml that described authority
   * without being it. The chip renders the mandate's own scope, so the text a viewer reads
   * and the array the evaluator checks are the same data. A member with no mandate gets
   * `null` and renders NO mandate text — never "unrestricted".
   */
  scope: string[] | null;
  /**
   * Actions the mandate lists as protected. Shown so the chip cannot imply that a granted
   * action is freely exercisable: `pr.merge` in scope means the member may ASK, and being
   * protected means a human must sign. Reading the scope alone would make those identical.
   */
  protected_actions: string[] | null;
  /** The principal's display name. Never the identifier — see MemberChip. */
  principal_name: string | null;
  /** Which accent this member inherits from its principal. */
  accent: number | null;
}

export interface Principal {
  id: string;
  display_name: string;
  accent: number;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

interface ApiMember {
  id: string;
  kind: 'human' | 'agent';
  display_name: string;
  principal_id: string;
  principal_name: string;
  principal_ordinal: number;
  adapter_id: string | null;
  scope: string[] | null;
  protected_actions: string[] | null;
}

/**
 * Fetch the member records.
 *
 * `no-store`: the roster is small, read once per room render, and a cached copy would show a
 * member who has been removed. Correctness over a request that costs a millisecond on the
 * same host.
 *
 * A FAILURE HERE IS NOT SWALLOWED. If the API is unreachable the room fails to render, which
 * is the honest outcome: a room drawn with an empty roster would show agent turns with no
 * chip, no affiliation and no mandate — a room that looks ungoverned because a fetch failed.
 * That is RT-001's shape at the page level, and silence is exactly what it must not be.
 */
async function fetchMembers(roomId: string): Promise<ApiMember[]> {
  const res = await fetch(`${API_URL}/rooms/${encodeURIComponent(roomId)}/members`, {
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`GET /rooms/${roomId}/members failed: ${res.status}`);
  const body: unknown = await res.json();
  if (typeof body !== 'object' || body === null || !Array.isArray((body as never)['members'])) {
    throw new Error('GET /members returned no members array');
  }
  return (body as { members: ApiMember[] }).members;
}

/**
 * The principals present in THIS ROOM, in accent order.
 *
 * Derived from the members rather than fetched separately: a principal with no member is not
 * in the room, and would be a colour assigned to nobody.
 */
export async function loadPrincipals(roomId: string): Promise<Principal[]> {
  const seen = new Map<string, Principal>();
  for (const m of await fetchMembers(roomId)) {
    if (seen.has(m.principal_id)) continue;
    seen.set(m.principal_id, {
      id: m.principal_id,
      display_name: m.principal_name,
      accent: principalAccent(m.principal_ordinal),
    });
  }
  return [...seen.values()].sort((a, b) => a.accent - b.accent);
}

/**
 * Agent members, as the roster strip renders them.
 *
 * Humans are excluded for the same reason they always were: an agent chip carries a mandate
 * and a human member has none to show. S1.1b, which adds human members, decides how they
 * appear — this slice must not change the strip.
 */
export async function loadRoster(roomId: string): Promise<RosterMember[]> {
  return (await fetchMembers(roomId))
    .filter((m) => m.kind === 'agent')
    .map((m) => ({
      id: m.id,
      display_name: m.display_name,
      principal: m.principal_id,
      principal_name: m.principal_name,
      accent: principalAccent(m.principal_ordinal),
      scope: m.scope,
      protected_actions: m.protected_actions,
    }));
}
