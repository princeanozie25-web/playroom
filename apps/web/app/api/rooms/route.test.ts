import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ═══ S-WEB / WEB-1 — room creation carries the VIEWER'S credential, asserted as a MECHANISM ═══
//
// The bug: this route read the deployment token directly, so a redeemed tester's created room was
// attributed to `prince`. The fix routes through viewerCredential() (session wins). These tests assert
// WHICH token the route forwards and, on refusal, WHICH named rule fired — never mere absence of a room
// (a room can be absent because the guard refused OR because creation simply broke; those must not read
// alike). The session module is mocked so no real credential is ever involved.

vi.mock('../../session', () => ({ viewerCredential: vi.fn() }));
import { viewerCredential } from '../../session';
import { POST } from './route';

const mockCred = vi.mocked(viewerCredential);

function post(body: unknown): Request {
  return new Request('http://localhost/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function bearerOf(spy: { mock: { calls: unknown[][] } }): string {
  const init = spy.mock.calls[0]?.[1] as RequestInit;
  return (init.headers as Record<string, string>).authorization;
}

describe('room creation forwards the viewer credential, never the deployment token as a person', () => {
  beforeEach(() => mockCred.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('a REDEEMED SESSION wins — its token is forwarded, so the api attributes the room to the tester', async () => {
    mockCred.mockResolvedValue({ token: 'SESSION-tester-token', source: 'session' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'room-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await POST(post({ title: 'a tester room' }));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // The MECHANISM: the tester's own token is the Bearer, NOT the deployment token. Attribution to the
    // tester is the api's job once it sees this credential; the route's job is to send the right one.
    expect(bearerOf(fetchSpy)).toBe('Bearer SESSION-tester-token');
    expect(res.status).toBe(200);
  });

  it('no credential of any kind is REFUSED by the named rule `credential_required`, and the api is never called', async () => {
    mockCred.mockResolvedValue(undefined);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await POST(post({ title: 'x' }));
    // Asserted by REASON, not by absence: the named rule refused BEFORE the api, so this cannot be
    // confused with a creation that merely broke downstream.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
    const payload = (await res.json()) as { code?: string };
    expect(payload.code).toBe('credential_required');
  });

  it('the deployment token remains a valid credential — prince (no session) is NOT locked out', async () => {
    // The STOP-gate property, as a test: closing the attribution gap must not make creation unreachable
    // for the owner, whose browser holds the deployment token and no session.
    mockCred.mockResolvedValue({ token: 'DEPLOYMENT-prince-token', source: 'deployment' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'room-2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await POST(post({}));
    expect(bearerOf(fetchSpy)).toBe('Bearer DEPLOYMENT-prince-token');
    expect(res.status).toBe(200);
  });
});
