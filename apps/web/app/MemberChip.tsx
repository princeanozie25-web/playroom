import type { RosterMember } from './roster';
// VALUE import from a client-safe module. roster.ts is server-only — importing a value from
// there pulls node:fs and node:crypto into the browser bundle and breaks `next build`.
import { mandateSummary } from './mandate';
import { MandateSurface } from './MandateSurface';
import { HOOK, pr } from './hooks';

// TWO SURFACES, BECAUSE THE DENSITY GRADIENT IS THE POINT.
//
// `MemberChip` is the roster strip: dense, once, at the top — who is here, whose authority
// they carry, and a compact summary of what they may do. Beat 1 of the film reads this, so
// the density is deliberate.
//
// `MemberName` is the transcript: name, colour, shape. Nothing else. The chip used to be
// repeated above every turn, restating affiliation and the full mandate scope on every
// message, which nobody does about a colleague. Removing it is most of that slice.
//
// NEITHER INVENTS A FIELD. An agent absent from the roster renders as a bare name with no
// affiliation and no mandate; a member whose principal is not in config renders no
// affiliation and takes no accent. A surface that can display authority the config did not
// grant is the one thing this component may not become — the same rule as the DECISION card.
// `mandate_label` used to sit in adapters.yaml describing authority nothing enforced; M-3
// deleted it rather than leave a lie-shaped hole, and the summary below is derived from the
// mandate document for exactly that reason.
//
// ── THE BINDING IS THE NAME (S-LIVE, owner's ruling) ──
//
// An agent renders as `Claude (Prince)`, not as `Claude` plus a separate `for Prince` clause. It
// finishes what D-2 started: no word doing work the name can do. And it stops being cosmetic the
// moment two agents stream in one room — which is now the primary test — because "whose agent just
// said that" has to be answerable in the byline itself rather than by looking back up at the roster.
//
// The full detail on tap is unchanged: `Claude acts for Prince`, the namespaced scope, and which
// actions need a signature.

/**
 * Which kind of member this is.
 *
 * NOT `Boolean(member)`, and that was a real defect this slice inherited. Humans became roster
 * records in S1.1b, so every human found in the roster — Prince included — rendered with
 * `member-agent` and the agent's marker shape. The claim that identity is human-versus-agent BY
 * SHAPE was quietly false for the member the film shows most, and no test looked at the class name.
 */
function isAgent(member?: RosterMember): boolean {
  return member?.kind === 'agent';
}

/**
 * THE MARKER, NOW WITH A GLYPH INSIDE IT (S-LIVE).
 *
 * Shape and colour still carry the meaning — filled square for an agent, hollow circle for a human,
 * accent for the principal — and the glyph makes the distinction legible to someone who was never
 * told the convention. A non-technical tester on a phone has about thirty seconds to work out that
 * two of the four names in this room are not people.
 *
 * TWO INLINE SVGs. No stock images, no image assets, no licensing, nothing to download. `currentColor`
 * so each glyph inherits the accent the marker already resolves, and `aria-hidden` because the name
 * beside it is the accessible label — a screen reader announcing "robot Claude Prince" is worse than
 * "Claude (Prince)".
 */
