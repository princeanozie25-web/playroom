-- 034 — OAUTH FOR THE SUBSCRIPTION LOGIN (S4.1 / B2).
--
-- B1 let a subscription drive a room by pasting a `prm_` credential into the MCP client config — a
-- long-lived bearer, copied by hand. This adds the proper front door: an OAuth 2.1 authorization-code +
-- PKCE flow so a Claude subscription obtains a SHORT-LIVED, REVOCABLE, per-subscription token, bound to a
-- member and principal, without a human login system existing yet.
--
-- ── THE GRANT IS A `prm_` CREDENTIAL (Prince's ruling) ──────────────────────────────────
--
-- There is no password store and no session. So the resource owner proves WHICH member they are the one
-- way the system already trusts: by presenting an existing `prm_` credential once, at the consent step
-- (`credentials.ts` authenticate). The credential is verified and DISCARDED — never stored here; only the
-- member/principal it resolved to is bound to the issued code and tokens. Turning a custodial seat token
-- into a subscription identity, which is exactly B2's job.
--
-- ── THREE TABLES, THREE LIFETIMES ───────────────────────────────────────────────────────
--
--   oauth_clients — a registered MCP client (Dynamic Client Registration). Long-lived; a public client
--     (no secret) identified by redirect_uris, which is what PKCE protects instead of a secret.
--   oauth_codes   — a single-use authorization code. Seconds-lived: minted at consent, consumed at /token,
--     `consumed_at` set so a replay is refused. Hashed, like every secret in this system (sha256, §credentials).
--   oauth_tokens  — the issued access and refresh tokens. Hashed; `kind` distinguishes them; `expires_at`
--     enforced in the lookup (not a sweep); `revoked_at` for /revoke and rotation. Bound to member+principal
--     so an authenticated request resolves to the same (member, principal) a `prm_` credential does.

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_name   TEXT,
  redirect_uris TEXT[] NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL REFERENCES oauth_clients (client_id),
  member_id      TEXT NOT NULL,
  principal_id   TEXT NOT NULL,
  credential_id  TEXT NOT NULL,          -- the prm_ credential that granted this — its life gates the tokens
  code_challenge TEXT NOT NULL,          -- PKCE S256 challenge; the verifier is checked at /token
  redirect_uri   TEXT NOT NULL,          -- must match the /token request's redirect_uri
  scope          TEXT,
  expires_at     TIMESTAMPTZ NOT NULL,
  consumed_at    TIMESTAMPTZ             -- set on first exchange; a second attempt is refused
);

-- `family_id` and `credential_id` are the two links the lifecycle needs (added after the B2 review):
--   * family_id  — one grant's lineage (the code exchange and every refresh from it share it), so a
--     compromised subscription is severed with ONE revocation and a replayed rotated refresh token can
--     invalidate its whole family (OAuth 2.1 BCP breach detection).
--   * credential_id — the prm_ credential that granted the tokens. verifyOAuthToken joins it, so revoking
--     that credential (the operator's response to a leak) cascades to the tokens minted from it, and the
--     member/principal stay honest with the roster because verify re-derives them from `members`.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash    TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,           -- 'access' | 'refresh'
  family_id     TEXT NOT NULL,           -- the grant lineage; revocation and reuse-detection act on it
  client_id     TEXT NOT NULL REFERENCES oauth_clients (client_id),
  member_id     TEXT NOT NULL,
  principal_id  TEXT NOT NULL,
  credential_id TEXT NOT NULL,           -- the granting prm_ credential; verify joins it so its revocation cascades
  scope         TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_tokens_member_idx ON oauth_tokens (member_id);
CREATE INDEX IF NOT EXISTS oauth_tokens_family_idx ON oauth_tokens (family_id);
