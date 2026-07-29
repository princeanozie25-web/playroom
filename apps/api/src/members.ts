import type { Pool } from 'pg';
import { getAdapterConfig } from '@playroom/adapters';
import { allMandates } from './mandates.js';
import { setRoomTokens } from './agent.js';

/**
 * THE ROSTER, READ FROM RECORDS.
 *
 * Members and principals were a YAML file until S1.1a. They are rows now, and this module is
 * the only place that reads them. Two consumers:
 *
 *   * `GET /members`, which the web tier calls instead of reading the filesystem (UI2-N2);
 *   * the summon token table, which needs display names to know that `@claude` means
 *     `claude-main`.
 *
 * §6 IS UNCHANGED. `adapter_id` is carried because an agent member needs one to run, but no
 * provider and no model name is projected here — those stay inside packages/adapters, which
 * is still the only place a provider is named.
 */

export interface MemberRecord {
  id: string;
  kind: 'human' | 'agent';
  display_name: string;
  principal_id: string;
  principal_name: string;
  /** The principal's accent, from its stored ordinal. Palette size lives in the web tier. */
  principal_ordinal: number;
  /** Null for a human member. Never a provider or a model — §6. */
  adapter_id: string | null;
  /** From the member's mandate document, or null if they have none. */
  scope: string[] | null;
  protected_actions: string[] | null;
}

/**
 * A mandate naming a member that does not exist is a CONFIGURATION ERROR, and it now says so.
 *
 * Before S1.1a nothing cross-checked the two: `loadMandates()` keyed a map by whatever the
 * `member` field said, an entry for a member that never existed sat in that map unread, and
 * the member it was MEANT for was left with no mandate at all — which evaluates to
 * BLOCK/NO_MANDATE. So a typo in a filename or a member id produced a silently powerless
 * agent, and the only symptom was a member that had stopped being able to do anything.
 *
 * Deny-by-default is correct and is not the issue. The issue is that it made a broken
 * configuration indistinguishable from a deliberate one — the A4-F1 shape at the authority
 * layer. This throws instead, at load, naming the member.
 */
export class UnknownMandateMemberError extends Error {
  constructor(memberId: string, known: string[]) {
    super(
      `mandate names member "${memberId}", which is not a member record ` +
        `(known members: ${known.join(', ') || 'none'})`,
    );
    this.name = 'UnknownMandateMemberError';
  }
}

/** A mandate whose `principal` disagrees with the member's binding. */
export class MandatePrincipalMismatchError extends Error {
  constructor(memberId: string, onMandate: string, onRecord: string) {
    super(
      `mandate for member "${memberId}" names principal "${onMandate}", ` +
        `but the member record binds to "${onRecord}"`,
    );
    this.name = 'MandatePrincipalMismatchError';
  }
}

interface Row {
  id: string;
  kind: 'human' | 'agent';
  display_name: string;
  principal_id: string;
  principal_name: string;
  principal_ordinal: number;
  adapter_id: string | null;
}

/**
 * Every member, with their principal and their mandate's granted scope.
 *
 * Ordered by the principal's ordinal then the member id, so the roster strip renders in a
 * stable order rather than whatever the planner returns.
 */
