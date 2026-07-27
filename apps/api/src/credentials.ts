import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

/**
 * MEMBER CREDENTIALS — the smallest thing that makes `speaks for` true rather than asserted.
 *
 * Until S1.2 the wire carried `author` and the server wrote what it was given. Five findings
 * and RT-005 rested on that one field. This module replaces the claim with a lookup.
 *
 * ── WHAT IT PROVES, AND WHAT IT DOES NOT ──
 *
 * PROVES: the holder of this token is the member it was issued to. A member is bound to a
 * principal (migration 007, enforced), so an authenticated connection resolves to a member AND
 * to the principal that member acts for.
 *
 * DOES NOT PROVE: that a PERSON is at the other end, or which person. There is no login, no
 * second factor, and no per-human key. A token in an environment variable authenticates a
 * PROCESS acting as a member — which is precisely what an agent gateway is, and only
 * approximately what a browser session is.
 *
 * So `Sol speaks for Jerry` is now enforced at the connection, and `Jerry granted this mandate`
 * is still unproven, because the mandate is an unsigned file and the credential is not Jerry's
 * key. S04-N2 stays open with a narrower description rather than being closed by this slice.
 */

/** Issued tokens carry a prefix so one found in a log is recognisable as a Playroom secret. */
const TOKEN_PREFIX = 'prm_';

/**
 * sha256, unsalted, and that is a deliberate choice rather than an omission.
 *
 * Exported since S1.3c, because `ws_tickets` hashes the same way for the same reason. One
 * function rather than two identical ones: the argument below applies unchanged to a ticket,
 * and a second copy would be a second place to get it wrong.
 *
 * The input is 32 bytes of CSPRNG output: there is no dictionary to attack, no password to
 * stretch, and no user-chosen entropy to protect. A per-row salt would prevent the indexed
 * lookup that makes authentication one query, and would buy nothing against a random 256-bit
 * secret. If this ever accepts a human-chosen secret, this line becomes wrong and must change
 * to a KDF — the comment is here so that is a decision rather than an oversight.
 */
export function hashSecret(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface IssuedCredential {
  id: string;
  member_id: string;
  label: string;
  /** THE PLAINTEXT, RETURNED ONCE AND NEVER STORED. If it is lost, issue another. */
  token: string;
}

/**
 * Issue a credential for a member.
 *
 * Rotation is issue-then-revoke, never update-in-place: the old row stays as the record that
 * the secret existed, which is what makes `revoked_at` mean something.
 */
export async function issueCredential(
  pool: Pool,
  memberId: string,
  label: string,
): Promise<IssuedCredential> {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
  const id = `cred_${randomBytes(8).toString('hex')}`;
  await pool.query(
    'INSERT INTO member_credentials (id, member_id, token_hash, label) VALUES ($1, $2, $3, $4)',
    [id, memberId, hashSecret(token), label],
  );
  return { id, member_id: memberId, label, token };
}

export async function revokeCredential(pool: Pool, id: string): Promise<void> {
  await pool.query('UPDATE member_credentials SET revoked_at = now() WHERE id = $1', [id]);
}

/** Why a connection was refused. Two codes, because they send an operator to different places. */
export type AuthFailure = 'credential_required' | 'credential_invalid';

export interface AuthResult {
  member_id: string;
  principal_id: string;
  credential_id: string;
}

/**
 * Resolve a token to the member and principal it authenticates.
 *
 * Returns the failure REASON rather than null, because a missing credential and a bad one are
 * different mistakes: the first is a client that was never configured, the second is a token
 * that was revoked, mistyped, or belongs to another deployment. Collapsing them would send
 * someone to check the wrong thing — the same rule that keeps `NOT_IN_ROOM` apart from
 * `UNKNOWN_MEMBER`.
 *
 * The principal comes from the member's binding, so it cannot disagree with the roster: there
 * is no second place recording who a member acts for.
 */
export async function authenticate(
  pool: Pool,
  token: string | undefined,
): Promise<{ ok: true; auth: AuthResult } | { ok: false; failure: AuthFailure }> {
  if (!token || token.trim() === '') return { ok: false, failure: 'credential_required' };

  const { rows } = await pool.query<{
    credential_id: string;
    member_id: string;
    principal_id: string;
  }>(
    `SELECT c.id AS credential_id, c.member_id, m.principal_id
       FROM member_credentials AS c
       JOIN members AS m ON m.id = c.member_id
      WHERE c.token_hash = $1 AND c.revoked_at IS NULL`,
    [hashSecret(token)],
  );
  const row = rows[0];
  if (!row) return { ok: false, failure: 'credential_invalid' };
  return {
    ok: true,
    auth: {
      member_id: row.member_id,
      principal_id: row.principal_id,
      credential_id: row.credential_id,
    },
  };
}
