-- ═══ S-PUSH — WHERE A NOTIFICATION IS ALLOWED TO GO ═══════════════════════════════════
--
-- SL2-N4: a raised hand reaches nobody whose room is closed, which is why the attendance dial is
-- gated at 1. A loop that stops silently is a loop nobody can leave running. This table is the
-- first half of closing that: the set of places the server may send to.
--
-- ── IT BELONGS TO A HUMAN PRINCIPAL, NOT A MEMBER AND NOT A BROWSER ──────────────────
--
-- A PRINCIPAL is the person; a MEMBER is a seat at a table (§7.1, migration 007). Attention is
-- claimed from a person, so a subscription is theirs — one human, several browsers, several rows.
-- Keying on the member would have meant a phone that stops receiving the moment the same person
-- acts through a different seat, and keying on the browser alone would have meant a row that
-- belongs to nobody the fabric can name.
--
-- `created_by_member` is kept anyway, and it is NOT the owner: it records WHICH SEAT registered
-- this browser, so a subscription can be traced to the act that created it. Authority is read
-- from `principal_id`; provenance is read from here. They are different questions and the row
-- answers both rather than conflating them.
--
-- ── THE ENDPOINT IS THE IDENTITY, AND IT IS UNIQUE ───────────────────────────────────
--
-- Web Push gives no per-browser id except the endpoint URL the vendor mints. UNIQUE on it, so a
-- browser that re-subscribes (a permission re-grant, a vendor rotation) UPDATES its row instead of
-- accumulating duplicates that would each get their own copy of every notification. A person with
-- one phone gets one notification because the database says so, not because the sender remembers.
--
-- ── WHAT IS IN HERE IS SENSITIVE, AND IT IS NOT A PLAYROOM SECRET ────────────────────
--
-- `p256dh` and `auth` are the browser's own encryption material (RFC 8291). They are not
-- credentials for anything in this system and they grant no access to it — but with them a holder
-- can encrypt a payload this phone will accept, so they are treated as secret: never logged, never
-- in an error payload, never returned by any read route. S-SCRUB discipline, asserted in the tests
-- this slice adds. The columns are TEXT because they arrive base64url from the browser.
--
-- ── WHAT THIS TABLE DELIBERATELY DOES NOT HAVE ───────────────────────────────────────
--
-- No `revoked_at`. A subscription is not an authority record with a history worth keeping; it is a
-- live address. "Off" means the row is DELETED — a person who turns notifications off and finds a
-- row still bearing their endpoint has been told something untrue. The same reasoning deletes a
-- row the vendor has expired (404/410 on send, RFC 8030): a dead address that lingers is a
-- delivery someone believes in that does not exist.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id                TEXT PRIMARY KEY,
  -- WHOSE ATTENTION THIS REACHES. The FK is the authority binding; there is no column for anyone
  -- to name a different one, which is what makes a cross-principal write unexpressible rather
  -- than merely refused (the UI3-1 rule: enforce by absence).
  principal_id      TEXT NOT NULL REFERENCES principals (id),
  -- The vendor's per-browser URL. UNIQUE: one browser, one row, one notification.
  endpoint          TEXT NOT NULL UNIQUE,
  -- The browser's RFC 8291 key material. Secret, never read back out over any route.
  p256dh            TEXT NOT NULL,
  auth              TEXT NOT NULL,
  -- PROVENANCE, not authority: which seat registered this browser.
  created_by_member TEXT NOT NULL REFERENCES members (id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The last time the vendor accepted a send. Null until one succeeds. Diagnostic only: a person
  -- asking "is this thing on" deserves an answer that is not a guess.
  last_ok_at        TIMESTAMPTZ
);

-- The send path's only lookup: every live address for the person being told.
CREATE INDEX IF NOT EXISTS push_subscriptions_principal_idx
  ON push_subscriptions (principal_id);
