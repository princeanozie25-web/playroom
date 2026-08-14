'use client';

import { MemberName } from './MemberChip';
import type { RosterMember } from './roster';
import { HOOK, pr } from './hooks';

// THE ROOM BRIEFING — owner-authored framing pinned to the room (S1.7, Bible §7.2).
//
// ITS ONLY INPUT IS A `briefing.set` OR `briefing.cleared` EVENT. Same rule as the promotion row, the
// DECISION card, the task chip and the interrupt chip: no prop for a pretend one, no default that
// invents an owner or a purpose. A row exists because the log says the owner set, replaced or cleared
// the room's briefing.
//
// ── WHY IT IS VISIBLY DISTINCT, AND NOT A MESSAGE ──
//
// A briefing is NOT somebody talking in the room now — it is the standing framing every member
// inherits, set once by the owner and paid on every summon. Rendered as a message it would read as one
// more line to scroll past: an agent could reasonably ignore it and a human could miss that the room
// has a standing brief at all. So it is a PINNED, framed line, labelled as the room's briefing, in a
// register of its own — not a bubble, not a byline.
//
// ── NO ACCENT, AND THE TEXT STAYS TEXT ──
//
// No principal accent: an accent answers "whose authority does this carry", and a briefing carries
// NONE — it configures framing, never authority (proven in the api, not here; nothing about this
// component is load-bearing for that). The content is rendered with whitespace preserved and no markup
// parsed, the same discipline as promoted text and agent output (A4-F8, §13).

export interface BriefingItemView {
  /** `set` (including a replacement) or `cleared` — which event this row records. */
  kind: 'set' | 'cleared';
  briefing_id: string;
  /** The owner who set or cleared it. */
  by: string;
  /** Why, in the owner's words. Present on a set, absent on a clear. */
  purpose?: string;
  /** The framing itself. Present on a set, absent on a clear. */
  content?: string;
  /** True when this set REPLACED a prior briefing, so the head can say "updated" rather than "set". */
  replaced?: boolean;
}

export function BriefingRow({
  briefing,
  roster,
}: {
  briefing: BriefingItemView;
  roster: Map<string, RosterMember>;
}) {
  const verb = briefing.kind === 'cleared' ? 'cleared' : briefing.replaced ? 'updated' : 'set';
  return (
    <div className="briefing" {...pr(HOOK.briefing)} data-pr-kind={briefing.kind}>
      <p className="briefing-head" {...pr(HOOK.briefingHead)}>
        {/* The label is what makes it unmistakably the room's standing brief and not a message. */}
        <span className="briefing-label">Room briefing</span> {verb} by{' '}
        <MemberName member={roster.get(briefing.by)} name={briefing.by} />
        {briefing.purpose ? (
          <>
            {' — '}
            <span className="briefing-purpose">{briefing.purpose}</span>
          </>
        ) : null}
      </p>
      {briefing.content ? (
        <blockquote className="briefing-body" {...pr(HOOK.briefingBody)}>
          {briefing.content}
        </blockquote>
      ) : null}
    </div>
  );
}
