import { loadPrincipals, loadRoster } from '../../roster';
import { Room } from './Room';

// Server component. The roster is read here — on the server — and handed to the room
// as props, so no YAML parser and no config file reaches the browser. It also keeps
// the read inside the web app's own server layer rather than changing the api: the
// room-state payload from apps/api is untouched by S-UI (see the report; S1.1 is
// where roster metadata should join the payload properly).
export default async function RoomRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Both awaited: the roster is records now, fetched from the API rather than read off the
  // disk. A server component is the right place for that — the browser never makes the call.
  const [roster, principals] = await Promise.all([loadRoster(id), loadPrincipals(id)]);

  // THE CREDENTIAL THIS BROWSER CONNECTS AS (S1.2).
  //
  // Read on the SERVER and handed to the client, because a browser cannot set headers on a
  // WebSocket handshake. It is a member credential — issued with `pnpm tsx
  // scripts/issue-credential.ts prince browser` — and it reaches the page, which means anyone
  // who can read the page can connect as that member. That is the honest limit of a credential
  // without a login, and it is recorded as S13-N3.
  //
  // THIS COMMENT CITED S12-N1 UNTIL S1.3b, which is the room-existence oracle — a different
  // finding, now closed. The second mislabel of the same kind in two slices: a concern documented
  // at the code under a label pointing somewhere else is a concern that is not in the ledger at
  // all, which is what a ledger exists to prevent.
  //
  // Absent rather than defaulted: with no token the socket is refused at the handshake with a
  // typed reason, which is the correct behaviour and visibly different from a room that works.
  const token = process.env.PLAYROOM_WEB_TOKEN ?? '';
  return <Room roomId={id} roster={roster} principals={principals} token={token} />;
}
