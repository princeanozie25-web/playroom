import type { Pool } from 'pg';
import { getAdapterConfig } from '@playroom/adapters';
import { loadMandates } from '@playroom/fabric';
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

  const mandates = loadMandates();
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
