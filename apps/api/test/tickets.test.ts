import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  Client,
  httpCreateRoom,
  issueTestCredential,
  mintTicket,
  startTestServer,
  testPool,
  uniqueRoomId,
  type TestServer,
} from './support.js';
import { consumeTicket, issueTicket, ticketCount, TICKET_TTL_SECONDS } from '../src/tickets.js';

// THE SOCKET STOPS CARRYING A LONG-LIVED CREDENTIAL (S13-N3).
//
// A browser cannot set headers on a WebSocket handshake, so S1.2 put the member credential in the
// query string — where it lands in any access log and in browser history — and the page handed the
// same credential to a client component as a prop, so it was serialised into the HTML. Two places
// a long-lived secret must not be, and neither was fixable by moving it.
//
// A ticket makes both harmless instead of hidden: worth one socket, one member, one room, thirty
// seconds. What is asserted here is the property that a signed token could not have given —
// SINGLE USE — plus expiry, fabrication and room binding, all four refused identically.

const pool = testPool();
let server: TestServer;
const rooms: string[] = [];

function room(prefix: string): string {
  const id = uniqueRoomId(prefix);
  rooms.push(id);
  return id;
}

/** Connect raw, so a refusal can be observed rather than thrown away by a helper. */
function probe(url: string): Promise<{ frames: Array<Record<string, string>>; code: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const frames: Array<Record<string, string>> = [];
    ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
    ws.on('close', (code) => resolve({ frames, code }));
    ws.on('error', () => {
      /* a refused socket may error on close; the close handler resolves */
    });
    setTimeout(() => reject(new Error('socket neither opened nor closed within 10s')), 10_000);
  });
}

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  for (const id of rooms) {
    await pool.query('DELETE FROM events WHERE room_id = $1', [id]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [id]);
  }
  await pool.query("DELETE FROM member_credentials WHERE label LIKE 'ticket-test%'");
  await pool.end();
  await server.close();
});

