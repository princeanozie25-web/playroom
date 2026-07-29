import { NextResponse } from 'next/server';
import { forwardOrderMutation } from '../../../../../orders';

// EDIT A STANDING ORDER'S TERMS, AS THE VIEWER (S-UI3). PATCH carries the editable cadence — the dial,
// the cycle cap, the expiry; the API refuses a non-creator, an agent, a terminal order, and an
// out-of-range value, and those refusals pass through unchanged. The wiring is not here because the
// API has no parameter for it (rewiring is revoke-and-recreate).

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; orderId: string }> },
): Promise<NextResponse> {
  const { id, orderId } = await params;
  const body: unknown = await request.json().catch(() => ({}));
  const { status, payload } = await forwardOrderMutation(
    `/rooms/${encodeURIComponent(id)}/orders/${encodeURIComponent(orderId)}`,
    'PATCH',
    body,
  );
  return NextResponse.json(payload, { status });
}
