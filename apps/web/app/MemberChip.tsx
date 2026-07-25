import type { RosterMember } from './roster';

// The member chip. Renders `Claude · speaks for prince · summon-only` from the three
// roster fields and nothing else.
//
// It NEVER invents a field. An agent with no roster entry renders as a bare name
// with no principal and no mandate — a chip that filled those in with a placeholder
// would be the UI asserting a mandate the roster never stated, and a surface that can
// display authority the config did not grant is the one thing this slice may not
// ship. Same rule as the DECISION card: no data, no claim.
//
// Humans and agents are distinguishable without reading the name: agents carry the
// indigo fill and a solid marker, humans are outlined and quiet (see globals.css).

export function MemberChip({
  member,
  name,
  inline = false,
}: {
  /** Roster entry, when the member has one. Agents only, for now. */
  member?: RosterMember;
  /** Fallback display name — used for humans, and for an agent absent from the roster. */
  name: string;
  /** Inline against a turn rather than sitting in the header strip. */
  inline?: boolean;
}) {
  const isAgent = Boolean(member);
  return (
    <span
      className={['chip', isAgent ? 'chip-agent' : 'chip-human', inline ? 'chip-inline' : '']
        .filter(Boolean)
        .join(' ')}
    >
      <span className="chip-marker" />
      <span className="chip-name">{member ? member.display_name : name}</span>
      {member ? (
        <>
          <span className="chip-meta">speaks for {member.principal}</span>
          {/* Descriptive text, not authority — see RosterMember.mandate_label. */}
          <span className="chip-mandate">{member.mandate_label}</span>
        </>
      ) : (
        <span className="chip-meta">human</span>
      )}
    </span>
  );
}
