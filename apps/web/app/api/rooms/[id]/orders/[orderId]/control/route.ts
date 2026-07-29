import { NextResponse } from 'next/server';
import { forwardOrderMutation } from '../../../../../../orders';

// PAUSE / RESUME / REVOKE A STANDING ORDER, AS THE VIEWER (S-UI3). The API enforces the direction:
// any human pauses, only the creator resumes or revokes, an agent does none. Those refusals pass
// through unchanged — the button being rendered is a courtesy; the authorisation is the command's.

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; orderId: string }> },
): Promise<NextResponse> {
  const { id, orderId } = await params;
  const body: unknown = await request.json().catch(() => ({}));
  const { status, payload } = await forwardOrderMutation(
    `/rooms/${encodeURIComponent(id)}/orders/${encodeURIComponent(orderId)}/control`,
    'POST',
    body,
  );
  return NextResponse.json(payload, { status });
}
