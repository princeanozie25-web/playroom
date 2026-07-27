import { randomInt } from 'node:crypto';
import type { Pool } from 'pg';
import { issueCredential } from './credentials.js';

/**
 * ROOM CODES — the only way a stranger gets a credential (Bible §21.3, S-LIVE).
 *
 * ── WHAT THIS IS NOT ──
 *
 * It is not a second authentication mechanism. Redemption ENDS with an ordinary member credential
 * and an ordinary `room_members` row, and every request after that walks the identical path through
 * the identical checks that S1.2 and S1.3b built. Nothing here can be used to reach a room; it can
 * only be used to be ISSUED the thing that reaches a room.
 *
 * That distinction is the whole reason the front door needed no change to let testers in.
 */

/**
 * The code alphabet: no O/0, no I/1/L, no U (it turns up in words nobody wants printed).
 *
 * Someone reads these aloud over a phone and someone else types them with a thumb. Every ambiguous
 * character removed here is a support conversation that cannot happen, and the entropy cost is
 * nothing next to the one-use rule and the expiry.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const GROUP = 4;

/** `PLAY-7QK3`. The prefix is not decoration: it makes a code recognisable in a text message. */
export function generateCode(): string {
  let body = '';
  // `randomInt` rather than Math.random — this is guessable-by-design but it should not be
  // PREDICTABLE, and a code is a claim on an identity.
  for (let i = 0; i < GROUP; i += 1) body += ALPHABET[randomInt(ALPHABET.length)];
  return `PLAY-${body}`;
}

export interface RoomCode {
  code: string;
  room_id: string;
  principal_id: string;
  label: string;
  expires_at: string;
  credential_hours: number;
}

export type MintFailure =
  | 'not_a_guest_principal' // would hand a stranger a real person's identity
  | 'principal_already_has_a_live_code'
  | 'principal_already_redeemed' // the seat is spent, permanently
  | 'no_such_room';

export class MintRefused extends Error {
  constructor(readonly reason: MintFailure) {
    super(`room code not minted: ${reason}`);
    this.name = 'MintRefused';
  }
}

export type RedeemFailure =
  | 'no_such_code' // wrong, expired, or already spent — one reason outward, see below
  | 'name_required';

export class RedeemRefused extends Error {
  constructor(readonly reason: RedeemFailure) {
    super(`room code not redeemed: ${reason}`);
    this.name = 'RedeemRefused';
  }
}

/**
 * Mint a code for one guest seat.
 *
 * REFUSES A NON-GUEST PRINCIPAL, and that is the load-bearing check in this file. A code against
 * `principal:prince` would issue a stranger a credential for a member bound to MY principal — my
 * agent, my mandate, my private context store. The guest flag from migration 017 is what makes
 * "which seats may be given away" a property of the data rather than of my care at the CLI.
 */
export async function mintRoomCode(
  pool: Pool,
  input: {
    roomId: string;
    principalId: string;
    label: string;
    /** How long the CODE stays claimable. */
    codeHours: number;
    /** How long the credential lasts once redeemed. */
    credentialHours: number;
    createdBy: string;
  },
): Promise<RoomCode> {
  const guest = await pool.query<{ guest: boolean }>('SELECT guest FROM principals WHERE id = $1', [
    input.principalId,
  ]);
  if (!guest.rows[0] || guest.rows[0].guest !== true) {
    throw new MintRefused('not_a_guest_principal');
  }
  const room = await pool.query('SELECT 1 FROM rooms WHERE id = $1', [input.roomId]);
  if (room.rowCount === 0) throw new MintRefused('no_such_room');

  // A SPENT SEAT STAYS SPENT. Events hold `actor_member_id`, so renaming a guest principal for a
  // second tester would re-attribute every past act to someone who did not perform it.
  const spent = await pool.query(
    'SELECT 1 FROM room_codes WHERE principal_id = $1 AND redeemed_at IS NOT NULL',
    [input.principalId],
  );
  if (spent.rowCount && spent.rowCount > 0) throw new MintRefused('principal_already_redeemed');

  try {
    const { rows } = await pool.query<{
      code: string;
      room_id: string;
      principal_id: string;
      label: string;
      expires_at: Date;
      credential_hours: string;
    }>(
      `INSERT INTO room_codes
         (code, room_id, principal_id, label, expires_at, credential_hours, created_by)
       VALUES ($1, $2, $3, $4, now() + ($5::numeric * interval '1 hour'), $6, $7)
       RETURNING code, room_id, principal_id, label, expires_at, credential_hours`,
      [
        generateCode(),
        input.roomId,
        input.principalId,
        input.label.trim(),
        input.codeHours,
        input.credentialHours,
        input.createdBy,
      ],
    );
    const r = rows[0];
    return {
      code: r.code,
      room_id: r.room_id,
      principal_id: r.principal_id,
      label: r.label,
      expires_at: r.expires_at.toISOString(),
      credential_hours: Number(r.credential_hours),
    };
  } catch (err) {
    // The partial unique index. Surfaced as a named refusal rather than a constraint name.
    if (String(err).includes('room_codes_one_live_per_principal')) {
      throw new MintRefused('principal_already_has_a_live_code');
    }
    throw err;
  }
}

export interface Redemption {
  /** THE PLAINTEXT CREDENTIAL, RETURNED ONCE. The caller puts it in an httpOnly cookie. */
  token: string;
  member_id: string;
  room_id: string;
  display_name: string;
  /** The agent this tester now has, so the welcome screen can say what to tag. */
  agent_id: string;
  agent_name: string;
  expires_at: string | null;
}

