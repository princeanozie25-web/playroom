import { NextResponse } from 'next/server';
import { viewerCredential } from '../../session';

// THE TICKET COUNTER — where the long-lived credential stops.
//
// S13-N3 had two faces and both came from the same place: the browser needs to authenticate a
// WebSocket handshake, and a browser cannot set headers on one. So S1.2 handed the member
// credential to the client (serialised into the page HTML) and the client put it in the socket URL
// (where it lands in access logs and history).
//
// This route is the exchange. It runs ON THE SERVER, holds the credential in the web tier's
// process, and hands back a ticket worth one socket for thirty seconds. The browser never receives
// anything durable, and nothing durable travels in a URL.
//
// ── WHAT THIS DOES NOT FIX, SAID PLAINLY ──
//
// There is no login, so this route mints a ticket for anyone who can reach the web app. That is
// not a regression — before it, anyone who could reach the web app could read a PERMANENT
// credential out of the page — but it is not authentication of a person either. The credential has
// moved from every reader of the HTML into one server process, and `which human is this` remains
// S04-N2, which per the owner belongs where a second human first exists: pilot onboarding.
//
// A route handler rather than a server action: the client calls it on every connect, including
// every reconnect, and an action would tie a plain fetch to React's form plumbing for nothing.

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export async function POST(request: Request): Promise<NextResponse> {
  // THE VIEWER'S OWN CREDENTIAL IF THEY HAVE REDEEMED ONE, and the deployment's only if not.
  //
  // Order matters more than it looks. `PLAYROOM_WEB_TOKEN` acts as `prince`, so a fallback that
  // applied while a session existed would record a tester's messages and summons as MINE. That is
  // not a degraded experience — it is the audit log lying, and attribution is the product.
  const credential = await viewerCredential();
  // ABSENT RATHER THAN DEFAULTED. With no credential at all the room does not open, loudly,
  // which is the correct behaviour and visibly different from a room that works — the same
  // decision the socket's own refusal makes.
  if (!credential) {
    return NextResponse.json(
      { type: 'error', code: 'credential_required', message: 'this deployment has no credential' },
      { status: 500 },
    );
  }
  const token = credential.token;

  let roomId = '';
  try {
    const body: unknown = await request.json();
    if (typeof body === 'object' && body !== null && 'room_id' in body) {
      const value = (body as { room_id: unknown }).room_id;
      if (typeof value === 'string') roomId = value;
    }
  } catch {
    /* fall through to the 400 below — an unparseable body is a missing room id */
  }
  if (!roomId.trim()) {
    return NextResponse.json(
      { type: 'error', code: 'ticket_required', message: 'room_id is required' },
      { status: 400 },
    );
  }

  const res = await fetch(`${API_URL}/ws-ticket`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ room_id: roomId }),
    cache: 'no-store',
  });

  // The api's answer is passed through unchanged, including its status. A refusal invented here
  // would be a second refusal contract for the same failure, and the client already knows how to
  // read the first one.
  const payload: unknown = await res.json().catch(() => ({
    type: 'error',
    code: 'ticket_required',
    message: 'the api did not answer with a ticket',
  }));
  return NextResponse.json(payload, { status: res.status });
}
