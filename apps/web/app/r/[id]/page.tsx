import { loadRoster } from '../../roster';
import { Room } from './Room';

// Server component. The roster is read here — on the server — and handed to the room
// as props, so no YAML parser and no config file reaches the browser. It also keeps
// the read inside the web app's own server layer rather than changing the api: the
// room-state payload from apps/api is untouched by S-UI (see the report; S1.1 is
// where roster metadata should join the payload properly).
export default async function RoomRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Room roomId={id} roster={loadRoster()} />;
}