export async function listMembers(pool: Pool): Promise<MemberRecord[]> {
  const { rows } = await pool.query<Row>(
    `SELECT m.id, m.kind, m.display_name, m.principal_id, m.adapter_id,
            p.display_name AS principal_name, p.ordinal AS principal_ordinal
       FROM members AS m
       JOIN principals AS p ON p.id = m.principal_id
      ORDER BY p.ordinal, m.id`,
  );

  // The cached mandate map (S2.2) — read from disk once at boot, not on every roster read. This was
  // the last per-call `loadMandates()` in apps/api (the S18 finding); every `listMembers`/
  // `listRoomMembers` caller now shares one load. A mandate change requires a restart — see mandates.ts.
  const mandates = allMandates();
  const known = rows.map((r) => r.id);

  // VALIDATED HERE because this is the first moment both halves are in one place. A mandate
  // is a file and a member is a row; nothing else in the system holds both.
  for (const [memberId, loaded] of mandates) {
    const record = rows.find((r) => r.id === memberId);
    if (!record) throw new UnknownMandateMemberError(memberId, known);
    if (loaded.mandate.principal !== record.principal_id) {
      throw new MandatePrincipalMismatchError(
        memberId,
        loaded.mandate.principal,
        record.principal_id,
      );
    }
  }

  // An agent member must reference an adapter that exists. The database cannot check this —
  // adapters live in adapters.yaml, not in Postgres (§6) — so it is checked at the seam.
  for (const r of rows) {
    if (r.kind === 'agent' && r.adapter_id) getAdapterConfig(r.adapter_id);
  }

  return rows.map((r) => {
    const m = mandates.get(r.id)?.mandate;
    return {
      id: r.id,
      kind: r.kind,
      display_name: r.display_name,
      principal_id: r.principal_id,
      principal_name: r.principal_name,
      principal_ordinal: r.principal_ordinal,
      adapter_id: r.adapter_id,
      scope: m?.scope ?? null,
      protected_actions: m?.protected_actions ?? null,
    };
  });
}

/**
 * The members of ONE room.
 *
 * The same shape and the same validation as `listMembers`, narrowed by the room's roster.
 * Reusing the validation matters: a room-scoped read that skipped the mandate checks would
 * be a second, laxer path to the same records.
 */
export async function listRoomMembers(pool: Pool, roomId: string): Promise<MemberRecord[]> {
  const { rows } = await pool.query<{ member_id: string }>(
    'SELECT member_id FROM room_members WHERE room_id = $1',
    [roomId],
  );
  const inRoom = new Set(rows.map((r) => r.member_id));
  return (await listMembers(pool)).filter((m) => inRoom.has(m.id));
}

/**
 * Match a raw summon TARGET — a string a model emitted (S1.8) — to an AGENT member of an
 * ALREADY-LOADED member list.
 *
 * PURE, and takes the list rather than reading it, because the one caller (the summon constructor)
 * has just read the room's members to build the evaluator's roster and resolves the target from THAT
 * read. Reading it a second time cost a redundant DB round-trip before B's turn — against a remote
 * database, enough to nudge the summon-path first token over §11's P95 line on the tightest member
 * (measured in docs/demo/s18-render-and-measure.md). One read, used twice, keeps it under.
 *
 * Returns the member id, or null when nothing in the room matches — the "cannot summon a member
 * outside the room" refusal, the structured path's equivalent of the free-text boundary resolving
 * `@tokens` against the room's own tokens. AGENTS ONLY: a summon starts an agent turn, so a human
 * target has no adapter to run.
 */
export function matchRoomAgent(members: MemberRecord[], target: string): string | null {
  const want = target.trim().replace(/^@/, '').toLowerCase();
  if (!want) return null;
  for (const m of members) {
    if (m.kind !== 'agent') continue;
    if (m.id.toLowerCase() === want || m.display_name.toLowerCase() === want) return m.id;
  }
  return null;
}

/**
 * One member row, or null.
 *
 * The `kind` is what callers need: a handoff checks a mandate only for an AGENT, because mandates
 * bind agents to the principals who grant them and a human acts as a principal rather than under
 * one. Narrow on purpose — `listMembers` runs every mandate validation to build its shape, which
 * is the wrong cost for a one-field question.
 */
