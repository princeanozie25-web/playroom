import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { hashSecret, type Queryable } from './credentials.js';

// THE LOCAL NODE LEASE (Track C / C2, ADR-013).
//
// A lease is the session a node holds while it does real host work. It is modelled on `member_credentials`
// and `oauth_tokens` — a HASHED secret, liveness enforced IN THE LOOKUP (never a sweep) — with two additions
// a credential has no need for: a HEARTBEAT deadline (so a disconnected node loses its authority) and a
// CAPABILITY scope (so a lease can be narrower than the member's mandate). The gate (C1) still evaluates
// every op, so a lease can only NARROW authority, never widen it.
//
// A lease is LIVE when it is unrevoked, unexpired, its heartbeat is fresh, AND the `prm_` credential that
// granted it is still live — the same cascade OAuth uses. Revoking the lease (or the credential) makes the
// node's next op fail at `verifyLease`, which is what "a revoked lease stops local work mid-flight" means.

const LEASE_TTL_HOURS = 8; // the absolute ceiling — a node cannot hold a lease forever
const HEARTBEAT_TTL_SECONDS = 60; // a node must heartbeat within this window or its lease goes stale

/** Prefix that marks a lease token, so the node-op door routes it apart from a `prm_` credential. */
const LEASE_PREFIX = 'pln_';

export function isLeaseToken(token: string): boolean {
  return token.startsWith(LEASE_PREFIX);
}

export interface IssuedLease {
  /** THE PLAINTEXT LEASE TOKEN, returned once. The node presents it on every op and heartbeat; it is never stored. */
  token: string;
  lease_id: string;
  expires_at: string;
  heartbeat_deadline: string;
  capabilities: string[];
}

export interface LeaseAuth {
  lease_id: string;
  member_id: string;
  principal_id: string;
  capabilities: string[];
}

/**
 * Issue a lease for a member, scoped to `capabilities` (the host action types it may propose). The caller
 * has already authenticated the member; the lease's authority is a SUBSET of what the mandate grants, since
 * the gate evaluates every op regardless — so a broad capability here simply means those ops still BLOCK.
 *
 * Expiry and the heartbeat deadline are computed by the DATABASE (`now() + interval`), on the same clock that
 * later judges them — a `new Date()` in Node would drift against the server that decides liveness.
 */
export async function issueLease(
  db: Queryable,
  input: {
    memberId: string;
    principalId: string;
    credentialId: string;
    capabilities: string[];
    workspace: string;
    ttlHours?: number;
    heartbeatSeconds?: number;
  },
): Promise<IssuedLease> {
  const token = `${LEASE_PREFIX}${randomBytes(32).toString('hex')}`;
  const leaseId = `lea_${randomBytes(8).toString('hex')}`;
  const { rows } = await db.query<{ expires_at: Date; heartbeat_deadline: Date }>(
    `INSERT INTO leases
       (token_hash, lease_id, member_id, principal_id, credential_id, capabilities, workspace,
        expires_at, heartbeat_deadline)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
        now() + ($8::numeric * interval '1 hour'),
        now() + ($9::numeric * interval '1 second'))
     RETURNING expires_at, heartbeat_deadline`,
    [
      hashSecret(token),
      leaseId,
      input.memberId,
      input.principalId,
      input.credentialId,
      input.capabilities,
      input.workspace,
      input.ttlHours ?? LEASE_TTL_HOURS,
      input.heartbeatSeconds ?? HEARTBEAT_TTL_SECONDS,
    ],
  );
  return {
    token,
    lease_id: leaseId,
    expires_at: rows[0].expires_at.toISOString(),
    heartbeat_deadline: rows[0].heartbeat_deadline.toISOString(),
    capabilities: input.capabilities,
  };
}

/**
 * Resolve a lease token to its live session, or null. Liveness is the whole point, and it is one indexed
 * lookup: the lease is unrevoked, within its absolute expiry, its heartbeat is fresh, and the granting
 * credential is still live (so revoking that `prm_` cascades to every lease under it). The member's CURRENT
 * principal is re-derived from `members`, so a lease can never authorise under a stale principal.
 */
export async function verifyLease(pool: Pool, token: string): Promise<LeaseAuth | null> {
  const { rows } = await pool.query<LeaseAuth>(
    `SELECT l.lease_id, l.member_id, m.principal_id, l.capabilities
       FROM leases AS l
       JOIN member_credentials AS cr ON cr.id = l.credential_id
       JOIN members AS m ON m.id = l.member_id
      WHERE l.token_hash = $1
        AND l.revoked_at IS NULL
        AND l.expires_at > now()
        AND l.heartbeat_deadline > now()
        AND cr.revoked_at IS NULL
        AND (cr.expires_at IS NULL OR cr.expires_at > now())`,
    [hashSecret(token)],
  );
  return rows[0] ?? null;
}

