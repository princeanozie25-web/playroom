'use client';

import type { DecisionEvent } from '@playroom/shared';
import { MemberName } from './MemberChip';
import { Panel } from './Panel';
import { DisabledControl } from './DisabledControl';
import type { Principal, RosterMember } from './roster';
import { HOOK, pr } from './hooks';

// The DECISION card. It takes a `decision` event and renders what the fabric stopped, under
// whose mandate it was evaluated, why it was stopped, and who has to sign.
//
// ITS ONLY INPUT IS A `decision` EVENT FROM THE LOG. There is no prop for "show a pretend
// one", no default payload, and no branch that fabricates a field. A surface that can display
// a block the fabric did not produce is the one thing this component may not become — and
// appearance work is exactly where that slips, because a nicer card invites a nicer story.
// The fixture route at /dev/decision-card exists so the layout can be iterated without
// inventing an event in a room; it is dev-only, 404s in production, and is never filmed.
//
// The api DOES emit `decision` — M-3's commands/requestAction.ts is the only construction
// site, and S0.6 filmed this card rendering from a real row in a real room.
//
// S06-N3 IS CLOSED HERE. The card said "Attempted by Claude", which asserts agency the
// product does not have: nothing lets an agent initiate a structured action, because
// `AgentTurnChunk` is text_delta | done | error with no tool-call channel, so a request is
// always issued ON a member's behalf by a caller. It now says "requested under Claude's
// mandate" — true, because the request named Claude as its subject and was evaluated against
// Claude's mandate, and it claims nothing about intent. The evaluation is real; the intent was
// never demonstrated, and the film's claims sheet had to spend a paragraph counteracting a
// label instead. A wording change was the whole fix, and it belonged in a slice about wording.
//
// Approve / deny are LIVE now (S2.2), but only for the REQUIRED SIGNER — the human bound to the
// decision's required principal. Everyone else sees them inert, with the signer named; an agent never
// sees a live button. The affordance is a courtesy, not the authority: even a forged frame is refused
// server-side (commands/signDecision.ts), so showing the button to the right person is UX, and the
// check is elsewhere. Once answered, the card shows the OUTCOME in place of the buttons — the same
// decision, now approved or denied, never a second card.

// reason_code is DATA; these sentences are PRESENTATION.
//
// A REVIEWED LOOKUP TABLE, deliberately — it produced a false statement once and no test
// asserts prose, so the review is the control. The code arrives as an open string
// (CONTRIBUTING: open strings for taxonomies that grow), so an unknown code still renders as
// an explicit refusal rather than being dropped — the A4-F1 lesson applied to a table.
//
// Each sentence must be true of the VERDICT ALONE. None of them may mention who asked, what
// they intended, or what would have happened, because the event carries none of that.
const REASONS: Record<string, string> = {
  PROTECTED_ACTION: 'The mandate grants this action, but a human has to sign for it.',
  OUT_OF_SCOPE: 'The mandate does not grant this action.',
  MANDATE_EXPIRED: 'The mandate this was checked against has expired.',
  NO_MANDATE: 'There is no mandate for this member, so there is no authority to act under.',
};

const FALLBACK_REASON = 'This was refused.';

