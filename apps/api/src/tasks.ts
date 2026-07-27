import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ServerEvent } from '@playroom/shared';
import { appendTaskEvent } from './events.js';

/**
 * TASKS — work as a record with a state (Bible §21.3).
 *
 * Everything the room held before this was an instant: a message, a summon, a turn, a decision.
 * None of them could say that work was underway, stuck, or finished, which is why
 * `input-required` was a state named in three places in the Bible and implemented in none.
 *
 * ── THE ROW IS A PROJECTION. THE LOG IS THE RECORD. ──
 *
 * Every function here that changes a task appends the event FIRST and updates the row second.
 * That order is the whole design:
 *
 *   * if the process dies between the two, the log is right and the row is stale — recoverable,
 *     and visible to the rebuild assertion in `tasks.test.ts`;
 *   * the other order loses the history and keeps a state nobody can explain.
 *
 * No transaction, deliberately. Wrapping the pair would need a dedicated client threaded
 * through every append (this codebase has no transactions anywhere yet) to buy atomicity
 * between a durable record and its own index. The cheaper property is enough BECAUSE the log
 * wins: `rebuild()` below is the function that says so in code rather than in a comment.
 */

/** The four states, as a type. Adding one is a decision at this line and at migration 011. */
export type TaskState = 'submitted' | 'working' | 'input-required' | 'held' | 'done';

export interface TaskRow {
  id: string;
  room_id: string;
  assignee_member_id: string;
  state: TaskState;
  action: string | null;
  intent: string;
  created_by: string;
  origin_cause_seq: string; // BIGINT arrives as a string
  origin_member: string;
}

const TASK_COLS =
  'id, room_id, assignee_member_id, state, action, intent, created_by, origin_cause_seq, origin_member';

