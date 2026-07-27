import { NextResponse } from 'next/server';

// CREATE A ROOM, WITH THE WEB TIER'S CREDENTIAL — RT-002's client half.
//
// `POST /rooms` on the api requires a credential as of S1.3c, and the create form is a client
// component: it cannot hold one. Same shape as the ticket counter next door — the browser calls
// this same-origin route, the credential stays in the server process, and the api sees a
// Bearer header.
//
// THIS REPLACES A REWRITE. `next.config.mjs` proxied `/rooms` straight through to the api so the
// browser could POST same-origin and avoid a CORS preflight; a rewrite cannot add a header, so it
// had to become a route handler the moment the api asked for one.
//
// The honest limit is the same one the ticket route carries: with no login, anyone who can reach
// the web app can create a room as the web tier's member. That is not a regression — before this
// anyone who could reach the API could create one as nobody at all — and it is not authorisation.
// A room created this way is created BY a real member and is enrolled to them, which is what makes
// it reachable and auditable at all.

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export async function POST(request: Request): Promise<NextResponse> {
  const token = process.env.PLAYROOM_WEB_TOKEN ?? '';
  if (!token) {
    return NextResponse.json(
      { type: 'error', code: 'credential_required', message: 'this deployment has no credential' },
      { status: 500 },
    );
  }

  const body: unknown = await request.json().catch(() => ({}));
  const res = await fetch(`${API_URL}/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body ?? {}),
    cache: 'no-store',
  });

  // Passed through unchanged, status included. A refusal invented here would be a second refusal
  // contract for the same failure.
  const payload: unknown = await res
    .json()
    .catch(() => ({ type: 'error', code: 'room_not_created', message: 'the api did not answer' }));
  return NextResponse.json(payload, { status: res.status });
}
