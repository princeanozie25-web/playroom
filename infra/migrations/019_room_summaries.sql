-- 019_room_summaries: idempotency for the rolling summary (S16-1).
--
-- A room's rolling summary is a `room.summary` EVENT, not a table. It is derived room state —
-- reconstructible from the messages it compresses, which still exist — and so it follows the same
-- rule as every other projection in this log: rebuildable, never the only copy of anything.
--
-- This index makes "at most one summary per coverage point" a DATABASE fact rather than an
-- in-process convention. `covers_through_seq` is the highest message seq a summary represents;
-- two maintenance runs that both try to fold to the same seq — a restart mid-fold, or a second
-- instance that never knew about the first — cannot both land. The loser's insert is refused by
-- the index (ON CONFLICT DO NOTHING) rather than by an `if`, which is the same discipline
-- migrations 005 and 006 use for one-summon-per-cause and one-turn-per-summon.
--
-- Partial, on the payload expression, exactly like 005: `room.summary` is one event type sharing
-- the events table, and the uniqueness is meaningless for any other row.
CREATE UNIQUE INDEX IF NOT EXISTS events_one_summary_per_cover
  ON events (room_id, (payload ->> 'covers_through_seq'))
  WHERE event_type = 'room.summary';
