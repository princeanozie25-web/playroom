import { NextResponse } from 'next/server';
import { SESSION_COOKIE, cookieOptions } from '../../session';

// REDEEM A ROOM CODE, SERVER-SIDE, AND PUT THE CREDENTIAL WHERE A SCRIPT CANNOT READ IT.
//
// The tester types a short code and their first name. This exchanges them for a credential at the
// api and stores it in an httpOnly cookie — so the token never enters the page, never enters
// JavaScript, and never appears in a URL. The tester never sees it at all, which is the point: a
// 70-character hex secret pasted on a phone is worse security AND worse for a non-technical person
// than a four-character code.
//
// A ROUTE HANDLER RATHER THAN A SERVER ACTION, matching `ws-ticket`: the response needs to set a
// cookie and return a room id to navigate to, and the form is three fields with no progressive
// enhancement worth the coupling.

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export async function POST(request: Request): Promise<NextResponse> {
  let code = '';
  let displayName = '';
  try {
    const body: unknown = await request.json();
    if (typeof body === 'object' && body !== null) {
      const b = body as { code?: unknown; display_name?: unknown };
      if (typeof b.code === 'string') code = b.code;
      if (typeof b.display_name === 'string') displayName = b.display_name;
    }
  } catch {
    /* falls through to the 400 below */
  }
  if (!code.trim() || !displayName.trim()) {
    return NextResponse.json(
      { error: 'Enter the code you were sent, and your first name.' },
      { status: 400 },
    );
  }

  const res = await fetch(`${API_URL}/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, display_name: displayName }),
    cache: 'no-store',
  });
  const payload = (await res.json().catch(() => null)) as {
    token?: string;
    room_id?: string;
    display_name?: string;
    agent_id?: string;
    agent_name?: string;
    expires_at?: string | null;
    error?: string;
  } | null;

  if (!res.ok || !payload?.token || !payload.room_id) {
    // The api's sentence, passed through. It already says the one thing a tester can act on —
    // check the code with whoever sent it — and inventing a second wording here would give the
    // same failure two voices.
    return NextResponse.json(
      { error: payload?.error ?? 'That did not work. Check the code with whoever sent it.' },
      { status: res.status === 200 ? 502 : res.status },
    );
  }

  // THE TOKEN GOES STRAIGHT INTO THE COOKIE AND IS NOT IN THE RESPONSE BODY. What comes back is
  // only what the welcome screen needs to say: which room, whose name, and which agent is theirs.
  const response = NextResponse.json({
    room_id: payload.room_id,
    display_name: payload.display_name,
    agent_id: payload.agent_id,
    agent_name: payload.agent_name,
  });
  response.cookies.set(SESSION_COOKIE, payload.token, cookieOptions(payload.expires_at ?? null));
  return response;
}