/**
 * Redeem a code: name the seat, enrol the person and their agent, issue the credential.
 *
 * ── ONE TRANSACTION, AND ONE REFUSAL OUTWARD ──
 *
 * Six writes that must all happen or none: the code is spent, the human member exists, the
 * principal carries the tester's name, the person and their agent are in the room, and a credential
 * exists. A partial redemption is a tester who is enrolled but cannot connect, or holds a credential
 * for a room they are not in — both of which look like the front door being broken.
 *
 * `no_such_code` covers wrong, expired AND already-spent, deliberately. "That code was already
 * used" tells someone holding a guessed string that they guessed a real one, and which seat it was
 * for. The operator's distinction is in the row; the caller gets one answer.
 */
export async function redeemRoomCode(
  pool: Pool,
  code: string,
  displayName: string,
): Promise<Redemption> {
  const name = displayName.trim();
  if (name === '') throw new RedeemRefused('name_required');
  // First name only, and short. It is rendered beside every act this person takes, and a 200
  // character "name" is a way to write graffiti on a shared surface.
  const shortName = name.slice(0, 24);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // LOCK THE CODE'S ROW, with the spend and the expiry in the WHERE.
    //
    // `FOR UPDATE` rather than an atomic `UPDATE ... RETURNING`, and the reason is a constraint
    // catching a real bug rather than a preference: `room_codes_redemption_is_whole` requires
    // `redeemed_at` and `redeemed_member` to be set TOGETHER, and the member id cannot be known
    // before this row is read (it is derived from the seat's principal). Claiming in two steps left
    // the row momentarily half-redeemed, and the CHECK refused it — correctly.
    //
    // The race protection is identical. A second transaction redeeming the same code BLOCKS here
    // until this one commits, then re-evaluates the WHERE, sees `redeemed_at` set and matches no
    // row. Two strangers cannot both be handed one identity; they just queue instead of one
    // failing an UPDATE.
    const claimed = await client.query<{
      room_id: string;
      principal_id: string;
      label: string;
      credential_hours: string;
    }>(
      `SELECT room_id, principal_id, label, credential_hours
         FROM room_codes
        WHERE code = $1
          AND redeemed_at IS NULL
          AND expires_at > now()
          FOR UPDATE`,
      [code.trim().toUpperCase()],
    );
    const row = claimed.rows[0];
    if (!row) throw new RedeemRefused('no_such_code');

    // The seat's members: the agent already exists (migration 017); the human is this person.
    const agent = await client.query<{ id: string; display_name: string }>(
      "SELECT id, display_name FROM members WHERE principal_id = $1 AND kind = 'agent'",
      [row.principal_id],
    );
    if (!agent.rows[0]) throw new Error(`guest principal ${row.principal_id} has no agent`);

    // A stable member id derived from the seat, NOT from the name. A member id built from user
    // input is a member id someone can choose, and these appear in `actor_member_id` forever.
    const humanId = `${row.principal_id.replace(/^principal:/, '')}-human`;
    await client.query(
      `INSERT INTO members (id, kind, display_name, principal_id, adapter_id)
       VALUES ($1, 'human', $2, $3, NULL)
       ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`,
      [humanId, shortName, row.principal_id],
    );
    // THE SEAT TAKES THE PERSON'S NAME. `Guest A` was a placeholder for an empty seat; from here
    // the room renders `Ada (Amara)` and nothing in it names an invented human.
    await client.query('UPDATE principals SET display_name = $1 WHERE id = $2', [
      shortName,
      row.principal_id,
    ]);
    // Both of them, into the room. The agent too, or `@ada` resolves to nobody: the summon token
    // table is per-room and built from membership (S1.1a).
    await client.query(
      `INSERT INTO room_members (room_id, member_id)
       SELECT $1, m FROM unnest($2::text[]) AS m
       ON CONFLICT DO NOTHING`,
      [row.room_id, [humanId, agent.rows[0].id]],
    );
    // SPENT, both columns at once — the member exists by now, so the FK and the whole-redemption
    // CHECK are both satisfiable in one statement.
    await client.query(
      'UPDATE room_codes SET redeemed_at = now(), redeemed_member = $1 WHERE code = $2',
      [humanId, code.trim().toUpperCase()],
    );

    // THE CREDENTIAL, NAMED AND EXPIRING. The label carries the code's label and the name the
    // person gave, so every act in the audit log traces to a human somebody can identify.
    const credential = await issueCredential(
      // ON THIS CLIENT, inside this transaction. A credential committed by a separate connection
      // would survive a rolled-back enrolment — a live secret for a room its holder is not in.
      client,
      humanId,
      `room code: ${shortName} (${row.label})`,
      Number(row.credential_hours),
    );

    await client.query('COMMIT');
    return {
      token: credential.token,
      member_id: humanId,
      room_id: row.room_id,
      display_name: shortName,
      agent_id: agent.rows[0].id,
      agent_name: agent.rows[0].display_name,
      expires_at: credential.expires_at,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      /* connection may be unusable; release still returns it */
    });
    throw err;
  } finally {
    client.release();
  }
}

/** Live codes for a room, for the operator who minted them. Never returns a credential. */
export async function listRoomCodes(
  pool: Pool,
  roomId: string,
): Promise<Array<{ code: string; label: string; expires_at: string; redeemed_by: string | null }>> {
  const { rows } = await pool.query<{
    code: string;
    label: string;
    expires_at: Date;
    redeemed_by: string | null;
  }>(
    `SELECT c.code, c.label, c.expires_at, m.display_name AS redeemed_by
       FROM room_codes AS c
       LEFT JOIN members AS m ON m.id = c.redeemed_member
      WHERE c.room_id = $1
      ORDER BY c.created_at DESC`,
    [roomId],
  );
  return rows.map((r) => ({
    code: r.code,
    label: r.label,
    expires_at: r.expires_at.toISOString(),
    redeemed_by: r.redeemed_by,
  }));
}
