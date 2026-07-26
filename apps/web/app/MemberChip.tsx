import type { RosterMember } from './roster';
// VALUE import from a client-safe module. roster.ts is server-only — importing a value from
// there pulls node:fs and node:crypto into the browser bundle and breaks `next build`.
import { mandateSummary } from './mandate';
import { HOOK, pr } from './hooks';

// TWO SURFACES, BECAUSE THE DENSITY GRADIENT IS THE POINT.
//
// `MemberChip` is the roster strip: dense, once, at the top — who is here, whose authority
// they carry, and a compact summary of what they may do. Beat 1 of the film reads this, so
// the density is deliberate.
//
// `MemberName` is the transcript: name, colour, shape. Nothing else. The chip used to be
// repeated above every turn, restating affiliation and the full mandate scope on every
// message, which nobody does about a colleague. Removing it is most of this slice.
//
// NEITHER INVENTS A FIELD. An agent absent from the roster renders as a bare name with no
// affiliation and no mandate; a member whose principal is not in config renders no
// affiliation and takes no accent. A surface that can display authority the config did not
// grant is the one thing this component may not become — the same rule as the DECISION card.
// `mandate_label` used to sit in adapters.yaml describing authority nothing enforced; M-3
// deleted it rather than leave a lie-shaped hole, and the summary below is derived from the
// mandate document for exactly that reason.

/** Marker: filled rounded square for an agent, hollow circle for a human. See globals.css. */
function Marker() {
  return <span className="chip-marker" />;
}

/** Accent attribute, or nothing at all. A member with no principal in config borrows no colour. */
function accentAttr(member?: RosterMember): { 'data-accent'?: number } {
  return member?.accent != null ? { 'data-accent': member.accent } : {};
}

/**
 * Roster entry — the dense one.
 *
 * The mandate summary is DERIVED from the mandate document by `mandateSummary`, not written
 * by hand: the words a viewer reads are a function of the array the evaluator checks. A
 * member with no mandate shows no mandate text, never "unrestricted".
 */
export function MemberChip({ member, name }: { member?: RosterMember; name: string }) {
  const isAgent = Boolean(member);
  const summary = member ? mandateSummary(member.scope, member.protected_actions) : null;
  return (
    <span
      className={['chip', isAgent ? 'chip-agent' : 'chip-human'].join(' ')}
      {...pr(HOOK.rosterMember)}
      data-pr-member={member ? member.id : name}
      {...accentAttr(member)}
    >
      <Marker />
      <span className="chip-name" {...pr(HOOK.author)}>
        {member ? member.display_name : name}
      </span>
      {/* Affiliation, as a NAME. `principal:jerry` is an internal identifier and never
          reaches the screen; null renders nothing rather than falling back to the id. */}
      {member?.principal_name && <span className="chip-meta">for {member.principal_name}</span>}
      {summary && member && (
        /* AVAILABLE, NOT SHOUTED. The compact summary is always visible because beat 1
           reads it; the full namespaced scope is one click away rather than permanently on
           screen. `details` rather than a tooltip: it works on tap, it is keyboard
           reachable, and it needs no dependency. */
        <details className="mandate">
          <summary className="chip-mandate" {...pr(HOOK.mandateSummary)}>
            {summary}
          </summary>
          <div className="mandate-detail" {...pr(HOOK.mandateDetail)}>
            <div className="mandate-detail-head">
              {member.display_name}
              {member.principal_name ? ` acts for ${member.principal_name}` : ''}
            </div>
            <ul className="mandate-scope">
              {member.scope?.map((action) => {
                const gated = member.protected_actions?.includes(action) ?? false;
                return (
                  <li key={action}>
                    <code>{action}</code>
                    {gated && <span className="mandate-gated">needs a human signature</span>}
                  </li>
                );
              })}
            </ul>
            {/* Everything here is a field of the mandate document. There is no summary
                sentence, no total, and no "and more" — a disclosure that added a word the
                mandate does not contain would be the same failure as mandate_label. */}
          </div>
        </details>
      )}
    </span>
  );
}

/**
 * Transcript byline — the quiet one.
 *
 * No affiliation, no mandate, no `human` label. The shape says which kind of member this is
 * and the colour says whose authority it carries; both are answered by looking rather than
 * reading, which is what makes it survive a room with four principals.
 */
export function MemberName({ member, name }: { member?: RosterMember; name: string }) {
  const isAgent = Boolean(member);
  return (
    <span
      className={['member', isAgent ? 'member-agent' : 'member-human'].join(' ')}
      data-pr-member={member ? member.id : name}
      {...accentAttr(member)}
    >
      <Marker />
      <span {...pr(HOOK.author)}>{member ? member.display_name : name}</span>
    </span>
  );
}
