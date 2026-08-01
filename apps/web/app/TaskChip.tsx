import { MemberName } from './MemberChip';
import { Chip } from './Chip';
import type { RosterMember } from './roster';
import { HOOK, pr } from './hooks';

// THE TASK CHIP — Bible §11: "task state changes (working, input-required, done) render as
// chips the moment they commit."
//
// ITS ONLY INPUT IS THE TASK EVENTS IN THE LOG. Same rule as the DECISION card: there is no
// prop for "show a pretend one", no default state, and no branch that invents a field. A task
// chip exists because `task.created` arrived, and its state is whatever the last `task.state`
// said. If the room ever shows a chip the log did not produce, this component is where that
// went wrong.
//
// ONE CHIP PER TASK, rendered where the work was ASKED FOR, updating in place as the state
// changes — not one chip per transition. A transcript that grows a row every time a state moves
// reads as activity rather than as work: three chips saying working / working / done is the same
// information as one saying done, plus two distractions. The history is in the log, which is
// where a history belongs.

/** The four states, as words a person would use. Unknown states render verbatim. */
const STATE_WORDS: Record<string, string> = {
  // Received and not started. `assigned` rather than `submitted`, because the state name is
  // A2A's vocabulary and this is a sentence in a room — and because nothing is queued anywhere,
  // which is what `submitted` would suggest to a reader who knows the spec.
  submitted: 'assigned',
  working: 'working',
  'input-required': 'needs input',
  held: 'held',
  done: 'done',
};

export interface TaskItemView {
  task_id: string;
  state: string;
  assignee: string;
  /** The action the work names, once a handoff has said what it is. Null for chat work. */
  action: string | null;
  /**
   * The mandate the current assignee acts under, as a hash — set by a handoff (Bible §21.3
   * requires the mandate reference to travel with the task).
   *
   * Shown TRUNCATED and never expanded into a claim about authority: the hash identifies WHICH
   * document was in force, not that anyone signed it. S2.1 is what makes a mandate signed, and
   * the claims sheet says so for the decision card's hash too.
   */
  mandate_hash: string | null;
  /** Who handed it over, when it was handed over. Null for a task nobody has moved. */
  handed_by: string | null;
}

export function TaskChip({
  task,
  roster,
}: {
  task: TaskItemView;
  roster: Map<string, RosterMember>;
}) {
  const assignee = roster.get(task.assignee);
  return (
    <Chip hook={HOOK.task} kicker="task" data-pr-state={task.state}>
      <span className="task-state" {...pr(HOOK.taskState)}>
        {STATE_WORDS[task.state] ?? task.state}
      </span>
      {/* WHO HOLDS IT NOW. A task whose assignee is not on screen is a state with no owner. */}
      <MemberName member={assignee} name={task.assignee} />
      {task.action && (
        <code className="task-action" {...pr(HOOK.taskAction)}>
          {task.action}
        </code>
      )}
      {task.handed_by && (
        // The sentence a handoff earns, and no more: it moved, and this is the mandate the
        // RECEIVING member acts under. Never the sender's — a handoff confers no authority.
        <span className="task-mandate" {...pr(HOOK.taskMandate)}>
          under {task.mandate_hash ? `${task.mandate_hash.slice(0, 14)}…` : 'no mandate'}
        </span>
      )}
    </Chip>
  );
}

/**
 * THE HANDOFF ROW — a distinct act, at the point it happened.
 *
 * The task chip above shows STATE and updates in place. That is right for progress: `working →
 * done` is the completion of work whose turn is sitting next to it. It is WRONG for a handoff,
 * for two reasons that both matter:
 *
 *   * A handoff is an ACT BY A MEMBER, with an actor and a decision behind it — closer to
 *     something someone said than to a status changing. The room's log records it that way
 *     (`task.handoff` carries `actor_id`), and the transcript should too.
 *   * A chip that mutates in place is INVISIBLE ONCE IT HAS SCROLLED AWAY. Two long agent turns
 *     put the chip above the fold, and a member watching the room would see nothing happen —
 *     which is the RT-001 family of problem in a surface rather than a write path: the change is
 *     real, recorded, and unobservable to the person it concerns.
 *
 * So the state lives in one chip and the act gets its own row. Both read from the same events;
 * neither invents a field.
 */
export interface HandoffItemView {
  task_id: string;
  actor: string;
  from_member: string;
  to_member: string;
  action: string;
  mandate_hash: string | null;
}

export function HandoffRow({
  handoff,
  roster,
}: {
  handoff: HandoffItemView;
  roster: Map<string, RosterMember>;
}) {
  return (
    <Chip
      hook={HOOK.handoff}
      modifier="handoff-row"
      kicker="handoff"
      data-pr-to={handoff.to_member}
    >
      <MemberName member={roster.get(handoff.actor)} name={handoff.actor} />
      <span className="handoff-arrow" aria-label="hands to">
        →
      </span>
      <MemberName member={roster.get(handoff.to_member)} name={handoff.to_member} />
      <code className="task-action" {...pr(HOOK.taskAction)}>
        {handoff.action}
      </code>
      {/* THE MANDATE THE RECEIVER WILL ACT UNDER — Bible §21.3 requires the reference to travel
          with the task. It identifies WHICH document is in force and proves nothing about who
          authorised it: mandates are unsigned until S2.1, and the claims sheet says so of the
          decision card's hash for the same reason. */}
      <span className="task-mandate" {...pr(HOOK.taskMandate)}>
        under {handoff.mandate_hash ? `${handoff.mandate_hash.slice(0, 21)}…` : 'no mandate'}
      </span>
    </Chip>
  );
}

/**
 * THE SUMMON ROW — a summon that is a visible ACT, rendered as what it is.
 *
 * Two kinds render, and a human tag renders NEITHER (it is already visible as the @-mention in the
 * human's own message; a second row would be the "two representations of one visible fact" mistake):
 *   * `agent` (S1.8) — one agent brought another into its turn. Same shape as the handoff row: an act
 *     by a member upon a member.
 *   * `order` (S-LOOP) — a STANDING ORDER fired this summon. It reads distinctly — "standing order (by
 *     Prince) → summons Sol" — because nothing else in the transcript shows it, and it is neither a
 *     human tag nor an agent's own act: a person authorised it once, and it recurs. `by` is the human
 *     creator at the head of the chain (root_actor); the order confers no authority, so no hash/action.
 *
 * Labelling only, using the existing member colour and marker system unchanged.
 */
export interface SummonItemView {
  kind: 'agent' | 'order';
  by: string; // the emitting agent (agent kind) or the order's human creator (order kind)
  member: string;
}

export function SummonRow({
  summon,
  roster,
}: {
  summon: SummonItemView;
  roster: Map<string, RosterMember>;
}) {
  return (
    <Chip
      hook={HOOK.summon}
      modifier="summon-row"
      data-pr-to={summon.member}
      data-pr-kind={summon.kind}
      kicker={summon.kind === 'order' ? 'standing order' : 'summon'}
    >
      {summon.kind === 'order' ? (
        <>
          <span className="order-by">
            by <MemberName member={roster.get(summon.by)} name={summon.by} />
          </span>
        </>
      ) : (
        <MemberName member={roster.get(summon.by)} name={summon.by} />
      )}
      <span className="handoff-arrow" aria-label="summons">
        →
      </span>
      <MemberName member={roster.get(summon.member)} name={summon.member} />
    </Chip>
  );
}
