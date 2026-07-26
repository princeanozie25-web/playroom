-- 005_one_summon_per_cause: a replayed frame cannot make an agent speak twice (S0.5a).
--
-- Additive only: one partial unique index, no columns, no rewrites.
--
-- FOUND BY THE PROPERTY TEST, not by reasoning. `appendMessage` is idempotent on
-- (room_id, client_msg_id), so a replayed send commits no second message — and the
-- command layer took that to mean it raised no second summon. It did. The duplicate
-- frame resolved to the already-committed message, read its `seq`, and went on to
-- summon and trigger a fresh turn against it. One human ask, two agent turns, both of
-- them honestly human-rooted: the zero query stayed at zero while the room filled with
-- output nobody asked for twice.
--
-- The natural key of a summon is therefore (room_id, cause_seq, member): a given event
-- may ask a given member to take a turn AT MOST ONCE. That holds unchanged in S0.5b,
-- where an agent-initiated summon still names a cause and a member.
--
-- WHY AN INDEX AND NOT AN `if (alreadyCommitted) return`. The check has to survive the
-- things a boolean does not: a process restart, a second instance, and two copies of the
-- same frame arriving close enough together that both `appendMessage` calls return the
-- same seq before either summons. Only the database can refuse the second one in all
-- three cases. (This does NOT close S05a-N1, which is a concurrent summon of one member
-- by two DIFFERENT messages — a different key, still guarded only in process.)
--
-- Expression index over JSONB rather than new columns: `cause_seq` and `member` are
-- payload facts, not log envelope facts, and 004 already spent its column budget on the
-- two fields the nightly query joins on. This index is probed on write, not by §19.

CREATE UNIQUE INDEX IF NOT EXISTS events_summon_cause_member_uniq
  ON events (room_id, (payload ->> 'cause_seq'), (payload ->> 'member'))
  WHERE event_type = 'summon';
