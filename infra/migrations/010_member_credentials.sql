-- 010_member_credentials: a secret that maps to a member (S1.2).
--
-- Additive only. One table.
--
-- THE SMALLEST THING THAT CAN DEFEND THE HANDSHAKE. Not OAuth, not a login, not a password —
-- a credential this slice can defend is one that maps a secret to a member and can be
-- rotated. The credential is replaceable; the SHAPE is not. What matters is that after this
-- slice the wire cannot express "I am this actor", so swapping this table for a real identity
-- provider later changes one module instead of five findings.
--
-- WHAT IT PROVES, precisely, because overstating this would be the whole failure: the holder
-- of a token is the member that token was issued to. It does NOT prove a person. There is no
-- login, no second factor and no per-human key, so a token in an env var authenticates a
-- PROCESS acting as a member — which is exactly what an agent gateway is, and only
-- approximately what a browser is. S04-N2 stays open for that reason; see the red-team log.

CREATE TABLE IF NOT EXISTS member_credentials (
  id         TEXT PRIMARY KEY,
  member_id  TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  -- HASHED AT REST. The plaintext is returned once, at issue, and never stored: a credential
  -- table that can be read back is a credential table that leaks on the first bad backup.
  -- sha256 with no salt is deliberate and sufficient HERE: the input is 32 bytes of CSPRNG
  -- output, so there is no dictionary to attack and no password to stretch. A salt would
  -- prevent the indexed lookup below and buy nothing against a random 256-bit secret.
  token_hash TEXT NOT NULL UNIQUE,
  -- Who or what holds it — 'browser (dev)', 'capture harness'. Rotation is: issue a new one
  -- with the same label, then revoke the old. Nothing is ever updated in place.
  label      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

-- Authentication is one indexed lookup of a hash. Partial on the active rows, because a
-- revoked credential must never be found — revocation is the point of keeping the row.
CREATE INDEX IF NOT EXISTS member_credentials_active_idx
  ON member_credentials (token_hash) WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS member_credentials_member_idx ON member_credentials (member_id);

-- ── EVERY NON-SYSTEM EVENT NAMES A REAL MEMBER ────────────────────────────────────────
--
-- S11b added `actor_member_id` as a NULLABLE column with a foreign key, and said why a
-- straight NOT NULL was impossible: `system` authors the room's own notices and is not a
-- member, and rejecting an unrecognised actor required knowing who the caller really is.
--
-- The second reason is now gone — the caller is authenticated — so the constraint can be
-- tightened. NOT to NOT NULL, because `system` is still not a member and seeding one to
-- satisfy a check would be fabricating a record to make a constraint pass. Instead: every
-- event either names a member or is the room speaking. Nothing else.
--
-- NOT VALID, deliberately. The log already contains rows written before authentication
-- existed — `Fable` and other names a caller supplied — and this is an APPEND-ONLY log.
-- Validating retroactively would mean rewriting or deleting history to make a new rule look
-- like it always held. The constraint governs every write from here on, which is what it is
-- for, and the historical rows stay visibly historical.
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_actor_is_member_or_system;
ALTER TABLE events ADD CONSTRAINT events_actor_is_member_or_system
  CHECK (actor_member_id IS NOT NULL OR actor_id = 'system') NOT VALID;
