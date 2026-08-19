import type { Pool, PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { canonicalise } from '@playroom/fabric';
import { isRoomMember } from './members.js';

// The tamper-evident audit chain (S2.3 / A3, Bible §17). A batch that reads the COMMITMENT events the room
// already writes and folds them into the append-only `audit_chain` (migration 033), each row linked to the
// last by a hash. It runs OFF the live write path — the co-sign flow is untouched — so a bug here cannot
// break a decision; it can only fail to anchor, which the next run repairs. The property it buys: an edit to
// a chained event, or to a chain row, or a wholesale rewrite, is all detectable (see verifyAuditChain).

/** The event types that are commitments — a receipt is owed. Extended by decision, not by a name prefix. */
export const COMMITMENT_EVENTS = ['decision', 'decision.resolved'] as const;

/** The first row's prev_hash. A named marker, so a chain with one row still has a well-defined link. */
const GENESIS = 'sha256:genesis';

/** A fixed key for the advisory lock that serialises anchoring — two anchors must not fork the chain. */
const ANCHOR_LOCK_KEY = 20260819;

function sha256(input: string): string {
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

/** The hash of a source event's body — over the canonical payload, so JSONB key order cannot change it. */
function bodyHash(payload: unknown): string {
  return sha256(canonicalise(payload));
}

interface EntryMeta {
  room_id: string;
  actor_id: string;
  event: string;
  source_seq: number;
}

/** The link: H(prev_hash || body_hash || meta). Recomputable at verify time from the stored columns alone. */
function entryHash(prevHash: string, body: string, meta: EntryMeta): string {
  return sha256(`${prevHash}\n${body}\n${canonicalise(meta)}`);
}

export interface AnchorResult {
  /** How many new commitment events were chained this run. */
  appended: number;
  /** The newest entry_hash — the root to anchor externally. Null only when the chain is empty. */
  root: string | null;
}

/**
 * Fold every not-yet-chained commitment event into the audit chain, in seq order, and return the new root.
 *
 * Idempotent and re-runnable: it starts from the highest `source_seq` already chained and takes an advisory
 * lock so a second concurrent anchor waits rather than forking the chain. This is the nightly anchor's body
 * (Bible §15/§17); scripts/anchor-audit.ts is its entry point.
 */
export async function chainCommitmentEvents(pool: Pool): Promise<AnchorResult> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialise anchoring. A second caller blocks here until this transaction ends, so the read of the head
    // and the appends below are one atomic step and the chain cannot fork.
    await client.query('SELECT pg_advisory_xact_lock($1)', [ANCHOR_LOCK_KEY]);

    // The head supplies the link for the first new row. We do NOT use its source_seq as a high-watermark:
    // events.seq is BIGSERIAL — assigned at INSERT, visible at COMMIT — so a lower seq can become visible
    // AFTER a higher one is already chained, and a `seq > lastSource` cursor would skip it FOREVER, a silent
    // hole in a record whose whole point is that a receipt is owed for every commitment. The anti-join
    // instead chains every commitment NOT already in the chain, so a late-committing low seq is picked up on
    // the next run and links after the higher ones (chain order = append order, which verify walks by seq).
    const head = await client.query<{ entry_hash: string }>(
      'SELECT entry_hash FROM audit_chain ORDER BY seq DESC LIMIT 1',
    );
    let prev = head.rows[0]?.entry_hash ?? GENESIS;

    const { rows } = await client.query<{
      seq: string;
      room_id: string;
      actor_id: string;
      event_type: string;
      payload: unknown;
    }>(
      `SELECT e.seq, e.room_id, e.actor_id, e.event_type, e.payload
         FROM events e
        WHERE e.event_type = ANY($1)
          AND NOT EXISTS (SELECT 1 FROM audit_chain a WHERE a.source_seq = e.seq)
        ORDER BY e.seq ASC`,
      [COMMITMENT_EVENTS as unknown as string[]],
    );

    let appended = 0;
    for (const row of rows) {
      const sourceSeq = Number(row.seq);
      const body = bodyHash(row.payload);
      const meta: EntryMeta = {
        room_id: row.room_id,
        actor_id: row.actor_id,
        event: row.event_type,
        source_seq: sourceSeq,
      };
      const entry = entryHash(prev, body, meta);
      // No ON CONFLICT: the advisory lock plus `seq > lastSource` means a duplicate source_seq would be a
      // real defect, and the UNIQUE index throwing here rolls the whole anchor back rather than skipping a
      // row and silently advancing `prev` past an entry that was never written.
      await client.query(
        `INSERT INTO audit_chain (room_id, actor_id, event, source_seq, body_hash, prev_hash, entry_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.room_id, row.actor_id, row.event_type, sourceSeq, body, prev, entry],
      );
      prev = entry;
      appended += 1;
    }

    await client.query('COMMIT');
    return { appended, root: prev === GENESIS ? null : prev };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export interface VerifyResult {
  ok: boolean;
  /** How many chain rows were checked. */
  entries: number;
  /** The current root (newest entry_hash), or null for an empty chain. */
  root: string | null;
  /** Set when `ok` is false: the chain seq where the break was found. */
  brokenAt?: number;
  /** Set when `ok` is false: what broke, in a sentence. */
  reason?: string;
}

/**
 * Walk the whole chain and prove it holds. THREE things are checked at each row, because there are three
 * ways to tamper: the link (`prev_hash` must equal the previous row's `entry_hash` — catches an inserted or
 * removed row); the row itself (`entry_hash` must recompute from the stored columns — catches an edited chain
 * row); and the SOURCE (re-hashing the referenced `events` payload must still equal `body_hash` — catches an
 * edited or deleted source event). The first failure is reported with where and why, rather than a bare false.
 */
export async function verifyAuditChain(pool: Pool): Promise<VerifyResult> {
  const { rows } = await pool.query<{
    seq: string;
    room_id: string;
    actor_id: string;
    event: string;
    source_seq: string;
    body_hash: string;
    prev_hash: string;
    entry_hash: string;
  }>(
    `SELECT seq, room_id, actor_id, event, source_seq, body_hash, prev_hash, entry_hash
       FROM audit_chain ORDER BY seq ASC`,
  );

  let prev = GENESIS;
  for (const r of rows) {
    const seq = Number(r.seq);
    if (r.prev_hash !== prev) {
      return {
        ok: false,
        entries: rows.length,
        root: null,
        brokenAt: seq,
        reason: 'prev_hash does not match the previous entry — a chain row was inserted or removed',
      };
    }
    const meta: EntryMeta = {
      room_id: r.room_id,
      actor_id: r.actor_id,
      event: r.event,
      source_seq: Number(r.source_seq),
    };
    if (entryHash(r.prev_hash, r.body_hash, meta) !== r.entry_hash) {
      return {
        ok: false,
        entries: rows.length,
        root: null,
        brokenAt: seq,
        reason: 'entry_hash does not recompute — this chain row was edited',
      };
    }
    const src = await pool.query<{
      payload: unknown;
      room_id: string;
      actor_id: string;
      event_type: string;
    }>('SELECT payload, room_id, actor_id, event_type FROM events WHERE seq = $1', [
      Number(r.source_seq),
    ]);
    if (src.rows.length === 0) {
      return {
        ok: false,
        entries: rows.length,
        root: null,
        brokenAt: seq,
        reason: 'the source event was deleted',
      };
    }
    const s = src.rows[0];
    // The ENVELOPE must still match the chain's copy — editing who committed (actor_id) or what kind of
    // commitment it was (event_type) on the source event is caught here, not only a change to the payload.
    if (s.room_id !== r.room_id || s.actor_id !== r.actor_id || s.event_type !== r.event) {
      return {
        ok: false,
        entries: rows.length,
        root: null,
        brokenAt: seq,
        reason:
          'the source event envelope (room / actor / type) was tampered — it no longer matches the chain',
      };
    }
    if (bodyHash(s.payload) !== r.body_hash) {
      return {
        ok: false,
        entries: rows.length,
        root: null,
        brokenAt: seq,
        reason: 'the source event body was tampered — its hash no longer matches the chain',
      };
    }
    prev = r.entry_hash;
  }

  return { ok: true, entries: rows.length, root: rows.length ? prev : null };
}

/** The current root — the newest entry_hash, the value to anchor externally. Null for an empty chain. */
export async function auditRoot(pool: Pool): Promise<string | null> {
  const { rows } = await pool.query<{ entry_hash: string }>(
    'SELECT entry_hash FROM audit_chain ORDER BY seq DESC LIMIT 1',
  );
  return rows[0]?.entry_hash ?? null;
}

/**
 * A commitment's receipt (get_receipt, B-track). `status` distinguishes the three honest answers: the
 * decision was resolved and is IN the chain (`chained`, with the tamper-evident entry_hash and a per-receipt
 * integrity check); it was resolved but the anchor has not run yet (`pending_anchor`); or it exists but is
 * still awaiting a signature (`unresolved`).
 */
export interface Receipt {
  decision_id: string;
  room_id: string;
  status: 'chained' | 'pending_anchor' | 'unresolved';
  resolution?: 'APPROVED' | 'DENIED';
  signed_by?: string;
  /** The receipt's tamper-evident id — the chain entry_hash. Present when `status` is `chained`. */
  entry_hash?: string;
  body_hash?: string;
  chained_at?: string;
  /** Re-hashing the source resolution still matches the chain — this one receipt is intact. */
  verified?: boolean;
}

function toIsoString(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

/**
 * The receipt for a co-signed decision, for a caller that is a member of its room. Returns null when the
 * decision is unknown OR the caller is not in its room — one answer for both, so a receipt lookup cannot be
 * used to probe which decisions exist. A resolution that is not yet anchored is `pending_anchor` (the anchor
 * runs on a schedule); one still awaiting a signature is `unresolved`.
 */
export async function receiptForDecision(
  pool: Pool,
  decisionId: string,
  memberId: string,
): Promise<Receipt | null> {
  const resolved = await pool.query<{ seq: string; room_id: string; payload: unknown }>(
    `SELECT seq, room_id, payload FROM events
      WHERE event_type = 'decision.resolved' AND payload ->> 'decision_id' = $1
      ORDER BY seq DESC LIMIT 1`,
    [decisionId],
  );

  if (resolved.rows.length === 0) {
    // Not resolved — but does the decision even exist, and may this caller see it?
    const decision = await pool.query<{ room_id: string }>(
      `SELECT room_id FROM events
        WHERE event_type = 'decision' AND payload ->> 'decision_id' = $1 LIMIT 1`,
      [decisionId],
    );
    if (decision.rows.length === 0) return null;
    const roomId = decision.rows[0].room_id;
    if (!(await isRoomMember(pool, roomId, memberId))) return null;
    return { decision_id: decisionId, room_id: roomId, status: 'unresolved' };
  }

  const row = resolved.rows[0];
  if (!(await isRoomMember(pool, row.room_id, memberId))) return null;
  const payload = row.payload as { resolution?: 'APPROVED' | 'DENIED'; signed_by?: string };

  const chained = await pool.query<{ entry_hash: string; body_hash: string; ts: Date | string }>(
    'SELECT entry_hash, body_hash, ts FROM audit_chain WHERE source_seq = $1',
    [Number(row.seq)],
  );
  if (chained.rows.length === 0) {
    return {
      decision_id: decisionId,
      room_id: row.room_id,
      status: 'pending_anchor',
      resolution: payload.resolution,
      signed_by: payload.signed_by,
    };
  }
  const c = chained.rows[0];
  return {
    decision_id: decisionId,
    room_id: row.room_id,
    status: 'chained',
    resolution: payload.resolution,
    signed_by: payload.signed_by,
    entry_hash: c.entry_hash,
    body_hash: c.body_hash,
    chained_at: toIsoString(c.ts),
    verified: bodyHash(row.payload) === c.body_hash,
  };
}
