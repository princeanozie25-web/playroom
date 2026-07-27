import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { ServerEvent } from '@playroom/shared';
import { appendPromotionEvent } from './events.js';
import { withPrincipalStore } from './principal-store.js';

/**
 * PROMOTION — moving a private item into a room, as an act with a record (Bible §7.2).
 *
 * ── THE ONE THING THIS FILE IS FOR ──
 *
 * A disclosure cannot be undone. Once a private note is in a room, every member has read it, and
 * deleting the row afterwards changes the screen and nothing about what was learned. So the design
 * question is not how to copy text; it is what has to be true BEFORE the copy exists.
 *
 * Four things, and none of them is optional:
 *
 *   AN AUTHENTICATED ACTOR   Promotion is an act. `approvedBy` is a member id, and it is checked
 *                            against the members table: it must be a HUMAN member of the principal
 *                            whose store is being read. An agent cannot disclose its own
 *                            principal's private context, and nobody can disclose anyone else's.
 *   A PURPOSE                Free text, refused when blank. A purpose nobody had to write is a
 *                            purpose nobody had to have.
 *   PROVENANCE               Which principal, which item, which room, what hash.
 *   THE RECORD FIRST         And structurally, not by ordering: the text that reaches the room is
 *                            read back from the row that records it, so a copy has nothing to be
 *                            derived from until the record exists.
 *
 * ── RA-005: A PROMOTED SPAN CANNOT ACTIVATE ANYTHING ──
 *
 * The room event this writes is `context.promoted`, NOT `message`. Barrier 1 of the activation
 * boundary is an allowlist — `memberAuthoredText` returns text for `message` and null for
 * everything else — so a promoted `@sol` resolves to NOT_ROOM_CONTENT and summons nobody. Nothing
 * in agent.ts changed to achieve that, which is the point: the barrier was built as an allowlist
 * precisely so that a new event type is inert until somebody deliberately admits it.
 *
 * WHAT THIS DOES NOT CLOSE, and it is a different thing: a member pasting the same words into an
 * ordinary message. `message.payload` is still one flat string with no span provenance, so quoted
 * text inside a message still activates — RT-004's accepted gap, still pinned by its must-fail
 * test. Promotion is a path that is inert by construction; it does not make the other path safe,
 * and this slice does not claim it does.
 */

export type Representation = 'verbatim' | 'summary';

export interface PromotionRow {
  id: string;
  source_principal: string;
  source_item_id: string;
  room_id: string;
  content_hash: string;
  representation: Representation;
  content: string;
  purpose: string;
  approved_by: string;
  created_at: string;
}

/**
 * Why a promotion was refused. Named separately because "promotion failed" tells an operator
 * nothing, and because two of these are consent failures rather than mistakes.
 */
export type PromotionRefusal =
  | 'no_such_member' // the approver does not exist
  | 'not_own_principal' // the approver acts for a different principal than the store
  | 'not_a_human' // an agent tried to disclose its principal's private context
  | 'no_such_item' // the item is not in that principal's store (or does not exist at all)
  | 'purpose_required' // blank purpose
  | 'no_summary_available'; // asked for the summary of an item that has none

