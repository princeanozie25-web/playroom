import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { hashSecret } from './credentials.js';

/**
 * WEBSOCKET TICKETS — a credential worth one socket, one member, one room, thirty seconds.
 *
 * S13-N3, both faces. A browser cannot set headers on a WebSocket handshake, so S1.2 put the
 * member credential in the query string; and the page handed the same credential to a client
 * component as a prop, so it was serialised into the HTML. Two places a long-lived secret should
 * never be, and neither was fixable by moving it — the constructor takes a URL and a subprotocol
 * list and nothing else.
 *
 * A ticket makes both harmless rather than hidden. In a log line it is worthless by the time
 * anyone reads the log; in a page it is worthless by the time anyone views the source.
 *
 * ── WHAT IT PROVES, AND WHAT IT STILL DOES NOT ──
 *
 * PROVES: whoever presents this ticket held the member's credential within the last thirty
 * seconds, and asked for this room.
 *
 * DOES NOT PROVE: a person. The ticket inherits exactly the authority of the credential that
 * minted it, so `Jerry granted this mandate` and `this is Prince rather than someone reading
 * Prince's page` are as unproven as before (S04-N2). A ticket narrows EXPOSURE, not authority.
 * The web tier mints tickets for anyone who can reach it, because there is no login to check —
 * which is the same gap, moved from the page into the web server process where at least it is
 * one process rather than every reader of the HTML.
 */

/** Issued tickets carry a prefix, so one in a log is recognisable as a Playroom secret. */
const TICKET_PREFIX = 'pwt_';

/**
 * THIRTY SECONDS, and the number is doing work.
 *
 * Long enough for the slowest honest sequence: a page render, a fetch to the web tier, a
 * forwarded call to the api, and a socket handshake — comfortably under a second on this
 * machine and still fine on a bad connection. Short enough that a leaked access-log line is
 * expired before a human could copy it.
 *
 * A minute would be a different design, in the sense that matters: it stops being "the ticket is
 * spent by the time it is written down" and starts being "the ticket is probably still good".
 */
export const TICKET_TTL_SECONDS = 30;

/** How long a dead ticket stays before the next issue sweeps it. Audit window, not policy. */
const SWEEP_AFTER_SECONDS = 300;

export interface IssuedTicket {
  /** THE PLAINTEXT, returned once and never stored. */
  ticket: string;
  expires_at: string;
}

/**
 * Mint a ticket for a member and a room.
 *
 * ASKS NO AUTHORISATION QUESTION, deliberately, and the route above it asks none either. If
 * issuing checked whether the member may join the room, the issuing route would answer "does
 * this room exist and am I in it" — an oracle, rebuilt one route over from the one S1.3b closed.
 *
 * The handshake is the single place that decides. A ticket for a room the member cannot join is
 * issued happily and refused at the door, identically to a room that does not exist.
 *
 * Sweeps dead rows on the way through: a table written on every connect grows faster than the
 * credentials table that reached 479 rows unnoticed (S12-N3), and a sweep here means no
 * scheduler and no second mechanism.
 */
export async function issueTicket(
  pool: Pool,
  memberId: string,
  roomId: string,
): Promise<IssuedTicket> {
  await pool.query(
    `DELETE FROM ws_tickets
      WHERE expires_at < now() - ($1 || ' seconds')::interval`,
    [String(SWEEP_AFTER_SECONDS)],
  );

  const ticket = `${TICKET_PREFIX}${randomBytes(32).toString('hex')}`;
  const { rows } = await pool.query<{ expires_at: Date }>(
    `INSERT INTO ws_tickets (id, ticket_hash, member_id, room_id, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' seconds')::interval)
     RETURNING expires_at`,
    [
      `tkt_${randomBytes(8).toString('hex')}`,
      hashSecret(ticket),
      memberId,
      roomId,
      String(TICKET_TTL_SECONDS),
    ],
  );
  return { ticket, expires_at: rows[0].expires_at.toISOString() };
}

/** Why a ticket was refused. The caller sees one refusal; the log sees which of these. */
export type TicketFailure = 'missing' | 'unknown' | 'consumed' | 'expired' | 'wrong_room';

export interface TicketHolder {
  member_id: string;
  principal_id: string;
}

/**
 * Spend a ticket, or say why not.
 *
 * ── CONSUMED BY THE UPDATE ITSELF ──
 *
 * One statement claims the ticket and reports whether it won. Reading first and updating second
 * would let two handshakes racing the same ticket both pass the read — the shape S0.5a's replayed
 * summon had, and the reason migrations 005 and 006 exist. `consumed_at IS NULL` in the WHERE
 * clause is what makes single use true rather than intended.
 *
 * The row SURVIVES consumption. It is how a reuse is told from a fabrication in the log, and it
 * is swept later by `issueTicket` rather than deleted here.
 *
 * ── ONE REFUSAL OUTWARD, FOUR REASONS INWARD ──
 *
 * A consumed, an expired, a fabricated and a wrong-room ticket are the same answer to the
 * caller: the door does not open and it does not say which mistake was made. Per S1.3b's ruling,
 * a refusal that diagnoses is a refusal that can be probed — and here it would leak whether a
 * ticket ever existed, which is a weaker version of the room oracle.
 *
 * The extra SELECT runs ONLY on the failure path, and only so the log can name the reason. It
 * costs nothing on the path that matters and it is the difference between an operator who can
 * debug a broken client and one who cannot.
 */
export async function consumeTicket(
  pool: Pool,
  ticket: string | undefined,
  roomId: string,
): Promise<{ ok: true; holder: TicketHolder } | { ok: false; failure: TicketFailure }> {
  if (!ticket || ticket.trim() === '') return { ok: false, failure: 'missing' };
  const hash = hashSecret(ticket);

  const claimed = await pool.query<{ member_id: string; principal_id: string; room_id: string }>(
    `UPDATE ws_tickets AS t
        SET consumed_at = now()
      WHERE t.ticket_hash = $1 AND t.consumed_at IS NULL AND t.expires_at > now()
     RETURNING t.member_id,
               t.room_id,
               (SELECT m.principal_id FROM members AS m WHERE m.id = t.member_id) AS principal_id`,
    [hash],
  );

  const row = claimed.rows[0];
  if (row) {
    // BOUND TO THE ROOM IT WAS MINTED FOR. The ticket is spent either way — a ticket presented
    // at the wrong door is spent, not returned, because handing it back would make a ticket
    // probeable across rooms until it expired.
    if (row.room_id !== roomId) return { ok: false, failure: 'wrong_room' };
    return { ok: true, holder: { member_id: row.member_id, principal_id: row.principal_id } };
  }

  // The failure path only: which of the three was it?
  const { rows } = await pool.query<{ consumed: boolean; expired: boolean }>(
    `SELECT consumed_at IS NOT NULL AS consumed, expires_at <= now() AS expired
       FROM ws_tickets WHERE ticket_hash = $1`,
    [hash],
  );
  if (!rows[0]) return { ok: false, failure: 'unknown' };
  return { ok: false, failure: rows[0].consumed ? 'consumed' : 'expired' };
}

/** Live tickets, for the assertion that the table stays bounded. */
export async function ticketCount(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM ws_tickets');
  return Number(rows[0].n);
}
