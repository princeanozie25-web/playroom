import { redirect } from 'next/navigation';
import { loadPrincipals, loadRoster } from '../../roster';
import { viewerCredential } from '../../session';
import { Room } from './Room';

// Server component. The roster is read here — on the server — and handed to the room
// as props, so no YAML parser and no config file reaches the browser. It also keeps
// the read inside the web app's own server layer rather than changing the api: the
// room-state payload from apps/api is untouched by S-UI (see the report; S1.1 is
// where roster metadata should join the payload properly).
export default async function RoomRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // NO CREDENTIAL AT ALL → THE JOIN SCREEN, NOT A BROKEN ROOM (S-LIVE).
  //
  // Without this, a stranger opening a shared link gets the room shell, an empty transcript and a
  // connection badge cycling `reconnecting` forever — every part working correctly and nothing on
  // screen explaining that they were never let in. A redirect is the difference between a refusal
  // and a malfunction, which is the distinction this project keeps insisting on.
  //
  // It checks only for the PRESENCE of a credential. Whether it is any good is the front door's
  // business, unchanged: a redeemed guest who then asks for a room their code did not grant still
  // gets exactly what a missing room gives.
  if ((await viewerCredential()) === undefined) redirect('/join');

  // Both awaited: the roster is records now, fetched from the API rather than read off the
  // disk. A server component is the right place for that — the browser never makes the call.
  const [roster, principals] = await Promise.all([loadRoster(id), loadPrincipals(id)]);

  // NO CREDENTIAL REACHES THIS PAGE (S1.3c).
  //
  // It used to: the token was read here and handed to `Room` as a prop, which serialised it into
  // the HTML — so anyone who could read the page could connect as that member, permanently. That
  // was S13-N3's second face, and it is closed by the client asking `POST /api/ws-ticket` for a
  // thirty-second single-use ticket instead. The credential stays in the web tier's process.
  //
  // The roster fetch above still uses it, and correctly: that call is made on the server.
  return <Room roomId={id} roster={roster} principals={principals} />;
}