/**
 * Bump a lease's heartbeat deadline (authenticated by the token the node holds). A heartbeat that arrives
 * after the deadline lapsed but BEFORE the absolute expiry REVIVES the lease — the reconnect grace: a node
 * that briefly dropped resumes, and only the ops IN the gap were refused. A revoked or absolutely-expired
 * lease can never be revived (the WHERE forbids it), so revocation is a permanent stop.
 */
export async function heartbeatLease(
  pool: Pool,
  token: string,
  heartbeatSeconds: number = HEARTBEAT_TTL_SECONDS,
): Promise<{ lease_id: string; heartbeat_deadline: string; expires_at: string } | null> {
  const { rows } = await pool.query<{
    lease_id: string;
    heartbeat_deadline: Date;
    expires_at: Date;
  }>(
    // Joins the granting credential so a heartbeat is refused once that credential is revoked/expired — the
    // SAME liveness `verifyLease` enforces, so the two surfaces cannot disagree about whether a lease lives
    // (a heartbeat that returned 200 while the node's next op is 401 would be a lying "carry on" signal). The
    // deliberate absence of a `heartbeat_deadline > now()` check is preserved: a lapsed-but-not-expired lease
    // still revives (the reconnect grace); only credential liveness is added.
    `UPDATE leases AS l
        SET heartbeat_deadline = now() + ($2::numeric * interval '1 second')
       FROM member_credentials AS cr
      WHERE l.token_hash = $1
        AND l.revoked_at IS NULL
        AND l.expires_at > now()
        AND cr.id = l.credential_id
        AND cr.revoked_at IS NULL
        AND (cr.expires_at IS NULL OR cr.expires_at > now())
      RETURNING l.lease_id, l.heartbeat_deadline, l.expires_at`,
    [hashSecret(token), heartbeatSeconds],
  );
  const r = rows[0];
  return r
    ? {
        lease_id: r.lease_id,
        heartbeat_deadline: r.heartbeat_deadline.toISOString(),
        expires_at: r.expires_at.toISOString(),
      }
    : null;
}

/**
 * Revoke one lease — the "stop the node" control. Scoped to `memberId` so a member can only revoke a lease
 * it owns: the route authenticates the member, and the WHERE makes the ownership a property of the query
 * rather than of the handler's care. Returns whether a live lease was actually revoked.
 */
export async function revokeLease(pool: Pool, leaseId: string, memberId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE leases SET revoked_at = now()
      WHERE lease_id = $1 AND member_id = $2 AND revoked_at IS NULL`,
    [leaseId, memberId],
  );
  return (rowCount ?? 0) > 0;
}

/** Revoke every live lease a member holds — the panic button (also the natural response to a leaked credential). */
export async function revokeMemberLeases(pool: Pool, memberId: string): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE leases SET revoked_at = now() WHERE member_id = $1 AND revoked_at IS NULL`,
    [memberId],
  );
  return rowCount ?? 0;
}

export interface LeaseSummary {
  lease_id: string;
  workspace: string;
  capabilities: string[];
  expires_at: string;
  heartbeat_deadline: string;
  live: boolean;
}

/** The leases a member holds, newest first — for an owner to see and stop their nodes. Never returns a token. */
export async function listMemberLeases(pool: Pool, memberId: string): Promise<LeaseSummary[]> {
  const { rows } = await pool.query<{
    lease_id: string;
    workspace: string;
    capabilities: string[];
    expires_at: Date;
    heartbeat_deadline: Date;
    live: boolean;
  }>(
    // `live` consults the granting credential too, so the owner-facing view agrees with `verifyLease`: a
    // lease whose credential was revoked reads as dead here, which is exactly what an operator confirming a
    // leak-containment revoke needs to see.
    `SELECT l.lease_id, l.workspace, l.capabilities, l.expires_at, l.heartbeat_deadline,
            (l.revoked_at IS NULL AND l.expires_at > now() AND l.heartbeat_deadline > now()
             AND cr.revoked_at IS NULL AND (cr.expires_at IS NULL OR cr.expires_at > now())) AS live
       FROM leases AS l
       JOIN member_credentials AS cr ON cr.id = l.credential_id
      WHERE l.member_id = $1
      ORDER BY l.created_at DESC`,
    [memberId],
  );
  return rows.map((r) => ({
    lease_id: r.lease_id,
    workspace: r.workspace,
    capabilities: r.capabilities,
    expires_at: r.expires_at.toISOString(),
    heartbeat_deadline: r.heartbeat_deadline.toISOString(),
    live: r.live,
  }));
}

/**
 * Does a lease's capability scope allow an action type? A capability is an exact type (`shell.exec`), a
 * namespace prefix ending in a dot (`fs.`), or `*` (any host op). Checked at the node-op door BEFORE the
 * gate, so a lease can refuse an op its mandate would otherwise allow — least privilege per session.
 */
export function leaseAllows(capabilities: readonly string[], actionType: string): boolean {
  return capabilities.some(
    (c) => c === '*' || c === actionType || (c.endsWith('.') && actionType.startsWith(c)),
  );
}
