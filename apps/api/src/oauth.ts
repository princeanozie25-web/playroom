import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { hashSecret } from './credentials.js';

// OAuth 2.1 for the subscription login (S4.1 / B2). A native authorization-code + PKCE server: a Claude
// subscription registers a client, sends its user through /authorize (where the user proves which member
// they are with an existing `prm_` credential — Prince's grant ruling), receives a code, and exchanges it
// at /token for a short-lived, revocable, per-subscription access token bound to that member and principal.
//
// Every secret is hashed at rest exactly as `credentials.ts` hashes a `prm_` token (sha256 over 32 CSPRNG
// bytes — no dictionary, no KDF needed): a leaked table reveals no usable token. Prefixes make a token
// self-describing (`plo_at_` access, `plo_rt_` refresh, `plo_ac_` code, `plc_` client) so a log line names
// what it is and the /mcp resolver routes an OAuth access token apart from a `prm_` credential.

const ACCESS_TTL_S = 3600; // 1 hour — short-lived; the refresh token renews it
const REFRESH_TTL_S = 30 * 24 * 3600; // 30 days
const CODE_TTL_S = 300; // 5 minutes — a code is exchanged immediately or not at all

function secret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('hex')}`;
}

/** The PKCE S256 transform: base64url(sha256(verifier)), compared against the stored code_challenge. */
function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export interface RegisteredClient {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
}

/** Dynamic Client Registration (RFC 7591). A PUBLIC client — no secret; PKCE + the registered redirect_uris are the protection. */
export async function registerClient(
  pool: Pool,
  input: { redirect_uris: string[]; client_name?: string },
): Promise<RegisteredClient> {
  const client_id = `plc_${randomBytes(16).toString('hex')}`;
  await pool.query(
    'INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, $2, $3)',
    [client_id, input.client_name ?? null, input.redirect_uris],
  );
  return { client_id, redirect_uris: input.redirect_uris, client_name: input.client_name };
}

export async function getClient(pool: Pool, clientId: string): Promise<RegisteredClient | null> {
  const { rows } = await pool.query<{
    client_id: string;
    client_name: string | null;
    redirect_uris: string[];
  }>('SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = $1', [
    clientId,
  ]);
  const r = rows[0];
  return r
    ? {
        client_id: r.client_id,
        redirect_uris: r.redirect_uris,
        client_name: r.client_name ?? undefined,
      }
    : null;
}

/** Mint a single-use authorization code bound to (member, principal) and the PKCE challenge. Returns the plaintext. */
export async function createAuthCode(
  pool: Pool,
  input: {
    clientId: string;
    memberId: string;
    principalId: string;
    credentialId: string;
    codeChallenge: string;
    redirectUri: string;
    scope?: string;
  },
): Promise<string> {
  const code = secret('plo_ac_');
  await pool.query(
    `INSERT INTO oauth_codes (code_hash, client_id, member_id, principal_id, credential_id, code_challenge, redirect_uri, scope, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + ($9 * interval '1 second'))`,
    [
      hashSecret(code),
      input.clientId,
      input.memberId,
      input.principalId,
      input.credentialId,
      input.codeChallenge,
      input.redirectUri,
      input.scope ?? null,
      CODE_TTL_S,
    ],
  );
  return code;
}

export interface IssuedTokens {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope?: string;
}

async function issueTokens(
  pool: Pool,
  bind: {
    familyId: string;
    clientId: string;
    memberId: string;
    principalId: string;
    credentialId: string;
    scope: string | null;
  },
): Promise<IssuedTokens> {
  const access = secret('plo_at_');
  const refresh = secret('plo_rt_');
  await pool.query(
    `INSERT INTO oauth_tokens (token_hash, kind, family_id, client_id, member_id, principal_id, credential_id, scope, expires_at)
     VALUES ($1, 'access',  $3, $4, $5, $6, $7, $8, now() + ($9 * interval '1 second')),
            ($2, 'refresh', $3, $4, $5, $6, $7, $8, now() + ($10 * interval '1 second'))`,
    [
      hashSecret(access),
      hashSecret(refresh),
      bind.familyId,
      bind.clientId,
      bind.memberId,
      bind.principalId,
      bind.credentialId,
      bind.scope,
      ACCESS_TTL_S,
      REFRESH_TTL_S,
    ],
  );
  return {
    access_token: access,
    refresh_token: refresh,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_S,
    scope: bind.scope ?? undefined,
  };
}

export type ExchangeResult =
  { ok: true; tokens: IssuedTokens } | { ok: false; error: string; description?: string };

/**
 * Exchange an authorization code for tokens. SINGLE-USE by construction: the code is consumed in one UPDATE
 * that succeeds only if it is unconsumed and unexpired, so a replay finds nothing. Then the client and
 * redirect_uri must match what the code was minted with, and PKCE (S256) must verify.
 */
export async function exchangeCode(
  pool: Pool,
  input: { code: string; codeVerifier: string; clientId: string; redirectUri: string },
): Promise<ExchangeResult> {
  const { rows } = await pool.query<{
    client_id: string;
    member_id: string;
    principal_id: string;
    credential_id: string;
    code_challenge: string;
    redirect_uri: string;
    scope: string | null;
  }>(
    `UPDATE oauth_codes SET consumed_at = now()
      WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now()
      RETURNING client_id, member_id, principal_id, credential_id, code_challenge, redirect_uri, scope`,
    [hashSecret(input.code)],
  );
  const c = rows[0];
  if (!c)
    return {
      ok: false,
      error: 'invalid_grant',
      description: 'code invalid, expired, or already used',
    };
  if (c.client_id !== input.clientId)
    return { ok: false, error: 'invalid_grant', description: 'client mismatch' };
  if (c.redirect_uri !== input.redirectUri)
    return { ok: false, error: 'invalid_grant', description: 'redirect_uri mismatch' };
  if (s256(input.codeVerifier) !== c.code_challenge)
    return { ok: false, error: 'invalid_grant', description: 'PKCE verification failed' };
  // A fresh code exchange starts a new grant lineage (family). Every refresh from it shares this id, so the
  // whole grant can be severed at once and a replayed rotated refresh can invalidate its family.
  return {
    ok: true,
    tokens: await issueTokens(pool, {
      familyId: secret('plf_'),
      clientId: c.client_id,
      memberId: c.member_id,
      principalId: c.principal_id,
      credentialId: c.credential_id,
      scope: c.scope,
    }),
  };
}

/**
 * Exchange a refresh token for new tokens. ROTATION with REUSE DETECTION (OAuth 2.1 BCP §4.13.2):
 *
 * The consuming UPDATE requires the client to match too, so a wrong-client request does NOT burn the token.
 * On success the presented refresh is revoked and a new access+refresh are minted in the SAME family. On a
 * miss we look again without the "live" predicate: if the token exists as an ALREADY-REVOKED refresh, it is a
 * replay of a rotated token — the breach signal — and the whole family is revoked so the thief and the victim
 * both lose the grant. Any other miss (unknown/expired) is a plain invalid_grant.
 */
export async function exchangeRefresh(
  pool: Pool,
  input: { refreshToken: string; clientId: string },
): Promise<ExchangeResult> {
  const hash = hashSecret(input.refreshToken);
  const { rows } = await pool.query<{
    family_id: string;
    client_id: string;
    member_id: string;
    principal_id: string;
    credential_id: string;
    scope: string | null;
  }>(
    `UPDATE oauth_tokens SET revoked_at = now()
      WHERE token_hash = $1 AND kind = 'refresh' AND client_id = $2 AND revoked_at IS NULL AND expires_at > now()
      RETURNING family_id, client_id, member_id, principal_id, credential_id, scope`,
    [hash, input.clientId],
  );
  const t = rows[0];
  if (!t) {
    // Reuse detection: a refresh token that exists but is already revoked is a replay of a rotated token.
    const reused = await pool.query<{ family_id: string }>(
      `SELECT family_id FROM oauth_tokens WHERE token_hash = $1 AND kind = 'refresh' AND revoked_at IS NOT NULL`,
      [hash],
    );
    if (reused.rows[0]) {
      await revokeFamily(pool, reused.rows[0].family_id);
    }
    return {
      ok: false,
      error: 'invalid_grant',
      description: 'refresh token invalid, expired, revoked, or reused',
    };
  }
  return {
    ok: true,
    tokens: await issueTokens(pool, {
      familyId: t.family_id,
      clientId: t.client_id,
      memberId: t.member_id,
      principalId: t.principal_id,
      credentialId: t.credential_id,
      scope: t.scope,
    }),
  };
}

/** Revoke every still-live token in a grant lineage — the atom of "sever this subscription". */
async function revokeFamily(pool: Pool, familyId: string): Promise<void> {
  await pool.query(
    'UPDATE oauth_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL',
    [familyId],
  );
}

export interface OAuthAuth {
  member_id: string;
  principal_id: string;
  client_id: string;
  scope: string | null;
}

/**
 * Resolve an access token to the member/principal it authenticates, or null. Three things must hold, all in
 * the one query: the token is live (unrevoked, unexpired); the GRANTING credential is STILL live — so an
 * operator revoking a leaked prm_ credential cascades to every OAuth token minted from it; and the member
 * still exists — from which the CURRENT principal is re-derived, so the identity can never disagree with the
 * roster (the guarantee credentials.ts advertises), even if the member was re-bound after the token was issued.
 */
export async function verifyOAuthToken(pool: Pool, token: string): Promise<OAuthAuth | null> {
  const { rows } = await pool.query<OAuthAuth>(
    `SELECT t.member_id, m.principal_id, t.client_id, t.scope
       FROM oauth_tokens AS t
       JOIN member_credentials AS cr ON cr.id = t.credential_id
       JOIN members AS m ON m.id = t.member_id
      WHERE t.token_hash = $1 AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > now()
        AND cr.revoked_at IS NULL AND (cr.expires_at IS NULL OR cr.expires_at > now())`,
    [hashSecret(token)],
  );
  return rows[0] ?? null;
}

/**
 * Revoke a token (RFC 7009) — and, because a token is useless in isolation, its WHOLE FAMILY with it. Present
 * either the access or the refresh token and the entire grant is severed, so one /revoke actually cuts off a
 * compromised subscription rather than leaving the paired token live. An unknown token is a no-op, per spec.
 */
export async function revokeOAuthToken(pool: Pool, token: string): Promise<void> {
  await pool.query(
    `UPDATE oauth_tokens SET revoked_at = now()
      WHERE family_id = (SELECT family_id FROM oauth_tokens WHERE token_hash = $1) AND revoked_at IS NULL`,
    [hashSecret(token)],
  );
}

/** True for a Playroom OAuth ACCESS token — lets the /mcp resolver route it apart from a `prm_` credential. */
export function isOAuthAccessToken(token: string): boolean {
  return token.startsWith('plo_at_');
}

/** RFC 8414 authorization-server metadata — how a client discovers the endpoints. `issuer` is the api's base URL. */
export function authorizationServerMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'], // public client; PKCE, not a secret
    scopes_supported: ['playroom'],
  };
}

/** RFC 9728 protected-resource metadata — points a client at the authorization server for the /mcp resource. */
export function protectedResourceMetadata(issuer: string, resource: string) {
  return { resource, authorization_servers: [issuer] };
}
