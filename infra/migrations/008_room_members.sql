-- 008_room_members: a room gets a roster (S1.1b).
--
-- Additive only. One table, one member record, and a seed that records what is already
-- true. Nothing dropped, no existing row altered.
--
-- Until now `rooms` was (id, title, created_at) and nothing else. Every room could address
-- every member, and `events.actor_id` referred to nothing at all. Two things in the system
-- were waiting on this: Bible §9.2's `counterparties = roster_only` branch, which needs a
-- roster to check against and so was never written, and the summon rule, which resolved a
-- tag against the whole world.
--
-- INVITES ARE NOT HERE, DELIBERATELY. Adding a member to a room is a permission-bearing
-- act — who may invite whom is authority — and there is no authenticated inviter until
-- S1.2. An invite surface now would be the shell of an authority mechanism enforcing
-- nothing, which is the `room.post` and `mandate_label` pattern for the third time.

CREATE TABLE IF NOT EXISTS room_members (
  room_id   TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members (id),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A member belongs to many rooms; a room has many members. The composite key is the
  -- whole record: it makes a duplicate enrolment impossible rather than merely unlikely.
  PRIMARY KEY (room_id, member_id)
);

-- ON DELETE CASCADE on the room, and NOT on the member. Deleting a room should take its
-- roster with it — membership of a room that does not exist means nothing. Deleting a
-- MEMBER who is still enrolled somewhere should fail loudly instead, because that is a
-- person or an agent disappearing from rooms that still reference them.
CREATE INDEX IF NOT EXISTS room_members_member_idx ON room_members (member_id);

-- ── PRINCE BECOMES A RECORD ───────────────────────────────────────────────────────────
--
-- The film's human was a free string in `actor_id` with no referent anywhere. He is a
-- human member now, bound to the principal he already acted for — the same binding
-- `members` has enforced since 007, applied to the one actor that had been exempt from it
-- by virtue of not existing.
--
-- `display_name` is 'Prince' and the id stays 'prince', because `actor_id` already carries
-- that string in the log and in the film. Changing it would orphan every event he authored.
INSERT INTO members (id, kind, display_name, principal_id, adapter_id) VALUES
  ('prince', 'human', 'Prince', 'principal:prince', NULL)
ON CONFLICT (id) DO NOTHING;

-- ── SEED: RECORD WHAT IS ALREADY TRUE ─────────────────────────────────────────────────
--
-- Every existing room gets every existing member. That is not a policy choice — it is the
-- CURRENT BEHAVIOUR written down. Any room can already summon any member and any actor can
-- already post anywhere; this makes that fact a record instead of an absence of one.
--
-- Narrowing it here would change behaviour, and narrowing it correctly needs a way to
-- express exceptions, which is invites, which is S1.2. So the seed is deliberately total
-- and the interesting case arrives on its own: a member enabled AFTER a room was created is
-- not in that room, and the roster rules now have something real to refuse.
INSERT INTO room_members (room_id, member_id)
SELECT r.id, m.id FROM rooms AS r CROSS JOIN members AS m
ON CONFLICT DO NOTHING;

-- ── events.actor_member_id ────────────────────────────────────────────────────────────
--
-- THE SHAPE THE DATA PERMITS, and it is not the shape a straight foreign key would take.
--
-- `actor_id` cannot become `NOT NULL REFERENCES members (id)`. Three reasons, all present
-- in the log today rather than hypothetical:
--   * `system` authors the room's own notices — the in-flight refusal, the unknown-member
--     sentence. It is the room speaking. It is not a member, it has no principal, and
--     seeding a `system` member to satisfy a constraint would be fabricating a record to
--     make a check pass, which is the exact move this codebase keeps refusing.
--   * the log already contains `Fable` and `nobody-in-particular` — strings a caller
--     supplied. They are not members and never were.
--   * rejecting an unrecognised actor requires knowing who the caller really is, and
--     nothing does until S1.2. A NOT NULL constraint here would enforce a claim rather
--     than a fact.
--
-- So: a NULLABLE second column with a real foreign key. The database now guarantees that
-- when an event names a member, THAT MEMBER EXISTS. It does not yet guarantee that every
-- event names one. That is the structural half of S11a-N3; the authenticated half is S1.2's
-- and cannot be pulled forward by a schema change.
ALTER TABLE events ADD COLUMN IF NOT EXISTS actor_member_id TEXT REFERENCES members (id);

CREATE INDEX IF NOT EXISTS events_actor_member_idx
  ON events (actor_member_id) WHERE actor_member_id IS NOT NULL;

-- Backfill: every historical event whose actor_id happens to name a member now says so.
UPDATE events SET actor_member_id = actor_id
 WHERE actor_member_id IS NULL
   AND actor_id IN (SELECT id FROM members);
