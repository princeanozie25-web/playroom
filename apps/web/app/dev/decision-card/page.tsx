import { notFound } from 'next/navigation';
import { DecisionEvent } from '@playroom/shared';
import { DecisionCard } from '../../DecisionCard';
import { loadPrincipals, loadRoster } from '../../roster';

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

export default async function DecisionCardFixture() {
  if (process.env.NODE_ENV === 'production') notFound();

  return (
    <main className="home">
      <h1>DECISION card — fixture</h1>
      <p>
        Dev-only. This card is built from a fixture in this route, not from a room. A room renders
        one only from a <code>decision</code> event in its log, and nothing emits those yet (S2.1
        decides, S2.2 signs). Never film this page.
      </p>
      <div style={{ marginTop: 24 }}>
        <DecisionCard
          event={FIXTURE}
          roster={await loadRoster(FIXTURE.room_id)}
          principals={await loadPrincipals(FIXTURE.room_id)}
        />
      </div>
    </main>
  );
}
