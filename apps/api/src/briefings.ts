import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { ServerEvent } from '@playroom/shared';
import { appendBriefingSet, appendBriefingCleared } from './events.js';

/**
 * THE ROOM BRIEFING — owner-authored framing pinned to the room (S1.7, Bible §7.2).
 *
 * ── WHAT A BRIEFING IS, AND WHAT IT IS NOT ──
 *
 * A briefing is a PROMOTION PINNED TO THE ROOM: the S1.5 record shape (purpose, provenance, hash,
 * written before any copy), carrying framing every summoned member inherits and every puller can
 * read. It is set once and inherited by every cycle — the pasting the loop was meant to end.
 *
 * A briefing CONFERS ZERO AUTHORITY. It configures framing; the mandate configures authority. Nothing
 * in a briefing can widen what a member may do — it is delivered as inert assembled CONTEXT (its own
 * event type, never a `message`, so it cannot activate a summon — RA-005), and a member's evaluated
 * authority is byte-identical with and without one. This file writes the RECORD; ownership and
 * humanness are checked in the command before it is ever called.
 *
 * ── RECORD BEFORE COPY, STRUCTURALLY ──
 *
 * Exactly as promotions.ts: the room event is derived from the row that records it (`RETURNING`), so a
 * copy in the log has nothing to be derived from until the record exists. Set/replace and clear are
 * each ONE transaction — a failure leaves neither a record nor a copy, and never two active briefings.
 *
 * ── ABSENT, PRESENT, CLEARED — three states, kept distinct ──
 *
 * `activeBriefing` returns a row or null. NULL is ABSENT: no region is delivered, nothing rendered.
 * A present row always has non-empty content (blank refused at set time and by a CHECK). CLEARED is
 * absent-again-but-on-the-record: a `briefing.cleared` event exists, so history distinguishes a room
 * that was briefed and cleared from one that never had a briefing. Empty is never a state a briefing
 * reaches — there is no implicit empty briefing.
 */

/** The largest a briefing may be. Paid on every summon, so it is capped and refused — never truncated. */
export const BRIEFING_MAX_CHARS = 2000;

export interface BriefingRow {
  id: string;
  room_id: string;
  content: string;
  content_hash: string;
  purpose: string;
  set_by: string;
  created_at: string;
  /** NULL for the active briefing; a timestamp once replaced or cleared. */
  cleared_at: string | null;
}

const BRIEFING_COLS = 'id, room_id, content, content_hash, purpose, set_by, created_at, cleared_at';

export function briefingContentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The room's ACTIVE briefing, or null when it has none (absent, or cleared). One indexed read of the
 * single `cleared_at IS NULL` row — the shape `latestRoomSummary` has, and the read assembly and the
 * history endpoint both use.
 */
export async function activeBriefing(pool: Pool, roomId: string): Promise<BriefingRow | null> {
  const { rows } = await pool.query<BriefingRow>(
    `SELECT ${BRIEFING_COLS} FROM room_briefings
      WHERE room_id = $1 AND cleared_at IS NULL
      LIMIT 1`,
    [roomId],
  );
  return rows[0] ?? null;
}

/**
 * Set or replace the room's briefing. ONE transaction: clear the prior active briefing (if any),
 * insert the new active record, then derive the `briefing.set` event from that record. `replaces_hash`
 * is the prior briefing's hash — the BEFORE to this event's AFTER, so a replacement is legible from the
 * log alone.
 *
 * The caller has already checked ownership, humanness, non-blank content/purpose and the size cap:
 * this writes the record and refuses nothing except at the database's own invariants (non-blank CHECK,
 * one-active partial unique index).
 */
export async function setBriefing(
  pool: Pool,
  input: { roomId: string; content: string; purpose: string; setBy: string },
): Promise<{ briefing: BriefingRow; event: ServerEvent }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // THE PRIOR ACTIVE BRIEFING, if any — read inside the transaction and cleared, so the one-active
    // index cannot be violated by a racing set: the loser blocks on this row and then sees it cleared.
    const prior = (
      await client.query<BriefingRow>(
        `SELECT ${BRIEFING_COLS} FROM room_briefings
          WHERE room_id = $1 AND cleared_at IS NULL
          FOR UPDATE`,
        [input.roomId],
      )
    ).rows[0];
    if (prior) {
      await client.query('UPDATE room_briefings SET cleared_at = now() WHERE id = $1', [prior.id]);
    }

    // THE RECORD, written before anything is in the room. `RETURNING content` is not decoration: the
    // event below is built from what came back out of this row, so the copy is derived from the record.
    const { rows } = await client.query<BriefingRow>(
      `INSERT INTO room_briefings (id, room_id, content, content_hash, purpose, set_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${BRIEFING_COLS}`,
      [
        `brief_${randomBytes(8).toString('hex')}`,
        input.roomId,
        input.content,
        briefingContentHash(input.content),
        input.purpose,
        input.setBy,
      ],
    );
    const briefing = rows[0];

    // THE COPY, derived from the record. `briefing.set`, its own event type — see events.ts / RA-005.
    const event = await appendBriefingSet(client, input.roomId, input.setBy, {
      briefing_id: briefing.id,
      content: briefing.content,
      content_hash: briefing.content_hash,
      purpose: briefing.purpose,
      set_by: briefing.set_by,
      replaces_hash: prior?.content_hash ?? null,
    });
    await client.query('COMMIT');
    return { briefing, event };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      /* connection may be unusable; release still returns it */
    });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Clear the room's briefing. Returns null when there is no active briefing to clear — the command
 * turns that into a refusal rather than writing a clear-of-nothing, keeping absent and cleared distinct.
 * One transaction: mark the active row cleared and derive the `briefing.cleared` event from it.
 */
export async function clearBriefing(
  pool: Pool,
  input: { roomId: string; clearedBy: string },
): Promise<{ briefing: BriefingRow; event: ServerEvent } | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const active = (
      await client.query<BriefingRow>(
        `SELECT ${BRIEFING_COLS} FROM room_briefings
          WHERE room_id = $1 AND cleared_at IS NULL
          FOR UPDATE`,
        [input.roomId],
      )
    ).rows[0];
    if (!active) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query('UPDATE room_briefings SET cleared_at = now() WHERE id = $1', [active.id]);
    const event = await appendBriefingCleared(client, input.roomId, input.clearedBy, {
      briefing_id: active.id,
      content_hash: active.content_hash,
      cleared_by: input.clearedBy,
    });
    await client.query('COMMIT');
    return { briefing: active, event };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      /* connection may be unusable; release still returns it */
    });
    throw err;
  } finally {
    client.release();
  }
}