export async function memberRecord(
  pool: Pool,
  id: string,
): Promise<{ id: string; kind: 'human' | 'agent'; display_name: string } | null> {
  const { rows } = await pool.query<{ id: string; kind: 'human' | 'agent'; display_name: string }>(
    'SELECT id, kind, display_name FROM members WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

/**
 * The principal a member is bound to, or null if the member is unknown.
 *
 * The bridge an order interrupt needs: its creator is a human member, and the claim it raises is
 * addressed to the humans of that member's PRINCIPAL (via `humanMembersOfPrincipal`), so a second
 * human behind the same principal is told too. One indexed read of the column the roster already
 * projects.
 */
export async function principalOf(pool: Pool, memberId: string): Promise<string | null> {
  const { rows } = await pool.query<{ principal_id: string }>(
    'SELECT principal_id FROM members WHERE id = $1',
    [memberId],
  );
  return rows[0]?.principal_id ?? null;
}

/**
 * The HUMAN members of a principal, in this room.
 *
 * A co-signature is required from a PRINCIPAL (`required_signer` is `principal:prince`), and an
 * interrupt is addressed to a MEMBER — so the two are bridged here, and the bridge is where the
 * inherited constraint lives.
 *
 * RETURNS A LIST, and the caller raises one interrupt per member in it. Today `principal:prince`
 * has exactly one human member, so the list has one entry and the film shows one interrupt. When a
 * second human joins that principal this returns two and the co-sign path raises two — no schema
 * change and no reshaped record, because nothing assumed one human per principal.
 *
 * HUMANS ONLY. An interrupt addressed to an agent would be a notification nothing reads: an agent
 * acts when summoned and has no inbox, so a claim on its attention is a row with no reader.
 */
export async function humanMembersOfPrincipal(
  pool: Pool,
  roomId: string,
  principalId: string,
): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT m.id
       FROM members AS m
       JOIN room_members AS rm ON rm.member_id = m.id AND rm.room_id = $1
      WHERE m.principal_id = $2 AND m.kind = 'human'
      ORDER BY m.id`,
    [roomId, principalId],
  );
  return rows.map((r) => r.id);
}

/**
 * CAN THIS MEMBER SEE THIS ROOM? Existence and membership, in ONE query.
 *
 * One round trip rather than two, and that is not an optimisation — it is what makes the two
 * refusals indistinguishable. S1.3b's ruling is that a room you are not in answers exactly as a
 * room that does not exist: same close code, same bytes, same timing. Asking `getRoom` and then
 * `isRoomMember` would do one query for a missing room and two for a room you cannot see, so a
 * caller with a clock could tell which of the two it was — an oracle rebuilt out of latency after
 * being closed in the response.
 *
 * Both branches now do identical work: one query, two `EXISTS` subqueries, whatever the answer.
 */
export interface RoomAccess {
  room_exists: boolean;
  is_member: boolean;
}

export async function roomAccess(
  pool: Pool,
  roomId: string,
  memberId: string,
): Promise<RoomAccess> {
  const { rows } = await pool.query<RoomAccess>(
    `SELECT
       EXISTS (SELECT 1 FROM rooms WHERE id = $1) AS room_exists,
       EXISTS (
         SELECT 1 FROM room_members WHERE room_id = $1 AND member_id = $2
       ) AS is_member`,
    [roomId, memberId],
  );
  return rows[0];
}

/**
 * Is this member in this room?
 *
 * One indexed read against `room_members`' primary key. Deliberately NOT expressed as
 * `listRoomMembers(...).some(...)`: that reads every member and runs every mandate validation
 * to answer a yes/no, and an authorisation check that gets slower as the roster grows is one
 * that eventually gets moved somewhere cheaper and less careful.
 */
export async function isRoomMember(pool: Pool, roomId: string, memberId: string): Promise<boolean> {
  const { rows } = await pool.query(
    'SELECT 1 FROM room_members WHERE room_id = $1 AND member_id = $2',
    [roomId, memberId],
  );
  return rows.length > 0;
}

/**
 * Install the summon tokens for a room, from that room's current membership.
 *
 * Called on the send path before the activation boundary rules, so a tag resolves against
 * who is in the room NOW. S11a-N2 made this a boot-time process snapshot, which was fine
 * while membership was configuration and is not fine now that it is data — a member removed
 * from a room would have stayed addressable until the next deploy.
 */
export async function loadRoomTokens(pool: Pool, roomId: string): Promise<void> {
  setRoomTokens(roomId, await listRoomMembers(pool, roomId));
}
