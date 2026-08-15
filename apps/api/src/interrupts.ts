import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ServerEvent } from '@playroom/shared';
import { appendInterruptEvent } from './events.js';
import { mandateFor } from './mandates.js';
import { getTask, transitionTask } from './tasks.js';
import { principalOf } from './members.js';
import { notifyPrincipal } from './push-send.js';

/**
 * INTERRUPTS — claiming a human's attention becomes a record with a price (Bible §21.3, §18).
 *
 * ── THE THREE URGENCIES DIFFER IN BEHAVIOUR, NOT IN LABEL ──
 *
 *   BLOCKER   halts the owning task. The work cannot proceed until a person acts, so the task
 *             moves to `input-required` — A2A's own name for waiting on a human, and the state
 *             S1.3 already reaches through §6.2's route failure.
 *   DECISION  queues. It claims attention without stopping anything: the task keeps its state,
 *             and the room shows the claim.
 *   FYI       never interrupts. Nothing halts, nothing queues, and it costs nothing.
 *
 * A label that changed nothing would be a preference. These change what happens to the work.
 *
 * ── MEMBER-ADDRESSED, NEVER HUMAN-ADDRESSED ──
 *
 * The constraint this slice inherited. `raised_by` and `addressed_to` are members, the budget
 * belongs to a member, and nothing here assumes one human per member — see migration 014, which
 * carries the argument in full. The co-sign path resolves a required PRINCIPAL to its human
 * MEMBERS and raises one interrupt each, so a second human behind a principal means two rows and
 * no schema change.
 */

export type Urgency = 'BLOCKER' | 'DECISION' | 'FYI';
// 'order' (S-LOOP): a standing order that stops on its own claims its owner's attention. See
// migration 023 for why the fourth kind exists and commands/runOrders.ts for the raiser.
// 'hand' (SCC-3): a connected member raises a standalone BLOCKER/FYI that is about nothing but
// itself — the bare hand SCC2-N1 said the door could not raise. See migration 025 and
// commands/raiseHand.ts.
export type AboutKind = 'task' | 'decision' | 'message' | 'order' | 'hand';

export interface InterruptRow {
  id: string;
  room_id: string;
  urgency: Urgency;
  raised_by: string;
  addressed_to: string;
  about_kind: AboutKind;
  about_id: string;
  task_id: string | null;
}

const COLS = 'id, room_id, urgency, raised_by, addressed_to, about_kind, about_id, task_id';

/**
 * DOES THIS URGENCY SPEND ANYTHING? Silence is free, and so is an FYI.
 *
 * The budget moves only when a human's attention was actually claimed. An FYI explicitly does not
 * claim it — nothing halts, nothing queues — so charging for one would price the thing this
 * system wants agents to do instead of interrupting.
 */
export function costOf(urgency: Urgency): number {
  return urgency === 'FYI' ? 0 : 1;
}

export interface Budget {
  /** From the member's mandate. Null when they hold none — see `budgetFor`. */
  limit: number | null;
  spent: number;
  remaining: number | null;
}

/**
 * What a member has left today.
 *
 * ── COUNTED FROM THE LOG, NOT FROM A COUNTER ──
 *
 * A counter column would be a second source of truth that can drift from the events, and this
 * project has spent three slices making the log authoritative. The spend is two counts over
 * today's events: interrupts this member RAISED at a chargeable urgency, plus downgrades applied
 * to interrupts this member raised — because a misjudged interrupt costs twice, once to make the
 * claim and once when the person says it was not worth making.
 *
 * ── A MEMBER WITH NO MANDATE HAS NO BUDGET, AND THAT IS NOT A HOLE ──
 *
 * Mandates bind AGENTS to the principals who grant them; a human in their own room acts as a
 * principal rather than under one, and has no mandate to read a limit from. The budget exists to
 * price an agent's claim on a person's attention — pricing a person's claim on their own
 * attention would be charging someone rent on their own house.
 *
 * `limit: null` means unlimited and is reported as such rather than defaulted to a number, so a
 * reader can tell "no limit applies" from "the limit is large".
 *
 * The day boundary is UTC. `interrupts_per_day` is a rate and needs a day; a per-principal
 * timezone is a preference nothing records yet, and inventing one here would be a policy invented
 * in the slice that enforces it.
 */
