import type { Pool } from 'pg';
import { mandateFor } from './mandates.js';

/**
 * THE STAMP A TURN CARRIES — Bible §4.1, §8.1.
 *
 * Member id, the principal binding, and the hash of the mandate in force, applied to the first
 * event anything sees of a turn. §8.1's rule is that an unstamped cross-boundary message is
 * dropped at the room service; with one gateway path there is nothing to drop yet, so what this
 * buys today is the other half — nothing downstream has to TRUST an unstamped turn. A
 * projection, a receipt, or a host adapter reading `agent.turn.started` has the authority
 * context in hand rather than having to ask, and a turn without it is visibly different from a
 * turn with it.
 *
 * ── DERIVED, NEVER PASSED ──
 *
 * `stampFor` reads records. It is deliberately NOT a parameter threaded down from the command
 * layer, because a stamp a caller supplies is a CLAIM — the precise thing this slice deletes
 * from the wire. Every field here comes from a row: the member record, its principal binding
 * (migration 007's foreign key), and the mandate document on disk.
 *
 * One indexed read per turn, against a path whose measured overhead is 30–120ms of provider
 * latency (ADR-008). The cost does not register; the property does.
 *
 * Its own module rather than members.ts: that file imports agent.ts for `setRoomTokens`, and
 * agent.ts is the caller here. The cycle would resolve at runtime and mislead the next person
 * to move either function.
 */
export interface MemberStamp {
  member_id: string;
  principal_id: string;
  /** Null when the member has no mandate. Omitted authority, never a placeholder. */
  mandate_hash: string | null;
}

export class UnstampableMemberError extends Error {
  constructor(memberId: string) {
    super(`cannot stamp a turn for "${memberId}": no such member record`);
    this.name = 'UnstampableMemberError';
  }
}

/**
 * Build the stamp for a member, or THROW.
 *
 * Throwing for an unknown member is the point. A turn is about to be attributed to this id, and
 * a stamp assembled from defaults would be a fabricated authority record — better no turn at
 * all, loudly, than a turn stamped with a guess. The caller runs this inside the turn's try
 * block, so the failure is written as `completed{success:false}` and a member can read it.
 */
export async function stampFor(pool: Pool, memberId: string): Promise<MemberStamp> {
  const { rows } = await pool.query<{ principal_id: string }>(
    'SELECT principal_id FROM members WHERE id = $1',
    [memberId],
  );
  const row = rows[0];
  if (!row) throw new UnstampableMemberError(memberId);
  return {
    member_id: memberId,
    principal_id: row.principal_id,
    // Through the shared cache. This called `loadMandates()` directly until S1.3, re-reading the
    // mandate directory from disk on EVERY TURN — invisible next to provider latency, and wrong
    // for the same reason a per-request `readFileSync` is always wrong.
    mandate_hash: mandateFor(memberId)?.hash ?? null,
  };
}
