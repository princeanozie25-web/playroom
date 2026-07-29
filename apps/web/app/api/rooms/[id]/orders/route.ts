import { NextResponse } from 'next/server';
import { forwardOrderMutation } from '../../../../orders';

// CREATE A STANDING ORDER, AS THE VIEWER — the loops form's client half (S-UI3).
//
// The form is a client component and cannot hold a credential; this same-origin route holds it in the
// server process and hands the API a Bearer, exactly like app/api/rooms. It forwards the VIEWER'S
// credential, not the deployment's, because the API enforces human-only creation against the acting
// member — proxying as the wrong member would ask the authorisation question about the wrong person.
// The API's status and body pass through untouched: the human-only refusal is the API's, not invented
// here.

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const body: unknown = await request.json().catch(() => ({}));
  const { status, payload } = await forwardOrderMutation(
    `/rooms/${encodeURIComponent(id)}/orders`,
    'POST',
    body,
  );
  return NextResponse.json(payload, { status });
}
