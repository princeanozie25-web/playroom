import type { Pool } from 'pg';
import { addressTokens } from './agent.js';

// Pending tags (B3). A member reached over MCP/the door is NOT summoned by a `@`-tag the way a hosted
// agent is (a summon starts a hosted turn; a connected member has none). So a message that names it lands
// with nothing to answer it — the tag is dropped. This surfaces those, as pollable items a subscription
// reads with the `list_pending_tags` tool, closing the inbound half of "drive a room from a subscription"
// (the notify half already ships via S-PUSH).
//
// "Pending" = a mention that arrived AFTER the member last acted in that room. It is derived, not stored:
// no ack table, no cursor — the member's own last event is the watermark, so participating drains the
// list. Imperfect (acting on something unrelated also clears older mentions) and deliberately so for v1;
// a precise per-mention acknowledgement is a later refinement. Detection reuses the summon rule's own
// `addressTokens`, so "pending" agrees, token for token, with "would have addressed me".

export interface PendingTag {
  room_id: string;
  seq: number;
  ts: string;
  /** The member who wrote the message that named you. */
  from: string;
  /** The message text, trimmed to a preview. */
  snippet: string;
}

const SNIPPET_MAX = 240;

/**
 * Every message that `@`-mentions this member, across the rooms it belongs to, that arrived after the
 * member's own last event in that room — newest first, bounded. Excludes the member's own messages and
 * the room's system notices; a mention from any other member (human or agent) is surfaced, with its
 * author, because this only INFORMS — it triggers nothing, so the summon barriers that stop injected text
 * from ACTING do not apply.
 */
export async function pendingTagsForMember(
  pool: Pool,
  memberId: string,
  limit = 50,
): Promise<PendingTag[]> {
  // The member's display name, so `@display_name` is matched as well as `@id` — the two forms the summon
  // rule makes addressable.
  const who = await pool.query<{ display_name: string }>(
    'SELECT display_name FROM members WHERE id = $1',
    [memberId],
  );
  const names = new Set([
    `@${memberId.toLowerCase()}`,
    `@${(who.rows[0]?.display_name ?? memberId).toLowerCase()}`,
  ]);

  // Coarse in SQL (my rooms, message events after my own last event there, not mine, not system, contains
  // an '@'); precise in JS (the exact token match). LIMIT bounds the candidate scan; mentions are rare and
  // recent, so the newest slice is the one that matters.
  const { rows } = await pool.query<{
    room_id: string;
    seq: string;
    ts: Date | string;
    actor_id: string;
    body: string | null;
  }>(
    `WITH my_rooms AS (
        SELECT room_id FROM room_members WHERE member_id = $1
     ),
     my_last AS (
        SELECT room_id, MAX(seq) AS last_seq FROM events WHERE actor_id = $1 GROUP BY room_id
     )
     SELECT e.room_id, e.seq, e.ts, e.actor_id, e.payload ->> 'body' AS body
       FROM events e
       JOIN my_rooms r ON r.room_id = e.room_id
       LEFT JOIN my_last l ON l.room_id = e.room_id
      WHERE e.event_type = 'message'
        AND e.actor_id <> $1
        AND e.actor_id <> 'system'
        AND e.seq > COALESCE(l.last_seq, 0)
        AND position('@' in COALESCE(e.payload ->> 'body', '')) > 0
      ORDER BY e.seq DESC
      LIMIT 500`,
    [memberId],
  );

  const out: PendingTag[] = [];
  for (const row of rows) {
    const body = row.body ?? '';
    if (!addressTokens(body).some((t) => names.has(t))) continue;
    out.push({
      room_id: row.room_id,
      seq: Number(row.seq),
      ts: row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
      from: row.actor_id,
      snippet: body.length > SNIPPET_MAX ? `${body.slice(0, SNIPPET_MAX)}…` : body,
    });
    if (out.length >= limit) break;
  }
  return out;
}
