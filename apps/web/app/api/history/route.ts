import { NextResponse } from 'next/server';
import { viewerCredential } from '../../session';

// THE HISTORY PROXY — a bounded page of a room's transcript, fetched on the viewer's behalf (S16b).
//
// Same shape and same reason as `ws-ticket`: the browser cannot hold the member credential (it is
// httpOnly, and it should be), so a same-origin route holds it in the web tier's process and
// authenticates to the api. The client calls this to load its recent window on open and to page older
// history on demand, instead of the socket replaying a long room whole.
//
// A GET, because a page is a READ — no state changes, and the browser can cache-bust with the cursor.
// It forwards `before` and `limit` untouched; the api decides the window and the ceiling.

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export async function GET(request: Request): Promise<NextResponse> {
  // THE VIEWER'S OWN CREDENTIAL IF THEY HAVE REDEEMED ONE, the deployment's only if not — the same
  // order as `ws-ticket`, so a page reads as the person reading it and not as me.
  const credential = await viewerCredential();
  if (!credential) {
    return NextResponse.json(
      { type: 'error', code: 'credential_required', message: 'this deployment has no credential' },
      { status: 500 },
    );
  }

  const url = new URL(request.url);
  const roomId = url.searchParams.get('room') ?? '';
  if (!roomId.trim()) {
    return NextResponse.json(
      { type: 'error', code: 'room_not_found', message: 'room is required' },
      { status: 400 },
    );
  }
  // Forward only the two knobs the api understands; the api clamps `limit` and ignores the rest.
  const query = new URLSearchParams();
  const before = url.searchParams.get('before');
  const limit = url.searchParams.get('limit');
  if (before !== null) query.set('before', before);
  if (limit !== null) query.set('limit', limit);

  const res = await fetch(
    `${API_URL}/rooms/${encodeURIComponent(roomId)}/history?${query.toString()}`,
    {
      headers: { authorization: `Bearer ${credential.token}` },
      cache: 'no-store',
    },
  );
  // The api's answer, passed through unchanged including its status — one refusal contract, not two.
  const payload: unknown = await res
    .json()
    .catch(() => ({ type: 'error', code: 'room_not_found', message: 'no history returned' }));
  return NextResponse.json(payload, { status: res.status });
}