export async function getTask(pool: Pool, id: string): Promise<TaskRow | null> {
  const { rows } = await pool.query<TaskRow>(`SELECT ${TASK_COLS} FROM tasks WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function tasksInRoom(pool: Pool, roomId: string): Promise<TaskRow[]> {
  const { rows } = await pool.query<TaskRow>(
    `SELECT ${TASK_COLS} FROM tasks WHERE room_id = $1 ORDER BY created_at`,
    [roomId],
  );
  return rows;
}

export interface EnsuredTask {
  task: TaskRow;
  /**
   * False when this cause had already created this task.
   *
   * The caller must not append a `task.created` event for an existing task, and must not treat
   * this as an error: it is the replay case, and it is the one S0.5a proved happens. Returning
   * the existing row rather than null is what lets the caller carry on — the summon it is about
   * to attempt has its own idempotency gate, and both need the same task id.
   */
  created: boolean;
}

/**
 * Create the task a summon is about to authorise, or return the one that already exists.
 *
 * IDEMPOTENT ON THE ORIGIN, at the database (migration 011's unique index), for the same reason
 * `appendSummon` is: two identical frames can be in flight before either has committed, so an
 * application-level check would decide correctly and still lose the race.
 *
 * The state is passed in rather than defaulted, because the caller is the only party that knows
 * whether the work can start: a task with a route begins `working`, and one whose route
 * selection failed begins `input-required` and never was working. Creating everything as
 * `working` and correcting it would put a lie in the log for one row's worth of time.
 */
export async function ensureTask(
  pool: Pool,
  input: {
    roomId: string;
    assignee: string;
    state: TaskState;
    action: string | null;
    intent: string;
    createdBy: string;
    causeSeq: number;
  },
): Promise<EnsuredTask> {
  const id = `task_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const inserted = await pool.query<TaskRow>(
    `INSERT INTO tasks
       (id, room_id, assignee_member_id, state, action, intent, created_by,
        origin_cause_seq, origin_member)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $3)
     ON CONFLICT (room_id, origin_cause_seq, origin_member) DO NOTHING
     RETURNING ${TASK_COLS}`,
    [
      id,
      input.roomId,
      input.assignee,
      input.state,
      input.action,
      input.intent,
      input.createdBy,
      input.causeSeq,
    ],
  );
  if (inserted.rows[0]) return { task: inserted.rows[0], created: true };

  const existing = await pool.query<TaskRow>(
    `SELECT ${TASK_COLS} FROM tasks
      WHERE room_id = $1 AND origin_cause_seq = $2 AND origin_member = $3`,
    [input.roomId, input.causeSeq, input.assignee],
  );
  return { task: existing.rows[0], created: false };
}

/** The `task.created` event. Separate from the row write so the caller controls fan-out. */
export function taskCreatedEvent(pool: Pool, task: TaskRow, actorId: string): Promise<ServerEvent> {
  return appendTaskEvent(pool, task.room_id, actorId, task.id, 'task.created', {
    task_id: task.id,
    state: task.state,
    assignee: task.assignee_member_id,
    action: task.action,
    intent: task.intent,
    created_by: task.created_by,
  });
}

/**
 * Move a task to a new state, recording why.
 *
 * RETURNS NULL WHEN THE STATE IS ALREADY THE TARGET, and that is not a failure. A replayed
 * frame, a retried turn, or a second observer of the same outcome must not append a second
 * identical transition — an event log where `working → working` appears is a log that cannot
 * be read as a history. A state change is an event; a state non-change is not.
 *
 * `actorId` is WHO CAUSED THE CHANGE, and the two answers here are deliberate:
 *
 *   * `done` is caused by the ASSIGNEE. The member finished the work.
 *   * `input-required` and `held` are caused by `system` — the room speaking. No member
 *     completed anything; the room noticed that the work cannot proceed and said which
 *     constraint or which error class stopped it. Attributing an outage to the agent that
 *     was unreachable would read as the agent having done something.
 */
export async function transitionTask(
  pool: Pool,
  task: TaskRow,
  to: TaskState,
  reason: string,
  actorId: string,
): Promise<ServerEvent | null> {
  if (task.state === to) return null;

  const event = await appendTaskEvent(pool, task.room_id, actorId, task.id, 'task.state', {
    task_id: task.id,
    state: to,
    from_state: task.state,
    reason,
    assignee: task.assignee_member_id,
  });
  await pool.query('UPDATE tasks SET state = $1, updated_at = now() WHERE id = $2', [to, task.id]);
  task.state = to; // keep the caller's copy honest — it is a projection, and so is this object
  return event;
}

/**
 * Move a task to another member — Bible §21.3, and the record S13-3 requires.
 *
 * Event first, row second, like every other transition here.
 *
 * THE STATE BECOMES `submitted`: received and not started. A handoff does not trigger a turn (an
 * agent cannot ask for work, and a handoff is not a summon), so `working` would be the room
 * claiming activity it does not have — see migration 012, which is where the state arrives.
 *
 * `mandateHash` is the RECEIVER's, resolved by the caller from the receiver's own mandate. There
 * is no parameter here for the sender's authority, and there must never be one: a handoff
 * narrows or refuses, it never widens.
 */
export async function handoffTask(
  pool: Pool,
  task: TaskRow,
  move: { toMember: string; action: string; mandateHash: string | null; actorId: string },
): Promise<ServerEvent> {
  const event = await appendTaskEvent(pool, task.room_id, move.actorId, task.id, 'task.handoff', {
    task_id: task.id,
    from_member: task.assignee_member_id,
    to_member: move.toMember,
    action: move.action,
    mandate_hash: move.mandateHash,
    state: 'submitted',
  });
  await pool.query(
    `UPDATE tasks SET assignee_member_id = $1, action = $2, state = 'submitted', updated_at = now()
      WHERE id = $3`,
    [move.toMember, move.action, task.id],
  );
  // The caller's copy is a projection too — keep it from being read as the pre-move truth.
  task.assignee_member_id = move.toMember;
  task.action = move.action;
  task.state = 'submitted';
  return event;
}

/**
 * WHAT RECORD, IF ANY, LETS `requester` NAME `subject` IN A GOVERNED REQUEST (S12-N2).
 *
 * Three answers, and every one of them is a row rather than a rule about names:
 *
 *   'self'           — the requester IS the subject. Nothing to justify.
 *   'delegated_task' — the requester created a task the subject now holds. Asking under the
 *                      mandate of a member you handed work to is what delegation means.
 *   'handoff'        — the requester performed a handoff TO the subject. Same standing, arrived
 *                      by the other path: a member who moved work to Sol may ask about it, even
 *                      if someone else created the task.
 *
 * Null means NO RECORD JUSTIFIES IT, and the request must be refused before the evaluator is
 * consulted — standing before the request (RA-007), which here also stops a caller with no
 * standing from learning what another member's mandate contains.
 *
 * ── WHAT THIS DOES NOT DO ──
 *
 * It does not require the task to be OPEN, or the request to name which task it is about. So
 * standing does not expire: a task delegated once justifies requests under that member's mandate
 * for as long as the room exists. The tighter version is `request_action` carrying a `task_id`,
 * which makes the justification exact rather than existential — recorded as S13-N1 rather than
 * built here, because a co-sign flow (S2.2) is the first thing that needs to name a task anyway.
 */
export type SubjectBasis = 'self' | 'delegated_task' | 'handoff';

export async function subjectBasis(
  pool: Pool,
  roomId: string,
  requester: string,
  subject: string,
): Promise<SubjectBasis | null> {
  if (requester === subject) return 'self';

  const { rows } = await pool.query<{ delegated: boolean; handed: boolean }>(
    `SELECT
       EXISTS (
         SELECT 1 FROM tasks
          WHERE room_id = $1 AND created_by = $2 AND assignee_member_id = $3
       ) AS delegated,
       EXISTS (
         SELECT 1 FROM events
          WHERE room_id = $1 AND event_type = 'task.handoff'
            AND actor_id = $2 AND payload ->> 'to_member' = $3
       ) AS handed`,
    [roomId, requester, subject],
  );
  if (rows[0].delegated) return 'delegated_task';
  if (rows[0].handed) return 'handoff';
  return null;
}

/**
 * Fold a task's events into the state they imply.
 *
 * THE FUNCTION THAT MAKES "THE LOG IS THE SOURCE OF TRUTH" A STATEMENT ABOUT CODE. If this
 * disagrees with the `tasks` row, the row is wrong — and `tasks.test.ts` asserts they agree for
 * every task it produces, so a future path that updates the column without appending the event
 * fails a test rather than quietly becoming the new truth.
 *
 * Events must arrive in `seq` order. Unknown event types are ignored rather than rejected: the
 * turns that did the work also carry this task's id, and they are not state changes.
 */
export function rebuild(events: readonly ServerEvent[]): TaskState | null {
  let state: TaskState | null = null;
  for (const ev of events) {
    if (
      ev.event_type === 'task.created' ||
      ev.event_type === 'task.state' ||
      ev.event_type === 'task.handoff'
    ) {
      state = ev.payload.state as TaskState;
    }
  }
  return state;
}
