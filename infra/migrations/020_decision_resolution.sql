-- 020_decision_resolution: a co-signature completes AT MOST ONCE (S2.2).
--
-- A decision's lifecycle is EVENTS, not a table. The CO_SIGN decision event is the pending state;
-- its resolution — a human's APPROVE or DENY — is a `decision.resolved` event carrying who signed and
-- as which principal. Status is DERIVED from the pair (PENDING when unresolved, EXPIRED when the
-- window has passed with no resolution, else APPROVED/DENIED), so nothing is stored that could drift
-- and — Bible §15.3 — nothing can time out INTO an approval or a denial: a resolution is an event a
-- person wrote, and expiry is only the ABSENCE of one. Same rule as the room summary (019): derived
-- room state, rebuildable from the log, never the only copy of anything. The decisions TABLE with a
-- nonce and consumed_at is still S2.1's; this is the room's event log.
--
-- What the database must guarantee, because an `if` cannot: a decision is resolved AT MOST ONCE. Two
-- approvals racing — a double-click, a retried frame, a second instance — must not both land, or an
-- approved action could fire twice (a summon that runs twice, a merge signed twice). The loser's
-- insert is refused by this index rather than by an in-process check, exactly as migrations 005 and
-- 006 refuse a second summon and a second turn. THE SINGLE-USE OF A CO-SIGNATURE IS A DATABASE FACT.
--
-- Partial, on the payload expression, like 005 and 019: `decision.resolved` shares the events table
-- and the uniqueness is meaningless for any other row. A decision may be resolved once per room.
CREATE UNIQUE INDEX IF NOT EXISTS events_one_resolution_per_decision
  ON events (room_id, (payload ->> 'decision_id'))
  WHERE event_type = 'decision.resolved';
