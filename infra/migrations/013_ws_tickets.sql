-- 013_ws_tickets: the socket stops carrying a long-lived credential (S1.3c).
--
-- Additive only. One table.
--
-- ── WHY A TICKET AT ALL ────────────────────────────────────────────────────────────────
--
-- S13-N3, both faces. A browser cannot set headers on a WebSocket handshake — the constructor
-- takes a URL and a subprotocol list, by specification — so S1.2 put the member credential in
-- the query string, where it lands in any access log and in browser history. And the page
-- handed that same credential to a client component as a prop, so it was serialised into the
-- HTML: anyone who could read the page could connect as that member, indefinitely.
--
-- A ticket makes both harmless. It is worth one socket, for one member, on one room, for
-- thirty seconds. A ticket in a log line is worthless by the time anyone reads the log; a
-- ticket in a page is worthless by the time anyone views the source.
--
-- ── ROWS, NOT SIGNATURES, AND THE REASON IS SINGLE USE ────────────────────────────────
--
-- A signed ticket (HMAC, JWT) gives expiry for free and CANNOT give consumption: proving a
-- ticket has not been used before requires remembering the ones that have, which is a store
-- with different words on it. Single use is the property that matters here — expiry alone
-- leaves a thirty-second replay window on every connect — so the store is not avoidable and a
-- signature would only add a second mechanism next to it.
--
-- So: rows, consumed by an atomic UPDATE. The same discipline as migrations 005 and 006 — two
-- handshakes racing the same ticket are separated by the database, and an `if` in application
-- code decides correctly and still loses the race.
--
-- ── HASHED, LIKE EVERY OTHER SECRET AT REST ────────────────────────────────────────────
--
-- Thirty seconds is short and it is not zero. A leaked table read would otherwise hand over
-- every unconsumed ticket in flight; hashing costs one sha256 and removes that. Same reasoning
-- as `member_credentials`, and the same function.

CREATE TABLE IF NOT EXISTS ws_tickets (
  id           TEXT PRIMARY KEY,
  ticket_hash  TEXT NOT NULL UNIQUE,
  -- BOUND TO A MEMBER AND A ROOM. The member is who the socket becomes; the room is where the
  -- ticket may be spent. Without the room binding a ticket is a thirty-second bearer for any
  -- room the member can reach, which is a smaller hole than the one being closed and still a
  -- hole for one column and one comparison.
  member_id    TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  room_id      TEXT NOT NULL,
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ
);

-- NO FOREIGN KEY ON room_id, deliberately. A ticket may be issued for a room that does not
-- exist, and must be: the issuing route asks no authorisation question at all, so that it
-- cannot become an oracle for which rooms exist. The handshake is the single place that
-- decides whether a member may join a room, and it already answers identically for a missing
-- room and a room you are not in (S1.3b).

-- The consume path: one lookup by hash. Partial on the live rows, because a consumed ticket
-- must never be found by it — the row survives so a REUSE can be told from a FABRICATION in
-- the log.
CREATE INDEX IF NOT EXISTS ws_tickets_live_idx
  ON ws_tickets (ticket_hash) WHERE consumed_at IS NULL;

-- The sweep path. Bounded growth is not automatic: S12-N3 was 479 credentials nobody deleted,
-- and a table written on every connect grows faster than that. `issueTicket` deletes what has
-- been dead for five minutes, so the table stays proportional to traffic in flight rather than
-- to traffic ever served — no scheduler, and the test measures it rather than assuming it.
CREATE INDEX IF NOT EXISTS ws_tickets_expiry_idx ON ws_tickets (expires_at);