function Marker({ member }: { member?: RosterMember }) {
  return (
    <span
      className="chip-marker"
      {...pr(HOOK.memberGlyph)}
      data-pr-kind={member?.kind ?? 'unknown'}
    >
      {isAgent(member) ? (
        // A ROBOT: square head, two eyes, one antenna. Square because the marker is square, so the
        // glyph and the shape say the same thing rather than two different things.
        <svg viewBox="0 0 16 16" className="glyph" aria-hidden="true" focusable="false">
          <path d="M8 1.5v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <rect
            x="3"
            y="4"
            width="10"
            height="8"
            rx="2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
          />
          <circle cx="6.2" cy="8" r="1.1" fill="currentColor" />
          <circle cx="9.8" cy="8" r="1.1" fill="currentColor" />
        </svg>
      ) : (
        // A PERSON: head and shoulders. Round, matching the human marker's circle.
        <svg viewBox="0 0 16 16" className="glyph" aria-hidden="true" focusable="false">
          <circle cx="8" cy="5.4" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path
            d="M2.9 13.6c0-2.6 2.3-4.2 5.1-4.2s5.1 1.6 5.1 4.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      )}
    </span>
  );
}

/** Accent attribute, or nothing at all. A member with no principal in config borrows no colour. */
function accentAttr(member?: RosterMember): { 'data-accent'?: number } {
  return member?.accent != null ? { 'data-accent': member.accent } : {};
}

/**
 * The name as the binding: `Claude (Prince)` for an agent, `Prince` for a person.
 *
 * A human is NOT rendered as `Prince (Prince)`. In this room a human IS their principal, so the
 * parenthetical would be tautology — the same reasoning that kept `for Prince` off human chips in
 * UI2. A missing principal name renders nothing rather than falling back to an identifier.
 */
function boundName(member: RosterMember | undefined, fallback: string): string {
  if (!member) return fallback;
  if (!isAgent(member) || !member.principal_name) return member.display_name;
  return `${member.display_name} (${member.principal_name})`;
}

/**
 * Roster entry — the dense one.
 *
 * The mandate summary is DERIVED from the mandate document by `mandateSummary`, not written
 * by hand: the words a viewer reads are a function of the array the evaluator checks. A
 * member with no mandate shows no mandate text, never "unrestricted".
 */
export function MemberChip({ member, name }: { member?: RosterMember; name: string }) {
  const agent = isAgent(member);
  const summary = member ? mandateSummary(member.scope, member.protected_actions) : null;
  // A MANDATE EXISTS iff it has a hash — that, not a non-empty scope, is what earns the disclosure.
  // claude-code is granted nothing (empty scope, so `summary` is null) yet HAS a mandate with an expiry
  // and a hash; gating on `summary` hid a real mandate. A member with NO mandate (a human) still shows
  // nothing, which is the rule that stays: absent authority is never dressed as anything.
  const hasMandate = !!member && member.mandate_hash != null;
  return (
    <span
      className={['chip', agent ? 'chip-agent' : 'chip-human'].join(' ')}
      {...pr(HOOK.rosterMember)}
      data-pr-member={member ? member.id : name}
      {...accentAttr(member)}
    >
      <Marker member={member} />
      {/* THE BINDING AS THE NAME. This replaced a separate `for Prince` element: one string where
          there were two, and one fewer thing to keep in sync with the record it came from. */}
      <span className="chip-name" {...pr(HOOK.author)}>
        {boundName(member, name)}
      </span>
      {hasMandate && member && (
        /* AVAILABLE, NOT SHOUTED. The compact summary is always visible because beat 1
           reads it; the full mandate is one click away rather than permanently on screen.
           `details` rather than a tooltip: it works on tap, it is keyboard reachable, and it
           needs no dependency. The trigger reads the compact scope summary, or "granted
           nothing" for a mandate that grants nothing — never blank, which would hide it. */
        <details className="mandate">
          <summary className="chip-mandate" {...pr(HOOK.mandateSummary)}>
            {summary ?? 'granted nothing'}
          </summary>
          <div className="mandate-detail" {...pr(HOOK.mandateDetail)}>
            <div className="mandate-detail-head">
              {member.display_name}
              {member.principal_name ? ` acts for ${member.principal_name}` : ''}
            </div>
            {member.scope && member.scope.length > 0 && (
              <ul className="mandate-scope">
                {member.scope.map((action) => {
                  const gated = member.protected_actions?.includes(action) ?? false;
                  return (
                    <li key={action}>
                      <code>{action}</code>
                      {gated && <span className="mandate-gated">needs a human signature</span>}
                    </li>
                  );
                })}
              </ul>
            )}
            {/* The six fields that decide whether the mandate is actually in force. Everything
                here is a field of the mandate document, read-only, in its true position — no
                summary sentence, no total, no "and more". */}
            <MandateSurface member={member} />
          </div>
        </details>
      )}
    </span>
  );
}

/**
 * Transcript byline — the quiet one.
 *
 * No mandate, no `human` label. The shape and glyph say which kind of member this is, the colour
 * says whose authority it carries, and the name now says the binding — which is what makes it
 * survive a room where two agents are talking at once.
 */
export function MemberName({ member, name }: { member?: RosterMember; name: string }) {
  const agent = isAgent(member);
  return (
    <span
      className={['member', agent ? 'member-agent' : 'member-human'].join(' ')}
      data-pr-member={member ? member.id : name}
      {...accentAttr(member)}
    >
      <Marker member={member} />
      <span {...pr(HOOK.author)}>{boundName(member, name)}</span>
    </span>
  );
}
