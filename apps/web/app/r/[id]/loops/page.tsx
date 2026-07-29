import { redirect } from 'next/navigation';
import { loadRoster } from '../../../roster';
import { loadOrders } from '../../../orders';
import { viewerCredential } from '../../../session';
import { LoopsScreen } from './LoopsScreen';

// THE LOOPS SCREEN ROUTE (S-UI3) — a per-room sub-route, read server-side like the room page.
//
// Both the roster and the orders are fetched here, on the server, with the viewer's credential, so no
// token reaches the browser and the read is membership-scoped by the API (a non-member's fetch throws
// and the screen fails to render rather than showing a list it was not entitled to). The orders come
// with the viewer the API resolved from that credential, which is what lets the screen render
// authorisation as truth without a WebSocket to learn "who am I" from.

export default async function LoopsRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // No credential → the join screen, not a broken screen (S-LIVE, the room page's rule).
  if ((await viewerCredential()) === undefined) redirect('/join');

  const [roster, ordersView] = await Promise.all([loadRoster(id), loadOrders(id)]);

  return (
    <LoopsScreen
      roomId={id}
      roster={roster}
      orders={ordersView.orders}
      viewer={ordersView.viewer}
    />
  );
}