export class PromotionRefused extends Error {
  constructor(readonly reason: PromotionRefusal) {
    super(`promotion refused: ${reason}`);
    this.name = 'PromotionRefused';
  }
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface PromoteInput {
  roomId: string;
  /** The item to promote, from the approver's own principal's store. */
  itemId: string;
  /** The member consenting to the disclosure. Must be a human member of the source principal. */
  approvedBy: string;
  /** Why. Recorded verbatim and shown in the room. */
  purpose: string;
  /**
   * MINIMISATION IS THE DEFAULT (§7.3). Omitted means 'summary', and an item with no summary is
   * refused rather than silently upgraded to verbatim — a default that quietly discloses MORE when
   * the data does not fit it is not a default, it is a trap.
   */
  representation?: Representation;
}

/**
 * Promote one item into one room.
 *
 * THE ONLY CONSTRUCTION SITE, and it is one transaction: consent checked, item read through the
 * scoped store, record written, room event derived from the record. A failure at any point leaves
 * neither a record nor a copy.
 */
export async function promoteContent(
  pool: Pool,
  input: PromoteInput,
): Promise<{ promotion: PromotionRow; event: ServerEvent }> {
  const purpose = input.purpose.trim();
  if (purpose === '') throw new PromotionRefused('purpose_required');

  // ── CONSENT, FIRST AND FROM RECORDS ────────────────────────────────────────────────
  //
  // Who this member is comes from the members table, not from the request. The request names a
  // member id; everything that follows — which principal's store is opened, whether a human
  // approved — is derived from the row.
  const { rows: memberRows } = await pool.query<{ principal_id: string; kind: string }>(
    'SELECT principal_id, kind FROM members WHERE id = $1',
    [input.approvedBy],
  );
  const member = memberRows[0];
  if (!member) throw new PromotionRefused('no_such_member');
  // AN AGENT CANNOT DISCLOSE ITS OWN PRINCIPAL'S PRIVATE CONTEXT. It reads that context on every
  // turn (§7.1), so an agent that could also promote it could be talked into publishing it — the
  // injection path of barrier 1, with the payload being its principal's private store. Consent for
  // a disclosure is a human act or it is not consent.
  if (member.kind !== 'human') throw new PromotionRefused('not_a_human');

  const sourcePrincipal = member.principal_id;

  // ── THE ITEM, THROUGH THE SCOPED STORE ────────────────────────────────────────────
  //
  // Note what is NOT here: any way to name a principal. The store opened is the approver's own,
  // because that is the only principal derivable from the approver — so "promote someone else's
  // note" has nowhere to be expressed, and the database would refuse it anyway.
  const item = await withPrincipalStore(pool, sourcePrincipal, async (store) => {
    const items = await store.items(200);
    return items.find((i) => i.id === input.itemId) ?? null;
  });
  if (!item) throw new PromotionRefused('no_such_item');

  const representation: Representation = input.representation ?? 'summary';
  if (representation === 'summary' && !item.summary) {
    // Refused rather than falling back to the body. A fallback here would mean "asked for less,
    // got everything", which is the failure mode minimisation exists to prevent.
    throw new PromotionRefused('no_summary_available');
  }
  const content = representation === 'verbatim' ? item.body : (item.summary as string);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // THE RECORD. Written before anything is in the room, and `RETURNING content` is not
    // decoration: the room event below is built from what came back out of this row, so the copy
    // is derived from the record rather than running alongside it.
    const { rows } = await client.query<PromotionRow>(
      `INSERT INTO promotions
         (id, source_principal, source_item_id, room_id, content_hash, representation, content,
          purpose, approved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, source_principal, source_item_id, room_id, content_hash, representation,
                 content, purpose, approved_by, created_at`,
      [
        `promo_${randomBytes(8).toString('hex')}`,
        sourcePrincipal,
        item.id,
        input.roomId,
        contentHash(content),
        representation,
        content,
        purpose,
        input.approvedBy,
      ],
    );
    const promotion = rows[0];

    // THE COPY, derived from the record. `context.promoted`, not `message` — see RA-005 above.
    const event = await appendPromotionEvent(client, input.roomId, input.approvedBy, {
      promotion_id: promotion.id,
      source_principal: promotion.source_principal,
      representation: promotion.representation,
      purpose: promotion.purpose,
      approved_by: promotion.approved_by,
      content_hash: promotion.content_hash,
      content: promotion.content,
    });
    await client.query('COMMIT');
    return { promotion, event };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      /* connection may be unusable; release still returns it */
    });
    throw err;
  } finally {
    client.release();
  }
}

export async function getPromotion(pool: Pool, id: string): Promise<PromotionRow | null> {
  const { rows } = await pool.query<PromotionRow>(
    `SELECT id, source_principal, source_item_id, room_id, content_hash, representation, content,
            purpose, approved_by, created_at
       FROM promotions WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}
