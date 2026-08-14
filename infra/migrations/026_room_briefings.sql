-- 026_room_briefings: the ROOM BRIEFING — owner-authored framing, pinned to the room (S1.7).
--
-- Additive. One new column and one new table.
--
-- ── WHY A ROOM NEEDS AN OWNER, AND WHY IT DID NOT UNTIL NOW ─────────────────────────────
--
-- A briefing is set by ONE person — the room's owner — and by no one else. Until now a room had
-- no recorded owner: `createRoom` enrolled its creator but stored nothing about who that was, so a
-- creator was indistinguishable from every other enrolled member the moment the transaction closed.
-- `tasks` (011) and `room_codes` (018) already carry `created_by TEXT REFERENCES members(id)`; this
-- gives `rooms` the same, and `createRoom` fills it going forward.
--
-- NULLABLE, DELIBERATELY. Existing rooms have no record of who made them, and there is nothing
-- honest to back-date the column to — inventing an owner would be worse than admitting there is
-- none. A room with a NULL owner is UN-BRIEFABLE (fail-closed): the set command refuses it by a
-- named reason, rather than letting the first member to ask become the owner by accident.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES members (id);

-- ── THE BRIEFING RECORD — THE S1.5 SHAPE, NOT A NEW ONE ─────────────────────────────────
--
-- A briefing is a promotion pinned to the room, so it carries the same things a promotion does and
-- for the same reasons (§7.2): PURPOSE (why this framing, free text, NOT NULL), PROVENANCE (who set
-- it, in which room) and a content HASH (what exactly the room was told, byte for byte). Written as a
-- RECORD BEFORE THE COPY: the room event `briefing.set` is derived from this row (see briefings.ts),
-- so a copy in the log has nothing to be derived from until the record exists.
--
-- What differs from `promotions` (016): a briefing is OWNER-AUTHORED TEXT, not a private store item
-- moved into the room — so there is no `source_principal` / `source_item_id` and no `representation`.
-- The consented actor is the owner (`set_by`), not a promoter of someone else's context.
CREATE TABLE IF NOT EXISTS room_briefings (
  id            TEXT PRIMARY KEY,
  room_id       TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  -- The framing itself. NOT NULL and non-blank: there is NO IMPLICIT EMPTY BRIEFING — absent (no
  -- active row) and a briefing are different states, and an empty string is neither, so it is refused
  -- here as well as at set time. The SIZE cap (a briefing is paid on every summon) is enforced in the
  -- command with an honest reason, not as a magic-number CHECK that would drift from the constant.
  content       TEXT NOT NULL CHECK (length(btrim(content)) > 0),
  -- SHA-256 of `content`, so the line the room shows can be checked against the record — exactly as
  -- a promotion's content_hash does, and exactly as the mandate surface identifies a document.
  content_hash  TEXT NOT NULL,
  purpose       TEXT NOT NULL CHECK (length(btrim(purpose)) > 0),
  -- The member who set it. Its OWNERSHIP is checked in the command against `rooms.created_by`; its
  -- HUMANNESS is checked against `members.kind` — an agent may never set a briefing. FK, not a claim.
  set_by        TEXT NOT NULL REFERENCES members (id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL = this is the ACTIVE briefing. Set = it was replaced or cleared, and stays as history. A
  -- briefing is never deleted: "what the room was told and when it changed" is the audit trail, and a
  -- delete would erase it. Replacing is clear-then-insert in one transaction (briefings.ts).
  cleared_at    TIMESTAMPTZ
);

-- AT MOST ONE ACTIVE BRIEFING PER ROOM — enforced at the database, not in application code, the same
-- discipline migrations 005/006/020 use for their invariants. A partial unique index over the active
-- rows: a room has one briefing or none, never two, even under a racing double-set.
CREATE UNIQUE INDEX IF NOT EXISTS room_briefings_one_active
  ON room_briefings (room_id) WHERE cleared_at IS NULL;

-- The active-briefing read (assembly and the history endpoint) and the room-ordered history read.
CREATE INDEX IF NOT EXISTS room_briefings_room_idx ON room_briefings (room_id, created_at);
