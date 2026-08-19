import type { Pool } from 'pg';
import type { Queryable } from './credentials.js';

// THE FACTS OBJECT (Track C / C3, ADR-014).
//
// C3's discipline: the evaluator stays PURE, and the CALLER assembles the facts from history and passes them
// in (the same shape `runOrders` already reads spend/counts from the log, now joined to `evaluate`). This
// module is that assembler. A "fact" is a bare string key; `evaluate` checks it against a grant's `requires`
// as a membership test, nothing more.
//
// The fact source is `room_checks` (migration 036): a node reports a check `{name, passed}` under its lease,
// and the fact for a room is derived from the LATEST report per check name — a check named `tests` that most
// recently passed yields `tests_passed`. A later failing report flips it off; a stale pass does not linger.

/** Record a check result for a room (a node reporting under its lease). Append-only; the latest wins. */
export async function recordCheck(
  db: Queryable,
  input: { roomId: string; name: string; passed: boolean; reportedBy: string; leaseId: string },
): Promise<void> {
  await db.query(
    `INSERT INTO room_checks (room_id, name, passed, reported_by, lease_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.roomId, input.name, input.passed, input.reportedBy, input.leaseId],
  );
}

/**
 * The TRUE facts for a room — the caller-computed set C3 passes to `evaluate`. For each distinct check name
 * whose LATEST report is a pass, emit `<name>_passed` (so a `tests` check maps to the fact `tests_passed` a
 * mandate's `requires` names). One indexed read; a room with no checks yields no facts, and a conditional
 * grant then BLOCKs by default — the correct posture for "we have not seen the tests pass".
 */
export async function roomFacts(pool: Pool, roomId: string): Promise<string[]> {
  const { rows } = await pool.query<{ name: string; passed: boolean }>(
    `SELECT DISTINCT ON (name) name, passed
       FROM room_checks
      WHERE room_id = $1
      ORDER BY name, ts DESC`,
    [roomId],
  );
  return rows.filter((r) => r.passed).map((r) => `${r.name}_passed`);
}