export async function budgetFor(pool: Pool, memberId: string): Promise<Budget> {
  const limit = mandateFor(memberId)?.mandate.limits?.interrupts_per_day ?? null;

  const { rows } = await pool.query<{ raised: string; downgraded: string }>(
    `SELECT
       (SELECT count(*) FROM events
         WHERE event_type = 'interrupt.raised'
           AND payload ->> 'raised_by' = $1
           AND payload ->> 'urgency' <> 'FYI'
           AND ts >= date_trunc('day', now() AT TIME ZONE 'UTC')) AS raised,
       (SELECT count(*) FROM events
         WHERE event_type = 'interrupt.downgraded'
           AND payload ->> 'raised_by' = $1
           AND ts >= date_trunc('day', now() AT TIME ZONE 'UTC')) AS downgraded`,
    [memberId],
  );
  const spent = Number(rows[0].raised) + Number(rows[0].downgraded);
  return { limit, spent, remaining: limit === null ? null : Math.max(0, limit - spent) };
}

export type RaiseFailure = 'budget_exhausted';

export interface RaiseInput {
  roomId: string;
  urgency: Urgency;
  raisedBy: string;
  addressedTo: string;
  aboutKind: AboutKind;
  aboutId: string;
  taskId?: string | null;
  /** The sentence the room shows. Never a template filled in by the reader. */
  summary: string;
  /**
   * HOW THE NOTIFICATION SHOULD READ — 'FINISHED' or, absent, NEEDS-YOU (S-DIAL).
   *
   * FINISHED NAMES THE ORDER'S TERMINAL STATUS, NOT AN AGENT'S OPINION OF ITS WORK. The only caller
   * that sets it is `stopOrder`, from the status the SERVER just wrote (LIMIT_REACHED / EXPIRED /
   * REVOKED). It is optional and defaults to absent precisely so that every other raiser — the door's
   * bare hand, a co-signature, anything a member can reach — produces NEEDS-YOU without having to
   * know this field exists. A member cannot pass it, because no command carries it.
   *
   * This does NOT close ST-N1. "The order ran the count it was given" is not "the work is done", and
   * nothing here lets an agent assert the latter.
   */
  notifyTone?: 'FINISHED';
}

/**
 * THE ONLY PLACE AN INTERRUPT IS RAISED.
 *
 * Same discipline as the summon and the decision: one construction site, so the budget check, the
 * idempotency branch and the halt live where they can be read together rather than being a
 * convention repeated at call sites.
 *
 * RETURNS NULL when this thing has already interrupted this member (migration 014's unique
 * index). Not an error and not a silent drop: a retried co-sign or two racing requests must claim
 * a person's attention once, and the caller branches on it.
 */
export async function raiseInterrupt(
  pool: Pool,
  input: RaiseInput,
): Promise<
  | { ok: true; interrupt: InterruptRow; event: ServerEvent | null; halt: ServerEvent | null }
  | { ok: false; failure: RaiseFailure; budget: Budget }
