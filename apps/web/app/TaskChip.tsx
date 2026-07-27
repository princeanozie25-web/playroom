import { MemberName } from './MemberChip';
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
    <div className="task-chip" {...pr(HOOK.task)} data-pr-state={task.state}>
      <span className="task-kicker">task</span>
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
    </div>
  );
}
