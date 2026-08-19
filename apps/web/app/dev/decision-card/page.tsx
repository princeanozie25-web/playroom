import { notFound } from 'next/navigation';
import { DecisionEvent } from '@playroom/shared';
import { DecisionCard } from '../../DecisionCard';
import type { Principal, RosterMember } from '../../roster';
import { AppBrand } from '../../AppBrand';
import { ThemeToggle } from '../../ThemeToggle';

// DEV-ONLY FIXTURE. Not part of the product and NEVER filmed.
//
// It exists so the card's layout can be iterated without inventing a `decision`
// event inside a real room — which is the thing that must stay impossible. The
// fixture below is built here, in this route, and never reaches the room: the room
// renders a decision only from a `decision` row that arrived over the socket.
//
// In production this route 404s. The guard is the first thing in the component so a
// deployed build cannot serve a fabricated governance artifact under any URL.
export const dynamic = 'force-dynamic';

// Parsed through the real schema, not hand-typed: if the wire contract changes, this
// fixture fails loudly instead of drifting into something the room could never show.
const FIXTURE = DecisionEvent.parse({
  type: 'event',
  seq: 1,
  room_id: 'dev-fixture',
  ts: '2026-07-25T22:00:00.000Z',
  actor_id: 'claude-main',
  event_type: 'decision',
  payload: {
    decision_id: 'dec_fixture',
    subject: 'claude-main',
    // S1.3's two fields. The fixture failed the build the moment they became required, which is
    // exactly what "parsed through the real schema, not hand-typed" was for.
    requested_by: 'prince',
    subject_basis: 'delegated_task',
    principal: 'principal:prince',
    action: 'pr.merge',
    resource: 'repo:playroom/playroom#pr-41',
    arguments_hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    decision: 'CO_SIGN',
    reason_code: 'PROTECTED_ACTION',
    required_signer: 'principal:prince',
    effective_mandate_hash:
      'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    policy_version: 'playroom-policy/1.0',
  },
});

// A fixture must be self-contained. Fetching `/rooms/dev-fixture/members` made this development
// route depend on a real room and deployment credential, so it failed with the same 401 as a stale
// local setup. These values are presentation inputs only; the governance object above remains parsed
// through the real event schema, and the production guard below still makes the route a 404.
const FIXTURE_ROSTER: RosterMember[] = [
  {
    id: 'prince',
    kind: 'human',
    display_name: 'Prince',
    principal: 'principal:prince',
    scope: null,
    protected_actions: null,
    principal_name: null,
    accent: null,
    co_sign: null,
    limits: null,
    policy_version: null,
    expires: null,
    mandate_hash: null,
  },
  {
    id: 'claude-main',
    kind: 'agent',
    display_name: 'Claude',
    principal: 'principal:prince',
    scope: ['pr.review', 'pr.comment', 'pr.merge'],
    protected_actions: ['pr.merge'],
    principal_name: 'Prince',
    accent: 0,
    co_sign: { actions: ['pr.merge'], by: 'principal:prince' },
    limits: {},
    policy_version: 'playroom-policy/1.0',
    expires: null,
    mandate_hash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  },
];

const FIXTURE_PRINCIPALS: Principal[] = [
  { id: 'principal:prince', display_name: 'Prince', accent: 0 },
];

export default async function DecisionCardFixture() {
  if (process.env.NODE_ENV === 'production') notFound();

  return (
    <main className="dev-fixture">
      <header className="dev-fixture__topbar">
        <AppBrand />
        <ThemeToggle showLabel={false} />
      </header>
      <section className="dev-fixture__intro">
        <p>Development fixture</p>
        <h1>Co-sign decision card</h1>
        <span>
          Parsed through the real event schema. Production rooms render this surface only from a
          recorded decision event.
        </span>
      </section>
      <section className="dev-fixture__stage" aria-label="Decision card fixture">
        <DecisionCard
          event={FIXTURE}
          resolution={null}
          signedBy={null}
          roster={FIXTURE_ROSTER}
          principals={FIXTURE_PRINCIPALS}
          viewer="prince"
        />
      </section>
    </main>
  );
}