export function DecisionCard({
  event,
  resolution,
  signedBy,
  roster,
  principals = [],
  viewer,
  onSign,
}: {
  event: DecisionEvent;
  /** The decision's answer once a human has signed (S2.2), or null while it is still pending. */
  resolution: 'APPROVED' | 'DENIED' | null;
  /** The member who signed, once answered. */
  signedBy: string | null;
  roster: RosterMember[];
  principals?: Principal[];
  /** The member reading this page, so the card can offer the button only to the required signer. */
  viewer: string | null;
  /** Send the co-signature. Optional so the dev fixture (a server component) can render without one. */
  onSign?: (decisionId: string, resolution: 'APPROVED' | 'DENIED') => void;
}) {
  const p = event.payload;
  const subject = roster.find((m) => m.id === p.subject);
  // The requester, if they are in the roster. `MemberName` renders a human without an accent and
  // with a different marker shape, so "who asked" and "under whose mandate" are distinguishable
  // by looking rather than by reading the words between them.
  const requester = roster.find((m) => m.id === p.requested_by);
  // A principal renders as a NAME. Absent from config, it renders nothing at all rather than
  // falling back to `principal:prince` — an internal identifier in front of a viewer is the
  // same category error `mandate_label` was.
  const signer = principals.find((x) => x.id === p.required_signer);
  // Is the VIEWER the required signer — the human bound to the decision's required principal? Only
  // then is the button live. Mirrors the server's check (commands/signDecision.ts); it is a courtesy
  // affordance, not the authority, so a wrong guess here is refused rather than obeyed. An agent that
  // happens to share the principal is excluded by the human-kind check, exactly as on the server.
  const viewerMember = roster.find((m) => m.id === viewer);
  const isSigner =
    !!p.required_signer &&
    viewerMember?.kind === 'human' &&
    viewerMember.principal === p.required_signer;
  const signedByMember = signedBy ? roster.find((m) => m.id === signedBy) : undefined;
  // Why the inert Approve/Deny are inert: a claim on a specific person. Sourced from the required
  // signer — the same source the visible "Awaiting …" line reads — so the control and the sentence
  // beside it cannot disagree about who the room is waiting on.
  const pendingReason = signer ? `Awaiting ${signer.display_name}` : 'Awaiting the named principal';

  return (
    <Panel as="section" className="decision" hook={HOOK.decision} aria-label="decision required">
      <div className="decision-kicker">
        Decision · <span {...pr(HOOK.decisionVerdict)}>{p.decision}</span>
      </div>

      <div className="decision-action" {...pr(HOOK.decisionAction)}>
        <code>{p.action}</code>
      </div>

      {/* Sentences a person would say, not a form. The uppercase grey field labels —
          ATTEMPTED BY / STOPPED BECAUSE / REQUIRES / UNDER MANDATE — were what made this
          read as a database row with a border. */}
      {/* THE SENTENCE THE RECORD NOW SUPPORTS (S1.3).
          It read "Requested under Claude's mandate." — true about the mandate, silent about who
          asked, and S12-N2 meant the room could not have said more honestly: any authenticated
          member could name any other as the subject. Both halves are proven now — the requester
          by their credential (S1.2), the attribution by a task or handoff record (S13-3) — so the
          card names both. A decision event whose subject nothing justifies does not exist: the
          request is refused before the evaluator runs. */}
      <p className="decision-line">
        Requested by <MemberName member={requester} name={p.requested_by} /> under{' '}
        <MemberName member={subject} name={p.subject} />
        {"'s mandate."}
      </p>

      <p className="decision-line" {...pr(HOOK.decisionReason)}>
        {REASONS[p.reason_code] ?? FALLBACK_REASON}{' '}
        <span className="decision-code" {...pr(HOOK.decisionCode)}>
          {p.reason_code}
        </span>
      </p>

      {p.required_signer && (
        <p className="decision-line decision-needs" {...pr(HOOK.decisionSigner)}>
          {/* Unnamed rather than misnamed. If config does not name this principal, the card
              says a signature is needed WITHOUT naming anyone — the first draft fell back to
              the subject's own display name, which would have read as Claude signing for
              itself: a fabricated authority relationship, which is the precise failure this
              component exists to prevent. */}
          {signer ? (
            <>
              Needs a signature from <strong>{signer.display_name}</strong>.
            </>
          ) : (
            <>Needs a signature from the principal this mandate names.</>
          )}
        </p>
      )}

      {/* The proof, and it stays on screen: quiet, monospace, truncated, not competing
          with the sentence above it. */}
      <p className="decision-hash" {...pr(HOOK.decisionHash)}>
        {p.effective_mandate_hash ? (
          <>
            under mandate <code>{p.effective_mandate_hash.slice(0, 23)}&#8230;</code>
          </>
        ) : (
          'no mandate was in force'
        )}
      </p>

      <div className="decision-actions" {...pr(HOOK.decisionActions)}>
        {resolution ? (
          // ANSWERED — the card shows the outcome, not the buttons. The decision is done, in place.
          <span className="decision-resolved" data-pr-resolution={resolution}>
            {resolution === 'APPROVED' ? 'Approved' : 'Denied'}
            {signedByMember ? <> by {signedByMember.display_name}</> : null}
          </span>
        ) : isSigner ? (
          // LIVE, and only for the required signer (S2.2). The frame carries no identity claim — who
          // is signing is the socket's authenticated member, which the server reads for itself.
          <>
            <button type="button" onClick={() => onSign?.(p.decision_id, 'APPROVED')}>
              Approve
            </button>
            <button type="button" onClick={() => onSign?.(p.decision_id, 'DENIED')}>
              Deny
            </button>
          </>
        ) : (
          // INERT for everyone else, and the signer is NAMED — a claim on someone specific, so the
          // room says who rather than dangling a button that would be refused.
          <>
            <DisabledControl reason={pendingReason}>Approve</DisabledControl>
            <DisabledControl reason={pendingReason}>Deny</DisabledControl>
            <span className="decision-pending">
              {signer ? <>Awaiting {signer.display_name}</> : <>Awaiting the named principal</>}
            </span>
          </>
        )}
      </div>
    </Panel>
  );
}
