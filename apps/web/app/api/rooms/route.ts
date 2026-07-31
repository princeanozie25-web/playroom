import { NextResponse } from 'next/server';
import { viewerCredential } from '../../session';

// CREATE A ROOM — WITH THE VIEWER'S CREDENTIAL, NOT THE DEPLOYMENT'S. RT-002's client half.
//
// `POST /rooms` on the api requires a credential as of S1.3c, and the create form is a client
// component: it cannot hold one. So the browser calls this same-origin route, the credential stays in
// the server process, and the api sees a Bearer header — the same shape as the ticket counter next door.
//
// ── WHY THIS ROUTE CHANGED (S-WEB) ─────────────────────────────────────────────────────
//
// It used to read `process.env.PLAYROOM_WEB_TOKEN` directly, so EVERY room was created as `prince`
// regardless of who clicked — a redeemed tester's own session was ignored and the event log recorded
// their room as mine. That is the one thing this product may not do: attribution is the claim, and a
// create is the most durable thing the log holds. Every other BFF route routes through
// `viewerCredential()`, where a redeemed session takes precedence over the deployment token; this one
// now does too. A tester's room is attributed to the tester; prince's own browser still creates as
// prince, because the deployment token IS prince's real credential (not a stand-in for a person).
//
// REFUSE RATHER THAN FALL BACK. `viewerCredential()` returns the session token if one was redeemed, the
// deployment token (which acts as `prince`, a real member) only if not, and `undefined` only when the
// deployment carries NO credential of any kind. That last case is a MISCONFIGURED deployment, not an
// identity to invent — it is refused loudly and never silently downgraded to an assumed owner. It is a
// different failure from "this viewer has not redeemed": that one is not a failure at all here (they
// create as prince), and the api's event log names whichever member actually created the room.

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export async function POST(request: Request): Promise<NextResponse> {
  const credential = await viewerCredential();
  // ABSENT RATHER THAN DEFAULTED — the same decision ws-ticket makes. No credential of any kind means
  // the deployment is misconfigured; it does not mean "assume the owner". Refused, loudly.
  if (!credential) {
    return NextResponse.json(
      { type: 'error', code: 'credential_required', message: 'this deployment has no credential' },
      { status: 500 },
    );
  }

  const body: unknown = await request.json().catch(() => ({}));
  const res = await fetch(`${API_URL}/rooms`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${credential.token}`,
    },
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
