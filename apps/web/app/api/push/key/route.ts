import { NextResponse } from 'next/server';
import { viewerCredential } from '../../../session';

// A PUSH BFF ROUTE (S-PUSH). The same shape every other BFF route has: the browser cannot hold a
// credential, so it calls same-origin and the credential stays in the server process. The api decides
// WHOSE subscription this is from that credential — this route never names a principal, because it
// has no way to know one and no business choosing one.

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export async function GET(_request: Request): Promise<NextResponse> {
  const credential = await viewerCredential();
  if (!credential) {
    return NextResponse.json(
      { type: 'error', code: 'credential_required', message: 'this deployment has no credential' },
      { status: 500 },
    );
  }
  const res = await fetch(`${API_URL}/push/key`, {
    headers: { authorization: `Bearer ${credential.token}` },
  });
  const payload: unknown = await res.json().catch(() => ({}));
  return NextResponse.json(payload, { status: res.status });
}
