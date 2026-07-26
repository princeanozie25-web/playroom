import type { DecisionEvent } from '@playroom/shared';
import { MemberChip } from './MemberChip';
import type { RosterMember } from './roster';

// The DECISION card. It takes a `decision` event and renders what the fabric
// stopped, who attempted it, why it was stopped, and who has to sign.
//
// ITS ONLY INPUT IS A `decision` EVENT FROM THE LOG. There is no prop for "show a
// pretend one", no default payload, and no branch that fabricates a field. The api
// does not emit `decision` yet — S2.1 decides and S2.2 signs — so today this card
// cannot appear in a real room at all, and that is correct. A surface that can
// display a block the fabric did not produce is the one thing this slice may not
// ship. The fixture route at /dev/decision-card exists so the layout can be
// iterated without inventing an event in a room; it is dev-only and never filmed.
//
// Approve / deny are DISABLED and labelled S2.2. They are not wired to anything and
// must not be: acting on a decision is the co-sign flow, and pretending to sign one
// would be exactly the fake governance this slice forbids.

// reason_code is DATA; this sentence is PRESENTATION. The code arrives as an open
// string (CONTRIBUTING: open strings for taxonomies that grow), so an unknown code
// still renders as an explicit refusal rather than being dropped — the A4-F1 lesson
// applied to a lookup table.
const REASONS: Record<string, string> = {
  PROTECTED_ACTION: 'this action is protected and is never granted by a mandate',
  OUT_OF_SCOPE: 'this action is not in the scope the mandate grants',
  MANDATE_EXPIRED: "the member's mandate has expired",
  NO_MANDATE: 'this member has no mandate, so has no authority',
};

export function DecisionCard({ event, roster }: { event: DecisionEvent; roster: RosterMember[] }) {
  const p = event.payload;
  const attempted = roster.find((m) => m.id === p.subject);

  return (
    <section className="decision" aria-label="decision required">
      <div className="decision-kicker">Decision · {p.decision}</div>
      <div className="decision-action">
        <code>{p.action}</code>
      </div>

      <dl className="decision-rows">
        <dt>Attempted by</dt>
        <dd>
          <MemberChip member={attempted} name={p.subject} inline />
        </dd>

        <dt>Stopped because</dt>
        <dd>
          {REASONS[p.reason_code] ?? 'refused'}{' '}
          <span className="decision-pending">({p.reason_code})</span>
        </dd>

        {p.required_signer && (
          <>
            <dt>Requires</dt>
            <dd>a co-signature from {p.required_signer}</dd>
          </>
        )}

        <dt>Under mandate</dt>
        <dd className="decision-pending">
          {p.effective_mandate_hash
            ? p.effective_mandate_hash.slice(0, 23) + '\u2026'
            : 'no mandate'}
        </dd>
      </dl>

      <div className="decision-actions">
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
