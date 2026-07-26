import type { DecisionEvent } from '@playroom/shared';
import { MemberName } from './MemberChip';
import type { RosterMember } from './roster';
import { HOOK, pr } from './hooks';

// The DECISION card. It takes a `decision` event and renders what the fabric
// stopped, who attempted it, why it was stopped, and who has to sign.
//
// ITS ONLY INPUT IS A `decision` EVENT FROM THE LOG. There is no prop for "show a
// pretend one", no default payload, and no branch that fabricates a field. A surface
// that can display a block the fabric did not produce is the one thing this slice may
// not ship. The fixture route at /dev/decision-card exists so the layout can be
// iterated without inventing an event in a room; it is dev-only and never filmed.
//
// The api DOES emit `decision` now — M-3's commands/requestAction.ts is the only
// construction site, and S0.6 filmed this card rendering from a real row in a real room.
// (This comment previously said the card "cannot appear in a real room at all", which
// stopped being true the moment requestAction landed. Corrected here rather than left to
// mislead the next reader of the file that renders the film's central claim.)
//
// FINDING S06-N3, not fixed here: "Attempted by" asserts agency the product does not
// have. Nothing lets an agent initiate a structured action — `AgentTurnChunk` is
// text_delta | done | error, with no tool-call channel — so the request is always issued
// ON a member's behalf by a caller. The evaluation is real and server-side; the intent is
// not demonstrated. See docs/demo/p0-claims.md, which tells anyone cutting the film not
// to narrate it as an attempt. Trigger: the slice that gives adapters tool calls (S1.3's
// handoff object), which is the first point at which the label could become true.
//
// Approve / deny are DISABLED and labelled S2.2. They are not wired to anything and
// must not be: acting on a decision is the co-sign flow, and pretending to sign one
// would be exactly the fake governance this slice forbids.

// reason_code is DATA; this sentence is PRESENTATION. The code arrives as an open
// string (CONTRIBUTING: open strings for taxonomies that grow), so an unknown code
// still renders as an explicit refusal rather than being dropped — the A4-F1 lesson
// applied to a lookup table.
const REASONS: Record<string, string> = {
  PROTECTED_ACTION: 'this action is protected — the mandate grants it, but a human must sign',
  OUT_OF_SCOPE: 'this action is not in the scope the mandate grants',
  MANDATE_EXPIRED: "the member's mandate has expired",
  NO_MANDATE: 'this member has no mandate, so has no authority',
};

export function DecisionCard({ event, roster }: { event: DecisionEvent; roster: RosterMember[] }) {
  const p = event.payload;
  const attempted = roster.find((m) => m.id === p.subject);

  return (
    <section className="decision" aria-label="decision required" {...pr(HOOK.decision)}>
      <div className="decision-kicker">
        Decision · <span {...pr(HOOK.decisionVerdict)}>{p.decision}</span>
      </div>
      <div className="decision-action" {...pr(HOOK.decisionAction)}>
        <code>{p.action}</code>
      </div>

      <dl className="decision-rows">
        <dt>Attempted by</dt>
        <dd>
          <MemberName member={attempted} name={p.subject} />
        </dd>

        <dt>Stopped because</dt>
        <dd {...pr(HOOK.decisionReason)}>
          {REASONS[p.reason_code] ?? 'refused'}{' '}
          <span className="decision-pending" {...pr(HOOK.decisionCode)}>
            ({p.reason_code})
          </span>
        </dd>

        {p.required_signer && (
          <>
            <dt>Requires</dt>
            <dd {...pr(HOOK.decisionSigner)}>a co-signature from {p.required_signer}</dd>
          </>
        )}

        <dt>Under mandate</dt>
        <dd className="decision-pending" {...pr(HOOK.decisionHash)}>
          {p.effective_mandate_hash
            ? p.effective_mandate_hash.slice(0, 23) + '\u2026'
            : 'no mandate'}
        </dd>
      </dl>

      <div className="decision-actions" {...pr(HOOK.decisionActions)}>
        <button type="button" disabled>
          Approve
        </button>
        <button type="button" disabled>
          Deny
        </button>
        <span className="decision-pending">S2.2</span>
      </div>
    </section>
  );
}