describe('POST /ws-ticket', () => {
  it('requires a credential, and refuses a token in the query string', async () => {
    const id = room('tkt-auth');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);

    const none = await fetch(`${server.httpBase}/ws-ticket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room_id: id }),
    });
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ code: 'credential_required' });

    // The route that exists to get a credential out of a URL does not accept one in a URL.
    const inUrl = await fetch(`${server.httpBase}/ws-ticket?token=${server.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room_id: id }),
    });
    expect(inUrl.status).toBe(401);
  });

  it('mints a ticket bound to the member and the room, with a seconds-long life', async () => {
    const id = room('tkt-mint');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    const res = await fetch(`${server.httpBase}/ws-ticket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ room_id: id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticket: string; expires_at: string };
    expect(body.ticket).toMatch(/^pwt_[0-9a-f]{64}$/);

    // SECONDS, not minutes. The number is doing work: a minute stops being "expired before a
    // human could copy it out of a log" and starts being "probably still good".
    const ttlMs = new Date(body.expires_at).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(TICKET_TTL_SECONDS * 1000 + 2000);

    // AND THE PLAINTEXT IS NOT IN THE DATABASE. Thirty seconds is short and it is not zero; a
    // leaked table read would otherwise hand over every ticket in flight.
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM ws_tickets WHERE ticket_hash = $1',
      [body.ticket],
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it('ASKS NO AUTHORISATION QUESTION — a ticket is issued for a room the member cannot join', async () => {
    // Deliberate, and it is the reason the route is safe to leave this open: if issuing checked
    // membership, it would answer "does that room exist and am I in it" — the oracle S1.3b closed,
    // rebuilt one route over. The handshake is the single place that decides, and it refuses this
    // ticket at the door identically to a room that does not exist.
    const solToken = await issueTestCredential('sol', 'ticket-test-sol');
    const ticket = await mintTicket(server.httpBase, solToken, 'a-room-that-does-not-exist');
    expect(ticket).toMatch(/^pwt_/);

    const refused = await probe(
      `${server.wsBase}/rooms/a-room-that-does-not-exist/ws?after=0&ticket=${ticket}`,
    );
    expect(refused.code).toBe(4404);
    expect(refused.frames[0]).toMatchObject({ code: 'room_not_found' });
  });
});

describe('a ticket is spent once', () => {
  it('the SECOND handshake with the same ticket is refused', async () => {
    // The property a signed ticket could not have given. Expiry alone leaves a thirty-second
    // replay window on every connect; single use closes it, and single use needs state.
    const id = room('tkt-reuse');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    const ticket = await mintTicket(server.httpBase, server.token, id);

    const first = new WebSocket(`${server.wsBase}/rooms/${id}/ws?after=0&ticket=${ticket}`);
    await new Promise<void>((resolve, reject) => {
      first.once('open', () => resolve());
      first.once('error', reject);
    });
    // Wait for `hello`, which is proof the handshake completed rather than merely connected.
    await new Promise<void>((resolve) => first.once('message', () => resolve()));
    first.close();

    const second = await probe(`${server.wsBase}/rooms/${id}/ws?after=0&ticket=${ticket}`);
    expect(second.code).toBe(4401);
    expect(second.frames[0]).toMatchObject({ code: 'ticket_invalid' });
  });

  it('two concurrent handshakes with one ticket: exactly ONE wins', async () => {
    // The race an `if` cannot survive, and the reason consumption is an UPDATE with
    // `consumed_at IS NULL` in the WHERE clause rather than a read followed by a write. Same
    // shape as the replayed summon migrations 005 and 006 exist to refuse.
    const id = room('tkt-race');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    const ticket = await mintTicket(server.httpBase, server.token, id);

    // NOT via `probe`: the WINNER never closes, so waiting for two closes would hang. Both
    // sockets are opened, watched for a bounded window, then closed — and the assertion is that
    // exactly one saw `hello` and exactly one was refused.
    const url = `${server.wsBase}/rooms/${id}/ws?after=0&ticket=${ticket}`;
    const sockets = [new WebSocket(url), new WebSocket(url)];
    const frames: Array<Array<Record<string, string>>> = [[], []];
    sockets.forEach((ws, i) => ws.on('message', (d) => frames[i].push(JSON.parse(d.toString()))));
    sockets.forEach((ws) => ws.on('error', () => {}));
    await new Promise((r) => setTimeout(r, 2000));
    sockets.forEach((ws) => ws.close());

    const flat = frames.flat();
    expect(flat.filter((f) => f.type === 'hello')).toHaveLength(1);
    expect(flat.filter((f) => f.code === 'ticket_invalid')).toHaveLength(1);
  });

  it('a ticket for ANOTHER room is refused, and spent anyway', async () => {
    // Spent, not returned. Handing it back would make one ticket probeable across room ids until
    // it expired — a thirty-second oracle, which is smaller than the one S1.3b closed and still
    // one.
    const a = room('tkt-room-a');
    const b = room('tkt-room-b');
    for (const id of [a, b])
      expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    const ticket = await mintTicket(server.httpBase, server.token, a);

    const wrongDoor = await probe(`${server.wsBase}/rooms/${b}/ws?after=0&ticket=${ticket}`);
    expect(wrongDoor.frames[0]).toMatchObject({ code: 'ticket_invalid' });

    const rightDoorLater = await probe(`${server.wsBase}/rooms/${a}/ws?after=0&ticket=${ticket}`);
    expect(rightDoorLater.frames[0]).toMatchObject({ code: 'ticket_invalid' });
  });

  it('an EXPIRED ticket is refused, and looks like every other refusal', async () => {
    // Expiry is asserted at the unit, by writing the row with a past expiry — the alternative is a
    // test that sleeps for thirty seconds, which is a test nobody runs twice.
    const id = room('tkt-expired');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    const issued = await issueTicket(pool, 'prince', id);
    await pool.query("UPDATE ws_tickets SET expires_at = now() - interval '1 second'");

    const spent = await consumeTicket(pool, issued.ticket, id);
    expect(spent.ok).toBe(false);
    if (spent.ok) throw new Error('narrowing');
    expect(spent.failure).toBe('expired');

    // And at the door it is the same answer as a fabricated one — the four reasons collapse to
    // one refusal, because a refusal that diagnoses is a refusal that can be probed.
    const expired = await probe(`${server.wsBase}/rooms/${id}/ws?after=0&ticket=${issued.ticket}`);
    const fabricated = await probe(`${server.wsBase}/rooms/${id}/ws?after=0&ticket=pwt_invented`);
    expect(expired.code).toBe(fabricated.code);
    expect(JSON.stringify(expired.frames)).toBe(JSON.stringify(fabricated.frames));
  });

  it('the four failures are distinguished IN THE FUNCTION, so the log can name them', async () => {
    // One answer outward, four inward. The operator has logs; the caller has a closed socket.
    const id = room('tkt-reasons');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);

    const missing = await consumeTicket(pool, undefined, id);
    const unknown = await consumeTicket(pool, 'pwt_never_existed', id);
    const once = await issueTicket(pool, 'prince', id);
    expect((await consumeTicket(pool, once.ticket, id)).ok).toBe(true);
    const consumed = await consumeTicket(pool, once.ticket, id);
    const elsewhere = await issueTicket(pool, 'prince', id);
    const wrongRoom = await consumeTicket(pool, elsewhere.ticket, 'some-other-room');

    expect([missing, unknown, consumed, wrongRoom].map((r) => (r.ok ? 'ok' : r.failure))).toEqual([
      'missing',
      'unknown',
      'consumed',
      'wrong_room',
    ]);
  });
});

describe('the tickets table stays bounded (S12-N3 measured, not assumed)', () => {
  it('sweeps rows that have been dead long enough, on issue', async () => {
    // A table written on every connect grows faster than the credentials table that reached 479
    // rows unnoticed. The sweep runs inside `issueTicket` — no scheduler, no second mechanism —
    // and the assertion is a measurement rather than a comment saying it happens.
    const id = room('tkt-sweep');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);

    for (let i = 0; i < 5; i += 1) await issueTicket(pool, 'prince', id);
    const withLive = await ticketCount(pool);
    expect(withLive).toBeGreaterThanOrEqual(5);

    // Age everything past the audit window, then issue once more: the sweep takes the dead rows
    // and leaves the one just minted.
    await pool.query("UPDATE ws_tickets SET expires_at = now() - interval '10 minutes'");
    await issueTicket(pool, 'prince', id);
    expect(await ticketCount(pool)).toBe(1);
  });

  it('a live ticket is NOT swept — the window is an audit window, not a deletion policy', async () => {
    const id = room('tkt-keep');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    const keep = await issueTicket(pool, 'prince', id);
    await issueTicket(pool, 'prince', id); // triggers a sweep
    expect((await consumeTicket(pool, keep.ticket, id)).ok).toBe(true);
  });
});

describe('the client walks the whole path', () => {
  it('mints a ticket, connects, and the room works exactly as before', async () => {
    // The end-to-end shape every other suite now uses: credential → ticket → socket. Nothing in
    // the room changed, which is the point of calling this plumbing.
    const id = room('tkt-e2e');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();
    c.send('through the ticket path', 'tkt-1');
    await c.waitForEvents(1);
    expect(c.events[0].actor_id).toBe('prince');
    c.close();
  });
});
