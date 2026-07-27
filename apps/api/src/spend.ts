import type { Pool } from 'pg';

/**
 * A DAILY SPEND CEILING THAT REFUSES OUT LOUD (Bible §18, S-LIVE).
 *
 * ── WHY THIS EXISTS TODAY AND NOT AT S2.7 ──
 *
 * Per-room budgets, per-member allowances and a real cost model are S2.7. This is not that. This is
 * the floor underneath them, and it exists because strangers are about to spend MY provider keys: a
 * public URL with real keys and no ceiling has exactly one failure mode, and it arrives as a bill.
 *
 * Blunt on purpose. One number, all rooms, all members, resets at midnight UTC. A per-member ceiling
 * would be fairer and would need a policy about who gets how much, which is a product decision this
 * slice must not quietly make.
 *
 * ── IT IS COUNTED FROM THE LOG, NOT FROM A COUNTER ──
 *
 * `agent.turn.completed` already carries `cost_usd` for every turn ever run (S0.3). Summing those is
 * the same reasoning the interrupt budget follows: a separate counter is a second representation of
 * a fact the log already holds, and the two drift the first time a write fails between them. A
 * restart forgets a counter; it cannot forget the log.
 *
 * The cost of that choice is honest: this is a query per summon rather than a variable read. It is
 * one indexed aggregate against rows from today, next to a provider call that takes a second.
 *
 * ── WHAT IT CANNOT DO ──
 *
 * IT CANNOT STOP A TURN ALREADY RUNNING, and it cannot stop the turn that crosses the line — a turn
 * is checked before it starts and its cost is known only when it finishes. So the ceiling is a
 * threshold that gets crossed and then closes, not a hard cap: the real spend can exceed it by up to
 * one turn per concurrent stream. With `max_output_tokens` of 512 on the guest adapters that
 * overshoot is fractions of a cent, and stating it is better than implying a precision this does not
 * have.
 */

/** Read the ceiling. Absent means no ceiling — see `ceilingConfigured` for why that is loud. */
export function ceilingUsd(): number | null {
  const raw = process.env.PLAYROOM_DAILY_USD_CEILING;
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  // A MALFORMED CEILING IS NOT NO CEILING. `PLAYROOM_DAILY_USD_CEILING=five` must not read as
  // unlimited — that is the shape of every fail-open configuration bug, and this is the one setting
  // whose failure is measured in money.
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `PLAYROOM_DAILY_USD_CEILING is not a number: ${JSON.stringify(raw)} — ` +
        'unset it to run without a ceiling, deliberately',
    );
  }
  return n;
}

export interface SpendState {
  /** Today's spend in USD, summed from the log. */
  spent_usd: number;
  /** The ceiling, or null when none is configured. */
  ceiling_usd: number | null;
  /** Null when there is no ceiling — reported as absent rather than as a large number. */
  remaining_usd: number | null;
  exceeded: boolean;
}

/**
 * What has been spent today, across every room and member.
 *
 * UTC day, matching the interrupt budget's `date_trunc('day', now() AT TIME ZONE 'UTC')`. One
 * definition of "today" in the codebase; a second one in local time would make two budgets reset at
 * different moments and nobody would notice until they did.
 */
export async function spendToday(pool: Pool): Promise<SpendState> {
  const ceiling = ceilingUsd();
  const { rows } = await pool.query<{ spent: string | null }>(
    `SELECT sum((payload ->> 'cost_usd')::numeric) AS spent
       FROM events
      WHERE event_type = 'agent.turn.completed'
        AND payload ->> 'cost_usd' IS NOT NULL
        AND ts >= date_trunc('day', now() AT TIME ZONE 'UTC')`,
  );
  const spent = Number(rows[0]?.spent ?? 0);
  return {
    spent_usd: spent,
    ceiling_usd: ceiling,
    remaining_usd: ceiling === null ? null : Math.max(0, ceiling - spent),
    exceeded: ceiling !== null && spent >= ceiling,
  };
}

/**
 * The sentence the room shows when the ceiling is reached.
 *
 * WRITTEN FOR THE PERSON WHO JUST TAGGED SOMEBODY, not for me. It says what happened, that it is not
 * their fault, and when it stops — because the alternative is a tester tagging an agent, getting
 * silence, and concluding the product is broken. Silence is the one thing a refusal may never be.
 *
 * No dollar amount for the SPEND, deliberately: what a stranger has spent of my money is not a
 * number they need, and a running total in a shared room invites a game. The ceiling itself is named
 * because it explains the shape of the limit.
 */
export function ceilingMessage(state: SpendState): string {
  const ceiling = state.ceiling_usd === null ? 'the daily limit' : `today's $${state.ceiling_usd}`;
  return (
    `${ceiling} spending limit for this room has been reached, so nobody's agent will reply ` +
    'until it resets at midnight UTC. Nothing you did caused this and nothing was lost — ' +
    'messages still send, and the transcript is intact.'
  );
}
