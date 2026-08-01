'use client';

import type { RosterMember } from './roster';
import { Panel } from './Panel';
import { HOOK, pr } from './hooks';

// THREE LINES, ONE DISMISS, NO TOUR (S-LIVE).
//
// What this room is, who is in it, and what to try. It shows once — on the redirect straight out of
// redemption, which carries `?welcome=1` — and never again unless somebody asks for it.
//
// NO COACH MARKS AND NO TOUR FRAMEWORK. A dependency that points at moving targets is a dependency
// that rots the first time the roster wraps differently, and S06-N1 is what silent selector rot costs
// here. One static panel has nothing to point at and nothing to get wrong.
//
// NO GITHUB VOCABULARY. Not repository, not pull request, not branch, not commit. The merge step is
// the OPTIONAL second thing to try and it is described as what a tester will see happen — the room
// says no and names a human — rather than as the operation being refused.
//
// THE MEMBERS ARE READ FROM THE ROSTER, never written here. A welcome screen that names an agent the
// room does not have is a welcome screen that lies on its first sentence, and this room's membership
// changes every time somebody redeems a code.

export function Welcome({
  roster,
  viewer,
  onDismiss,
}: {
  roster: RosterMember[];
  /** The member id this browser is connected as, so the screen can name THEIR agent. */
  viewer: string | null;
  onDismiss: () => void;
}) {
  const agents = roster.filter((m) => m.kind === 'agent');
  const me = roster.find((m) => m.id === viewer);
  // THE VIEWER'S OWN AGENT: the one bound to the same principal they are. Named first, because
  // "tag your agent" is meaningless if a tester has to work out which of four is theirs.
  const mine = me ? agents.find((a) => a.principal === me.principal) : undefined;
  const tagTarget = mine ?? agents[0];

  // Dismissal is the PARENT's (Room flips `showWelcome` and this unmounts through PanelPresence,
  // which is what lets the exit play — SHELL-B3). The old internal `closing` state returned null in
  // the same tick, which would have removed the content before any exit could run; with presence at
  // the conditional site it was dead code wearing a job.

  return (
    <Panel className="welcome" hook={HOOK.welcome} role="dialog" aria-label="Welcome">
      <p className="welcome-line">
        <strong>This is a shared room.</strong> The people here have their own AI assistants, and
        everyone can see everything that happens.
      </p>
      <p className="welcome-line">
        {/* WHO IS HERE, from the roster. `Ada (Amara)` reads as a name, which is the point of the
            binding being the name — no sentence has to explain the ownership. */}
        <strong>Who is here:</strong>{' '}
        {agents.map((a, i) => (
          <span key={a.id}>
            {i > 0 ? ', ' : ''}
            {a.principal_name ? `${a.display_name} (${a.principal_name})` : a.display_name}
          </span>
        ))}
        {mine ? ` — ${mine.display_name} is yours.` : '.'}
      </p>
      <p className="welcome-line">
        <strong>Try this:</strong> type{' '}
        <code className="welcome-code">
          @{tagTarget ? tagTarget.display_name.toLowerCase() : 'name'}
        </code>{' '}
        and a question. Only the assistant you name will answer.
      </p>
      <p className="welcome-line welcome-optional">
        <strong>Then, if you like:</strong> ask it to merge something. It will refuse, out loud, and
        name the person whose signature it would need — including when that person is you.
      </p>
      <button
        className="welcome-dismiss"
        {...pr(HOOK.welcomeDismiss)}
        type="button"
        onClick={onDismiss}
      >
        Got it
      </button>
    </Panel>
  );
}
