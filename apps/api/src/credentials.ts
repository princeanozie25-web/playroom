import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

/**
 * A pool OR a client inside a transaction.
 *
 * `redeemRoomCode` issues a credential as one of six writes that must all land together, so it needs
 * to issue on ITS client rather than on the pool — a credential committed by a separate connection
 * would survive a rolled-back enrolment, leaving a live secret for a room the holder is not in.
 * Widening the parameter is the honest way to allow that; the alternative was casting a client to a
 * Pool at the call site, which compiles by asserting something untrue.
 */
export type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

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
  /** When it stops working. Null for the long-lived ones that predate S-LIVE. */
  expires_at: string | null;
}

/**
 * Issue a credential for a member.
 *
 * Rotation is issue-then-revoke, never update-in-place: the old row stays as the record that
 * the secret existed, which is what makes `revoked_at` mean something.
 *
 * ── EXPIRY IS OPTIONAL HERE AND MANDATORY WHERE IT MATTERS ──
 *
 * `expiresInHours` is undefined for the credentials that predate S-LIVE — mine, and the capture
 * harness's — which are long-lived on purpose. Every credential a STRANGER holds is issued through
 * `redeemRoomCode`, which passes one and does not take no for an answer. So the parameter is
 * optional and the policy is enforced at the place that knows the difference, rather than by a
 * default here that would silently expire the harness mid-take.
 */
export async function issueCredential(
  db: Queryable,
  memberId: string,
  label: string,
  expiresInHours?: number,
): Promise<IssuedCredential> {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
  const id = `cred_${randomBytes(8).toString('hex')}`;
  const { rows } = await db.query<{ expires_at: Date | null }>(
    `INSERT INTO member_credentials (id, member_id, token_hash, label, expires_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $5::numeric IS NULL THEN NULL
                                  ELSE now() + ($5::numeric * interval '1 hour') END)
     RETURNING expires_at`,
    [id, memberId, hashSecret(token), label, expiresInHours ?? null],
  );
  // Computed by the DATABASE, not by Node. The expiry is compared against `now()` at
  // authentication time, so it has to be measured on the same clock that will judge it — a
  // `new Date()` here would drift against the server that decides.
  const expiresAt = rows[0].expires_at;
  return {
    id,
    member_id: memberId,
    label,
    token,
    expires_at: expiresAt ? expiresAt.toISOString() : null,
  };
}

export async function revokeCredential(pool: Pool, id: string): Promise<void> {
  await pool.query('UPDATE member_credentials SET revoked_at = now() WHERE id = $1', [id]);
}

/**
 * Diagnose WHY a credential was rejected — FOR THE OPERATOR LOG ONLY, never the wire (S2.1b).
 *
 * `authenticate` collapses unknown / expired / revoked into one outward `credential_invalid`
 * deliberately (see AuthFailure): telling a caller "that one expired" confirms the token was real,
 * which a stranger holding a guessed string has not earned. But an OPERATOR must still be able to tell
 * them apart — a revoked token is a leak being contained, an expired one is a client that needs a fresh
 * credential, an unknown one is a wrong deployment or a typo. This is that distinction, and it must
 * NEVER be returned to a caller. `'unknown'` also covers a malformed token: a bad-shaped string simply
 * matches no row.
 */
export async function diagnoseCredential(
  pool: Pool,
  token: string,
): Promise<'unknown' | 'expired' | 'revoked'> {
  const { rows } = await pool.query<{ revoked_at: Date | null; expires_at: Date | null }>(
    'SELECT revoked_at, expires_at FROM member_credentials WHERE token_hash = $1',
    [hashSecret(token)],
  );
  const row = rows[0];
  if (!row) return 'unknown';
  if (row.revoked_at) return 'revoked';
  if (row.expires_at && row.expires_at.getTime() <= Date.now()) return 'expired';
  return 'unknown';
}

/**
 * Why a connection was refused. Two codes, because they send an operator to different places.
 *
 * AN EXPIRED CREDENTIAL IS `credential_invalid`, NOT A THIRD CODE — and that is a decision, not an
 * omission. Outward, the two must be indistinguishable: telling a caller "that one has expired"
 * confirms the token was real and once worked, which is a fact about our records that a stranger
 * holding a guessed string has not earned. Same rule as the ticket path's one refusal outward.
 * The distinction that an operator needs lives in the log, not on the wire.
 */
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
      WHERE c.token_hash = $1
        AND c.revoked_at IS NULL
        -- EXPIRY ENFORCED IN THE LOOKUP, compared against the database's own clock. Not by a
        -- sweep job: an expired credential has to stop working the moment it expires, not the
        -- next time something remembers to tidy up. The null branch comes first so the
        -- long-lived rows that predate S-LIVE keep authenticating.
        AND (c.expires_at IS NULL OR c.expires_at > now())`,
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
