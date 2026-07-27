-- 016_promotions: promotion is an ACT WITH A RECORD, not a copy (S1.5, Bible §7.2).
--
-- Additive. One table.
--
-- ── WHY A RECORD AND NOT A COPY ────────────────────────────────────────────────────────
--
-- Moving text from a principal's private store into a room is a DISCLOSURE. It cannot be undone:
-- the moment it lands, every member of the room has read it, and deleting the row afterwards
-- changes what is on screen and nothing about what was learned.
--
-- So the thing that has to exist is not a mechanism for copying. It is a record of who disclosed
-- what, to which room, under what representation, and WHY — written BEFORE the disclosure, because
-- a record written afterwards is a record that can be skipped when the copy is the urgent part.
--
-- "Record first" is not an ordering convention here. The text that reaches the room is READ BACK
-- FROM THIS ROW (see promotions.ts): the copy is derived from the record, so a copy without a
-- record has nothing to be derived from.
--
-- ── EVERY COLUMN IS SOMETHING SOMEONE WILL LATER NEED TO ASK ───────────────────────────
--
-- §7.2 names them and each answers a question that gets asked after an incident, not before:
--
--   source_principal   whose private context was this
--   source_item_id     WHICH item — provenance, so "where did this come from" has an answer
--   room_id            who can now read it
--   content_hash       what EXACTLY was disclosed, byte for byte
--   representation     verbatim, or the summary — how much was disclosed
--   purpose            why. Free text and NOT NULL, because a purpose nobody had to write is a
--                      purpose nobody had to have.
--   approved_by        the member who consented, and it must be a HUMAN member of the source
--                      principal. Enforced in promotions.ts against the members table, not here,
--                      because it is a join and a CHECK cannot see another row.
--   created_at         when
--
-- NO FOREIGN KEY ON source_item_id, DELIBERATELY. `principal_context` rows can be deleted; this
-- record must survive that. A disclosure that happened cannot be made not to have happened by
-- deleting the source, and a FK with ON DELETE CASCADE would erase the evidence along with the
-- item — which is precisely backwards. The id is kept as text so the provenance still names what
-- it was, even once the thing is gone.
--
-- ── MINIMISATION IS THE DEFAULT, NOT AN OPTION (§7.3) ──────────────────────────────────
--
-- `representation` defaults to 'summary'. When an item has a summary, promoting it shares the
-- shorter form unless the promoter explicitly asks for verbatim — the default is the less
-- revealing one, so forgetting to think about it discloses less rather than more.

CREATE TABLE IF NOT EXISTS promotions (
  id               TEXT PRIMARY KEY,
  source_principal TEXT NOT NULL REFERENCES principals (id),
  source_item_id   TEXT NOT NULL,
  room_id          TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  -- SHA-256 of the exact text placed in the room. Lets anyone check later that the line shown is
  -- the line recorded, without the record having to hold a second copy of the content.
  content_hash     TEXT NOT NULL,
  representation   TEXT NOT NULL DEFAULT 'summary'
                     CHECK (representation IN ('verbatim', 'summary')),
  -- The disclosed text itself. It IS in the room's log too; it is here because the room event is
  -- derived from this row rather than the other way round, and because a record of a disclosure
  -- that cannot say what was disclosed is an audit trail with the audit missing.
  content          TEXT NOT NULL,
  purpose          TEXT NOT NULL CHECK (length(btrim(purpose)) > 0),
  approved_by      TEXT NOT NULL REFERENCES members (id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS promotions_room_idx ON promotions (room_id, created_at);
CREATE INDEX IF NOT EXISTS promotions_source_idx ON promotions (source_principal, created_at);
