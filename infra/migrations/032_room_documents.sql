-- 032 — A DOCUMENT GIVEN TO A ROOM (S-UPLOAD, SU-1).
--
-- `claude-audit` spent six cycles asking for a file it could not open. Its window is five parts and
-- none of them is a filesystem; the only way material reached it was §15 and §17 pasted as three
-- messages by hand, because the door caps a message body at 8,000 characters (server.ts:1167).
--
-- ── AN UPLOAD IS A PROMOTION (S1.5), SO THE RECORD PRECEDES THE COPY ────────────────
--
-- Same discipline `promotions` (016) and `room_briefings` (026) hold: the row is written first and
-- the room event is DERIVED from it (`RETURNING`), never the other way round. A record of a
-- disclosure that cannot say what was disclosed is an audit trail with the audit missing.
--
-- ── ITS OWN TABLE, AND WHY NOT `promotions` ────────────────────────────────────────
--
-- Ruling B. `promotions.source_item_id` is NOT NULL and means "the item in a principal's private
-- store that this promotion came FROM". An upload has no such source — it arrives from outside the
-- system entirely. Making that column nullable would erode a column that currently means something,
-- for every existing row. And the lifecycles differ: promotions are one-at-a-time and arrive from
-- within; documents are many, additive, and arrive from outside. The same reasoning gave
-- `room_briefings` its own table rather than widening `promotions`, and it applies again.
--
-- The SHAPE is taken from `promotions` because it is closer to right than the briefing's, plus the
-- two things it lacks: `size_chars` and `declared_type`.
--
-- ── ABSENT AND REMOVED ARE DIFFERENT STATES ────────────────────────────────────────
--
-- `removed_at` rather than a DELETE. A room that never had a document and a room whose document was
-- taken back are not the same fact, and a reader of the log must be able to tell them apart — the
-- same reason `room_briefings` clears rather than deletes, and the same reason a revoked credential
-- keeps its row.

CREATE TABLE IF NOT EXISTS room_documents (
  id            TEXT PRIMARY KEY,
  room_id       TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  -- WHO GAVE IT. A human member; the command refuses an agent by kind before reaching here, and this
  -- foreign key is what makes the refusal checkable afterwards rather than merely logged.
  uploaded_by   TEXT NOT NULL REFERENCES members (id),
  -- WHAT IT IS FOR, in the uploader's words. Required and non-blank: a document with no stated
  -- purpose is reference material nobody can decide the relevance of, including the member reading it.
  purpose       TEXT NOT NULL CHECK (length(btrim(purpose)) > 0),
  -- WHERE IT CAME FROM — the original filename or origin as the uploader gave it. Recorded as
  -- PROVENANCE, never trusted: it is a label on untrusted text, not a claim about the text.
  provenance    TEXT NOT NULL CHECK (length(btrim(provenance)) > 0),
  -- The title a reader sees. Distinct from provenance so a file called `notes-final-v3.txt` can be
  -- shown as what it actually is.
  title         TEXT NOT NULL CHECK (length(btrim(title)) > 0),
  -- SHA-256 of the exact text stored, so anyone can check later that what a member read is what was
  -- given — without a second copy of the content living in the record of it.
  content_hash  TEXT NOT NULL,
  content       TEXT NOT NULL,
  -- SIZE AND TYPE, the two fields `promotions` lacks. `size_chars` is denormalised deliberately: the
  -- room-total cap is enforced by summing it, and a cap that had to read every document's body to
  -- decide would read the whole room to refuse one upload.
  size_chars    INTEGER NOT NULL CHECK (size_chars > 0),
  -- What the uploader SAID it is. A declaration, not a verdict — the screen that reads it is
  -- mechanical (documents.ts), and this column records the claim it was checked against.
  declared_type TEXT NOT NULL CHECK (length(btrim(declared_type)) > 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL while the document is in the room. Set when a person takes it back — explicit and evented.
  removed_at    TIMESTAMPTZ
);

-- The assembly read: every ACTIVE document for one room, oldest first, on the path of every summon.
-- Partial, because a removed document is never assembled and should not be walked to discover that.
CREATE INDEX IF NOT EXISTS room_documents_active_idx
  ON room_documents (room_id, created_at)
  WHERE removed_at IS NULL;
