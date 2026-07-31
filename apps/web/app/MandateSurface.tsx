import type { RosterMember } from './roster';
import { discloseLimits, expiryState, truncateHash } from './mandate';
import { HOOK, pr } from './hooks';

// THE MANDATE SURFACE — what a mandate SAYS, rendered so it cannot say more than it says (UI3-3).
//
// The anti-goal, stated first: a switch shown in a position the mandate does not hold is a lie the
// product exists to make impossible. So every control here is DISABLED and in its TRUE position, every
// label is honest, and there is no third "off-because-we-don't-know" state. Three facts are kept apart
// on purpose and must never be collapsed:
//
//   • NOT DISCLOSED — the server sent null (this member has no mandate). Never rendered as "off",
//     "none", or an omitted row: an absent fact and a false one are different claims.
//   • NONE — the mandate carries an empty value ([] / {}): a real "nothing gated" / "no limits declared".
//   • a value — rendered as itself.
//
// TWO NAMED TRAPS this component must not fall into:
//   • Expiry is a STATE, not a date. A mandate past its `expires` reads as EXPIRED — never as live
//     authority with a stale date beside it. `expiryState` derives that; this never formats the raw string.
//   • The hash is displayed truncated for the screen but the WHOLE value stays in the DOM and is copyable
//     — a half-hash identifies the wrong document as confidently as the right one.
//
// NO EVENT HANDLERS, NO CLIENT STATE. It renders read-only markup: disabled inputs and select-all text.
// That keeps it renderable in any tree and keeps the promise honest — there is nothing here to click that
// could change anything, because there is nothing this surface could call. UI3-3c proves that by search.

function formatDay(iso: string): string {
  // Plain and locale-stable: the calendar day, which is enough to read "when". No dependency, and
  // ISO's own YYYY-MM-DD rather than a locale format that reorders month and day per viewer.
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}

export function MandateSurface({ member }: { member: RosterMember }) {
  const cosign = member.co_sign; // { actions, by } | null
  const limits = discloseLimits(member.limits);
  const expiry = expiryState(member.expires, new Date());

  return (
    <dl className="mandate-surface" {...pr(HOOK.mandateSurface)}>
      {/* STATUS — first, because expiry decides whether everything below is authority still in force. */}
      <div className="mandate-field">
        <dt>Status</dt>
        <dd {...pr(HOOK.mandateStatus)} data-pr-state={expiry.kind}>
          {expiry.kind === 'undisclosed' && (
            <span className="mandate-undisclosed">not disclosed</span>
          )}
          {expiry.kind === 'live' && (
            <span className="mandate-live">live · expires {formatDay(expiry.at)}</span>
          )}
          {expiry.kind === 'expired' && (
            <span className="mandate-expired">expired · {formatDay(expiry.at)}</span>
          )}
        </dd>
      </div>

      {/* CO-SIGNATURE — disabled checkboxes, CHECKED because each listed action genuinely requires a
          signature. The checkbox in its true position is the point: it cannot be toggled, and it is not
          shown off for an action that is in fact gated. */}
      <div className="mandate-field">
        <dt>Co-signature</dt>
        <dd {...pr(HOOK.mandateCoSign)}>
          {cosign == null ? (
            <span className="mandate-undisclosed">not disclosed</span>
          ) : cosign.actions.length === 0 ? (
            <span className="mandate-none">none required</span>
          ) : (
            <ul className="mandate-list">
              {cosign.actions.map((action) => (
                <li key={action}>
                  <input
                    type="checkbox"
                    checked
                    disabled
                    readOnly
                    aria-label={`${action} requires a co-signature by ${cosign.by}`}
                  />
                  <code>{action}</code>
                  <span className="mandate-by">by {cosign.by}</span>
                </li>
              ))}
            </ul>
          )}
        </dd>
      </div>

      {/* LIMITS — declared, and SAID to be declared: they are not enforced yet (S2.7), and a surface that
          implied a live cap would be claiming an enforcement the fabric does not perform. */}
      <div className="mandate-field">
        <dt>
          Limits <span className="mandate-note">declared, not yet enforced</span>
        </dt>
        <dd {...pr(HOOK.mandateLimits)}>
          {limits.kind === 'undisclosed' ? (
            <span className="mandate-undisclosed">not disclosed</span>
          ) : limits.kind === 'empty' ? (
            <span className="mandate-none">none declared</span>
          ) : (
            <ul className="mandate-list">
              {limits.value.map(([name, value]) => (
                <li key={name}>
                  <code>{name}</code>
                  <span className="mandate-limit-value">{value}</span>
                </li>
              ))}
            </ul>
          )}
        </dd>
      </div>

      {/* POLICY VERSION — which ruleset the document was written against. */}
      <div className="mandate-field">
        <dt>Policy</dt>
        <dd {...pr(HOOK.mandatePolicy)}>
          {member.policy_version == null ? (
            <span className="mandate-undisclosed">not disclosed</span>
          ) : (
            <code>{member.policy_version}</code>
          )}
        </dd>
      </div>

      {/* DOCUMENT — the hash that identifies WHICH mandate is in force. Truncated for the eye; the full
          value is present and `user-select: all` (see globals.css) so one tap selects the whole thing to
          copy. A hash you can only half-read is a hash you cannot trust. */}
      <div className="mandate-field">
        <dt>Document</dt>
        <dd {...pr(HOOK.mandateHash)}>
          {member.mandate_hash == null ? (
            <span className="mandate-undisclosed">not disclosed</span>
          ) : (
            <span className="mandate-hash-wrap">
              <code className="mandate-hash" title={member.mandate_hash}>
                {truncateHash(member.mandate_hash)}
              </code>
              <code className="mandate-hash-full" aria-label="full mandate hash, select to copy">
                {member.mandate_hash}
              </code>
            </span>
          )}
        </dd>
      </div>
    </dl>
  );
}
