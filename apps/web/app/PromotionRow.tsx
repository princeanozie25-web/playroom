'use client';

import { MemberName } from './MemberChip';
import type { RosterMember } from './roster';
import { HOOK, pr } from './hooks';

// A PROMOTION — somebody moved a private note into this room (Bible §7.2, §5.2).
//
// ITS ONLY INPUT IS A `context.promoted` EVENT. Same rule as the DECISION card, the task chip and
// the interrupt chip: no prop for a pretend one, no default purpose, no branch that invents an
// approver. A row exists because the log says a disclosure happened.
//
// ── WHY IT LOOKS LIKE A SYSTEM LINE AND NOT LIKE SOMEBODY TALKING ──
//
// §5.2: promoted content must be visually distinct from native content. The reason is not neatness.
// A room's transcript is a record of what was said IN IT, and a promotion is not that — it is text
// that was written somewhere else, by someone who may not be here, for a different audience. Given a
// byline and a bubble it would read as a member speaking now, and the two things a reader most needs
// (this is imported; here is why it was shared) would be exactly the two things the rendering hid.
//
// So: a quiet line, in the same register as a spend footer. Who shared it, why, and how much —
// verbatim or the summary — then the content, inset and quoted. Small, unaccented, and unmistakably
// not a turn.
//
// ── THE CONTENT IS TEXT, AND STAYS TEXT ──
//
// Rendered inside an element whose CSS preserves whitespace and parses no markup, for the same
// reason agent output is (A4-F8, §13): this is the one surface in the room carrying text from
// outside the room, so it is the last place to start interpreting markup. A promoted `@sol` also
// summons nobody — but that is enforced in the api by the event type, not here. NOTHING ABOUT THIS
// COMPONENT IS LOAD-BEARING FOR THAT, and it must not be described as if it were.

export interface PromotionItemView {
  promotion_id: string;
  source_principal: string;
  representation: string;
  purpose: string;
  approved_by: string;
  content: string;
}

/** How much was disclosed, in words a person would use rather than the column's value. */
const REPRESENTATION_WORDS: Record<string, string> = {
  verbatim: 'in full',
  summary: 'as a summary',
};

export function PromotionRow({
  promotion,
  roster,
}: {
  promotion: PromotionItemView;
  roster: Map<string, RosterMember>;
}) {
  const how = REPRESENTATION_WORDS[promotion.representation] ?? promotion.representation;
  return (
    <div
      className="promotion"
      {...pr(HOOK.promotion)}
      data-pr-representation={promotion.representation}
    >
      <p className="promotion-head">
        {/* WHO, from the roster, so a promotion names a member the same way every other row does. */}
        <MemberName member={roster.get(promotion.approved_by)} name={promotion.approved_by} />{' '}
        <span {...pr(HOOK.promotionHead)}>
          shared a private note {how} —{' '}
          <span {...pr(HOOK.promotionPurpose)}>{promotion.purpose}</span>
        </span>
      </p>
      {/* The disclosed text, inset and quoted so the boundary between imported and native content
          is a visible edge rather than a change of tone. */}
      <blockquote className="promotion-body" {...pr(HOOK.promotionBody)}>
        {promotion.content}
      </blockquote>
    </div>
  );
}