> {
  // ── THE BUDGET, CHECKED BEFORE THE ROW EXISTS (S1.4) ────────────────────────────────
  //
  // `limits.interrupts_per_day` has been parsed by the mandate schema and read by NOTHING since
  // M-3 — the fifth field that looked like authority. It is enforced here rather than in the
  // evaluator, and that placement is a decision:
  //
  //   * `evaluate()` is a PURE FUNCTION with a Bible §11 budget of <10ms P50, asserted at 0.001ms.
  //     A rate limit needs today's usage, which is a database read; putting one inside the
  //     evaluator would either break that property or make the branch lie about what it checked.
  //     The evaluator's own branch 6 says so — "(S2.7) limits — needs per-day usage counters".
  //   * the two questions are different shapes. Scope asks *may this member do this to that*, and
  //     is a function of the mandate alone. A budget asks *how much of a person's attention has
  //     this member already taken today*, and is a function of history.
  //
  // So the mandate stays the source of the NUMBER and this is the site that enforces it. The
  // refusal has its own reason code: an exhausted budget is not an out-of-scope action and must
  // not be reported as one.
  const budget = await budgetFor(pool, input.raisedBy);
  const cost = costOf(input.urgency);
  if (budget.remaining !== null && cost > budget.remaining) {
    return { ok: false, failure: 'budget_exhausted', budget };
  }

  const id = `int_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const inserted = await pool.query<InterruptRow>(
    `INSERT INTO interrupts
       (id, room_id, urgency, raised_by, addressed_to, about_kind, about_id, task_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (room_id, about_kind, about_id, addressed_to) DO NOTHING
     RETURNING ${COLS}`,
    [
      id,
      input.roomId,
      input.urgency,
      input.raisedBy,
      input.addressedTo,
      input.aboutKind,
      input.aboutId,
      input.taskId ?? null,
    ],
  );

  if (!inserted.rows[0]) {
    const existing = await pool.query<InterruptRow>(
      `SELECT ${COLS} FROM interrupts
        WHERE room_id = $1 AND about_kind = $2 AND about_id = $3 AND addressed_to = $4`,
      [input.roomId, input.aboutKind, input.aboutId, input.addressedTo],
    );
    return { ok: true, interrupt: existing.rows[0], event: null, halt: null };
  }

  const interrupt = inserted.rows[0];
  const event = await appendInterruptEvent(pool, input.roomId, input.raisedBy, 'interrupt.raised', {
    interrupt_id: interrupt.id,
    urgency: interrupt.urgency,
    raised_by: interrupt.raised_by,
    addressed_to: interrupt.addressed_to,
    about_kind: interrupt.about_kind,
    about_id: interrupt.about_id,
    summary: input.summary,
    // AMBIENT, not a badge (design.md principle 4). The number travels with the claim it belongs
    // to, so the room can show what this cost without polling anything.
    budget_remaining: budget.remaining === null ? null : budget.remaining - cost,
  });
  // ── BLOCKER HALTS THE OWNING TASK. THE OTHER TWO DO NOT. ────────────────────────────
  //
  // This is what makes the three urgencies a control rather than three words. A BLOCKER says the
  // work cannot proceed until a person acts, so the work stops: the task moves to
  // `input-required`, which is A2A's own name for waiting on a human and the state S1.3 already
  // reaches through §6.2's route failure. DECISION claims attention and leaves the work running.
  // FYI does neither.
  //
  // ONLY FROM `working`. A task that is already stopped — held by an outage, waiting on a route,
  // or done — is not re-stopped for a different reason: overwriting `held` with `input-required`
  // would replace an operational fact with a social one and lose the error class that explains it.
  //
  // NO PRODUCT PATH RAISES A BLOCKER TODAY, and that is stated rather than hidden. The only
  // in-product raiser is the co-sign path, which raises DECISION. A failed turn deliberately does
  // NOT raise one: the budget prices JUDGEMENT — was this worth a person's attention — and a
  // provider outage is not a judgement, so charging an agent for one would be the wrong economics
  // and would make an interrupt budget drain on infrastructure luck. The halt is exercised by
  // test, and it is here rather than at a future call site because the behaviour belongs with the
  // record, not with whoever eventually raises one.
  let halt: ServerEvent | null = null;
  if (interrupt.urgency === 'BLOCKER' && interrupt.task_id) {
    const task = await getTask(pool, interrupt.task_id);
    if (task && task.state === 'working') {
      halt = await transitionTask(
        pool,
        task,
        'input-required',
        `blocked by ${input.raisedBy}: ${input.summary}`,
        'system',
      );
    }
  }

  // ── AND ONLY NOW, THE TELLING (S-PUSH) ──────────────────────────────────────────────
  //
  // EVERYTHING ABOVE IS ALREADY COMMITTED: the row exists, the event is written, the halt has
  // happened. A notification is a TELLING, never a doing, so it is dispatched from HERE — after the
  // record, outside the return value, and fire-and-forget.
  //
  // FIRE-AND-FORGET IS THE WHOLE DESIGN, not a shortcut. Awaited, a slow vendor would become latency
  // on raising a hand and an unreachable one would become an interrupt that failed to record — the
  // exact inversion SCC-3's rule forbids ("a refused notification must not undo the interrupt"). So
  // the send cannot be awaited, cannot throw into this function, and cannot return anything this
  // function reads. `notifyPrincipal` is built to match: it never rejects.
  //
  // The interrupt this produces is byte-identical whether the push succeeds, fails, is throttled,
  // is refused by the allowlist, or is never attempted at all. The only difference any of that
  // makes is a row in `push_sends`.
  void notifyForInterrupt(pool, {
    roomId: input.roomId,
    urgency: interrupt.urgency,
    addressedTo: interrupt.addressed_to,
    interruptId: interrupt.id,
    tone: input.notifyTone ?? 'NEEDS-YOU',
  }).catch(() => {
    /* unreachable: notifyForInterrupt resolves on every path. The catch is the second lock. */
  });

  return { ok: true, interrupt, event, halt };
}

/**
 * Resolve the person behind the member whose attention was claimed, and tell them.
 *
 * A subscription belongs to a PRINCIPAL and an interrupt is addressed to a MEMBER, so this is the
 * one hop between them. Exported for the tests that assert what is and is not sent; nothing else
 * calls it, because `raiseInterrupt` is the only place an interrupt comes into existence.
 */
export async function notifyForInterrupt(
  pool: Pool,
  input: {
    roomId: string;
    urgency: string;
    addressedTo: string;
    interruptId: string;
    tone: 'FINISHED' | 'NEEDS-YOU';
  },
): Promise<void> {
  try {
    const principal = await principalOf(pool, input.addressedTo);
    if (!principal) return;
    await notifyPrincipal(pool, {
      principalId: principal,
      roomId: input.roomId,
      interruptId: input.interruptId,
      urgency: input.urgency,
      tone: input.tone,
    });
  } catch {
    // The record is already committed; nothing here may reach it.
  }
}

/** The next urgency down. Null at the bottom — an FYI cannot be lowered further. */
export function lowerThan(urgency: Urgency): Urgency | null {
  if (urgency === 'BLOCKER') return 'DECISION';
  if (urgency === 'DECISION') return 'FYI';
  return null;
}

export type DowngradeFailure = 'unknown' | 'not_addressed_to_you' | 'already_lowest';

/**
 * Lower an interrupt's claim by one step, and charge the member who raised it.
 *
 * ── ONLY THE RECIPIENT MAY DOWNGRADE, AND NOBODY MAY UPGRADE ──
 *
 * The person whose attention is claimed is the only party who can say the claim was too strong.
 * The raiser lowering their own interrupt would be a way to refund the charge; anyone else
 * lowering it would be deciding on someone else's behalf what deserves their attention.
 *
 * There is no upgrade, and no function to add one to. A recipient may lower a claim on them;
 * nobody may raise it after the fact, because that would let a second attempt cost nothing and
 * turn the budget into a suggestion.
 *
 * ── THE DOWNGRADE COSTS THE RAISER, WHICH IS THE WHOLE MECHANISM ──
 *
 * Recorded as an event carrying `raised_by`, so `budgetFor` can count it without joining. A
 * misjudged interrupt therefore costs two: one to make the claim, one when the person says it was
 * not worth making. That is what makes a downgrade a SIGNAL rather than a dismissal.
 *
 * REPUTATION IS NOT THIS SLICE. S3.2 consumes downgrade counts; this produces them and stops.
 * There is deliberately no decay, no score and no consumer here.
 */
export async function downgradeInterrupt(
  pool: Pool,
  interruptId: string,
  byMember: string,
): Promise<
  | { ok: true; interrupt: InterruptRow; event: ServerEvent }
  | { ok: false; failure: DowngradeFailure }
> {
  const { rows } = await pool.query<InterruptRow>(`SELECT ${COLS} FROM interrupts WHERE id = $1`, [
    interruptId,
  ]);
  const interrupt = rows[0];
  if (!interrupt) return { ok: false, failure: 'unknown' };
  if (interrupt.addressed_to !== byMember) return { ok: false, failure: 'not_addressed_to_you' };

  const to = lowerThan(interrupt.urgency);
  if (!to) return { ok: false, failure: 'already_lowest' };

  // THE CHARGE, COMPUTED BEFORE IT IS WRITTEN. `budgetFor` counts today's downgrade events, so
  // reading it afterwards would already include this one — the number on screen has to be what
  // the raiser is left with.
  const before = await budgetFor(pool, interrupt.raised_by);
  const event = await appendInterruptEvent(
    pool,
    interrupt.room_id,
    byMember,
    'interrupt.downgraded',
    {
      interrupt_id: interrupt.id,
      urgency: to,
      from_urgency: interrupt.urgency,
      raised_by: interrupt.raised_by,
      addressed_to: interrupt.addressed_to,
      budget_remaining: before.remaining === null ? null : Math.max(0, before.remaining - 1),
    },
  );
  await pool.query('UPDATE interrupts SET urgency = $1, updated_at = now() WHERE id = $2', [
    to,
    interrupt.id,
  ]);
  interrupt.urgency = to;
  return { ok: true, interrupt, event };
}

export async function getInterrupt(pool: Pool, id: string): Promise<InterruptRow | null> {
  const { rows } = await pool.query<InterruptRow>(`SELECT ${COLS} FROM interrupts WHERE id = $1`, [
    id,
  ]);
  return rows[0] ?? null;
}

export async function interruptsInRoom(pool: Pool, roomId: string): Promise<InterruptRow[]> {
  const { rows } = await pool.query<InterruptRow>(
    `SELECT ${COLS} FROM interrupts WHERE room_id = $1 ORDER BY created_at`,
    [roomId],
  );
  return rows;
}

/**
 * Fold an interrupt's events into the urgency they imply.
 *
 * The same function tasks have, for the same reason: it makes "the log is the source of truth" a
 * statement about code. If this disagrees with the row, the row is wrong.
 */
export function rebuildUrgency(events: readonly ServerEvent[]): Urgency | null {
  let urgency: Urgency | null = null;
  for (const ev of events) {
    if (ev.event_type === 'interrupt.raised' || ev.event_type === 'interrupt.downgraded') {
      urgency = ev.payload.urgency as Urgency;
    }
  }
  return urgency;
}
