'use client';

import { MemberName } from './MemberChip';
import { Chip } from './Chip';
import type { RosterMember } from './roster';
import { HOOK, pr } from './hooks';

// THE INTERRUPT CHIP — a claim on a person's attention, and what it cost to make (Bible §21.3, §18).
//
// ITS ONLY INPUT IS INTERRUPT EVENTS. Same rule as the DECISION card and the task chip: no prop
// for a pretend one, no default urgency, no branch that invents a field. A chip exists because
// `interrupt.raised` arrived, and its urgency is whatever the last event said.
//
// ── THE BUDGET IS AMBIENT, NOT A BADGE ──
//
// design.md principle 4, and §18. The remaining budget sits at the end of the line in the same
// quiet type as a spend footer — it is context for the claim, not a score to watch. A badge would
// make the number the point; the point is the claim, and the number is what it cost.
//
// It is a SNAPSHOT taken when the event was written, not a live gauge. That is deliberate: a live
// number would make an old row appear to change its mind, and the honest question a reader has
// about a past claim is "what did this cost then", not "what is left now".

/** The three urgencies, as words a person would use, and what each one did. */
const URGENCY_WORDS: Record<string, string> = {
  BLOCKER: 'blocking',
  DECISION: 'needs a decision',
  FYI: 'for information',
};

export interface InterruptItemView {
  interrupt_id: string;
  urgency: string;
  raised_by: string;
  addressed_to: string;
  summary: string;
  budget_remaining: number | null;
  /** True once the recipient has lowered it — the tap has happened and cannot happen twice. */
  downgraded: boolean;
}

export function InterruptChip({
  interrupt,
  roster,
  viewer,
  onDowngrade,
}: {
  interrupt: InterruptItemView;
  roster: Map<string, RosterMember>;
  /** The member this browser is connected as. Only they may lower a claim on their attention. */
  viewer: string | null;
  onDowngrade: (interruptId: string) => void;
}) {
  const canDowngrade =
    viewer !== null && viewer === interrupt.addressed_to && interrupt.urgency !== 'FYI';

  return (
    <Chip
      hook={HOOK.interrupt}
      modifier="interrupt-chip"
      kicker="interrupt"
      data-pr-urgency={interrupt.urgency}
    >
      <span className="interrupt-urgency" {...pr(HOOK.interruptUrgency)}>
        {URGENCY_WORDS[interrupt.urgency] ?? interrupt.urgency}
      </span>
      <MemberName member={roster.get(interrupt.raised_by)} name={interrupt.raised_by} />
      <span className="interrupt-summary">{interrupt.summary}</span>

      {/* WHAT IT COST THE RAISER. Quiet, small, at the end — the same weight as a spend line,
          because it is the same kind of fact. Absent entirely when the member holds no mandate
          and therefore no limit: an empty space is honest, and "unlimited" would be a claim. */}
      {interrupt.budget_remaining !== null && (
        <span className="interrupt-budget" {...pr(HOOK.interruptBudget)}>
          {interrupt.budget_remaining} left today
        </span>
      )}

      {/* ONE TAP, and only for the member whose attention is claimed. Nobody else may decide on
          someone's behalf what deserves it, and the raiser lowering their own would be a refund.
          There is no upgrade control, and no place to put one. */}
      {canDowngrade && (
        <button
          type="button"
          className="interrupt-downgrade"
          {...pr(HOOK.interruptDowngrade)}
          onClick={() => onDowngrade(interrupt.interrupt_id)}
        >
          lower
        </button>
      )}
    </Chip>
  );
}
