-- 018_room_codes: a short code that redeems for a credential and a seat (S-LIVE).
--
-- Additive. One table.
--
-- ── WHAT A ROOM CODE IS FOR ────────────────────────────────────────────────────────────
--
-- S1.3b's front door refuses anyone without a credential, which is correct and means a stranger at
-- a URL gets a 401. Handing out credentials directly does not work: the plaintext is 70 characters,
-- it is issued once, and a non-technical tester on a phone would be pasting a secret into a text
-- box — the exact jargon this slice was told to avoid, and a worse security story than the one it
-- replaces.
--
-- So the tester types something short and human, and the SERVER does the credential work. What they
-- type is not a secret to be checked against a hash; it is a one-time claim on a seat.
--
-- THE FRONT DOOR IS UNTOUCHED. Redemption ends with a perfectly ordinary member credential and a
-- perfectly ordinary `room_members` row, and every request after that walks the identical path with
-- the identical checks. A code is a way to BE ISSUED a credential, not a way to skip needing one.
--
-- ── ONE CODE, ONE SEAT, ONE PERSON, AND WHY IT CANNOT BE REUSED ────────────────────────
--
-- Each code binds to one guest principal — the tester's own principal, which owns the tester's own
-- agent. Redeeming names that principal after the person who redeemed it.
--
-- WHICH IS WHY A SLOT CANNOT BE HANDED TO A SECOND PERSON. Events record `actor_member_id`, so the
-- room's history holds acts by `guest-a`. Renaming that principal for a new tester would silently
-- re-attribute every past act to somebody who did not perform it — and attribution is the product,
-- not a feature of it. `redeemed_at` is therefore final: a redeemed code is spent, and a spent slot
-- is spent.
--
-- The practical consequence, stated because it bounds today's test: FOUR PRINCIPALS, so Prince,
-- Jerry and two external testers. A fifth needs an accent-palette decision (migration 017), not
-- another row here.
--
-- ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────────────────
--
-- No `uses` counter, no multi-use codes. A code that admits N people cannot give each of them their
-- own principal, and "each tester gets their own agent bound to their own principal" is the point.
-- If a tester loses their session, the answer is a new code for a new slot, or none — not a code
-- that lets two people share an identity.
--
-- No hash on the code. It is short by design, so hashing buys nothing against guessing that the
-- expiry and the one-use rule do not already buy: a guessed code costs the guesser a seat that a
-- human then cannot claim, which is visible immediately and reversible by minting another. The
-- CREDENTIAL it issues is hashed, and that is the secret.

CREATE TABLE IF NOT EXISTS room_codes (
  -- Short, uppercase, and from an alphabet with no O/0 or I/1 — see room-codes.ts. Typed by a
  -- person on a phone, so every character it cannot contain is a support question it cannot cause.
  code            TEXT PRIMARY KEY,
  room_id         TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  -- The seat: which guest principal this code hands over, and therefore which agent the tester
  -- gets. Constrained to a guest principal in room-codes.ts, because minting a code against
  -- `principal:prince` would hand a stranger my identity.
  principal_id    TEXT NOT NULL REFERENCES principals (id),
  -- Who this code is FOR, in my words, before they have given a name. Becomes the credential's
  -- label, so the audit log says 'room code: Amara (phone test)' rather than 'demo'.
  label           TEXT NOT NULL CHECK (length(btrim(label)) > 0),
  -- The CODE's expiry. Distinct from the credential's lifetime below: an unredeemed code should
  -- stop working long before a credential issued from it would.
  expires_at      TIMESTAMPTZ NOT NULL,
  -- How long the credential lasts once issued, in hours. On the code rather than hardcoded, so a
  -- two-hour test and a two-day test are the same mechanism with different numbers.
  credential_hours NUMERIC NOT NULL CHECK (credential_hours > 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      TEXT NOT NULL REFERENCES members (id),
  -- Spent, and by whom. NULL until redeemed; set once and never cleared.
  redeemed_at     TIMESTAMPTZ,
  redeemed_member TEXT REFERENCES members (id),
  CONSTRAINT room_codes_redemption_is_whole CHECK (
    (redeemed_at IS NULL AND redeemed_member IS NULL) OR
    (redeemed_at IS NOT NULL AND redeemed_member IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS room_codes_room_idx ON room_codes (room_id, created_at);

-- ONE UNREDEEMED CODE PER SEAT. Two live codes for the same guest principal is a race for one
-- identity: whoever redeems second is refused, having been told by a person that they had a code.
-- Enforced here rather than checked in application code, because the check would be a SELECT
-- followed by an INSERT and there is nothing between them.
CREATE UNIQUE INDEX IF NOT EXISTS room_codes_one_live_per_principal
  ON room_codes (principal_id) WHERE redeemed_at IS NULL;
