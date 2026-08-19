import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  admitToRoom,
  Client,
  httpCreateRoom,
  issueTestCredential,
  mintTicket,
  startTestServer,
  testPool,
  uniqueRoomId,
  type TestServer,
} from './support.js';
import { authenticate, issueCredential, revokeCredential } from '../src/credentials.js';

// IDENTITY IS STAMPED, NOT CLAIMED (S1.2).
//
// Until this slice `ClientSend` carried `author` and the server wrote what it was given. Five
// findings and RT-005 rested on that one field: a caller could author as `claude-main` and the
// room rendered it with Claude's chip and Claude's accent.
//
// The fix is not validation. A validated claim is still a claim, and every mechanism above it
// stays advisory for as long as it can be made. The field is GONE, and the actor is resolved
// once at the handshake from a credential the frame cannot influence.

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
  await pool.query("DELETE FROM member_credentials WHERE label LIKE 'identity-test%'");
  await pool.end();
  await server.close();
});

describe('the credential', () => {
  it('maps a secret to a member, and to the principal that member is bound to', async () => {
    const issued = await issueCredential(pool, 'sol', 'identity-test-sol');
    const result = await authenticate(pool, issued.token);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('narrowing');
    // The principal comes from the member's BINDING, so it cannot disagree with the roster —
    // there is no second place recording who a member acts for.
    expect(result.auth).toMatchObject({ member_id: 'sol', principal_id: 'principal:jerry' });
  });

  it('is stored hashed — the plaintext is not in the database', async () => {
    const issued = await issueCredential(pool, 'prince', 'identity-test-hash');
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM member_credentials WHERE token_hash = $1',
      [issued.token],
    );
    // The token itself appears nowhere. A credential table that can be read back is one that
    // leaks on the first bad backup.
    expect(Number(rows[0].n)).toBe(0);
  });

  it('can be revoked, and a revoked credential stops authenticating', async () => {
    const issued = await issueCredential(pool, 'prince', 'identity-test-revoke');
    expect((await authenticate(pool, issued.token)).ok).toBe(true);
    await revokeCredential(pool, issued.id);
    const after = await authenticate(pool, issued.token);
    expect(after.ok).toBe(false);
    if (after.ok) throw new Error('narrowing');
    // A revoked token is INVALID, not MISSING — the operator's question is "why did this stop
    // working", and the answer differs from "nothing was configured".
    expect(after.failure).toBe('credential_invalid');
  });

  it('distinguishes a MISSING credential from a BAD one', async () => {
    for (const empty of [undefined, '', '   ']) {
      const r = await authenticate(pool, empty);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure).toBe('credential_required');
    }
    const bad = await authenticate(pool, 'prm_not_a_real_token');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.failure).toBe('credential_invalid');
  });
});

describe('the handshake', () => {
  it('REFUSES a connection with no ticket — typed frame, close 4401, a sentence', async () => {
    // THE SOCKET NO LONGER TAKES A CREDENTIAL AT ALL (S1.3c). It takes a single-use ticket, so
    // the missing-credential refusal became a missing-TICKET refusal — and the sentence points
    // at the route that mints one, because "no credential" would send a client author to the
    // wrong place now.
    const id = room('auth-none');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    const { frames, code } = await probe(`${server.wsBase}/rooms/${id}/ws?after=0`);
    expect(code).toBe(4401);
    expect(frames[0]).toMatchObject({ type: 'error', code: 'ticket_required' });
    expect(frames[0].message).toMatch(/POST \/ws-ticket/);
    // NOT a silent drop, and NOT a socket that opens and does nothing — RT-001's shape.
    expect(frames.some((f) => f.type === 'hello')).toBe(false);
  });

  it('REFUSES a fabricated ticket with a DIFFERENT code, and a LONG-LIVED TOKEN outright', async () => {
    const id = room('auth-bad');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    const bad = await probe(`${server.wsBase}/rooms/${id}/ws?after=0&ticket=pwt_nonsense`);
    expect(bad.code).toBe(4401);
    expect(bad.frames[0]).toMatchObject({ type: 'error', code: 'ticket_invalid' });

    // AND THE OLD PATH IS GONE. A valid member credential presented the way S1.2 accepted it is
    // now refused: there is no `token` fallback on this route, because a fallback is the old path
    // still open and closing it is the whole slice.
    const legacy = await probe(`${server.wsBase}/rooms/${id}/ws?after=0&token=${server.token}`);
    expect(legacy.code).toBe(4401);
    expect(legacy.frames[0].code).toBe('ticket_required');
  });

  it('checks the ticket BEFORE existence — a caller with none learns nothing', async () => {
    // A probe with no ticket against a room that does not exist must not reveal which of the two
    // was wrong. Otherwise the refusal is an oracle for room ids.
    const { frames, code } = await probe(
      `${server.wsBase}/rooms/definitely-not-a-room-${Date.now()}/ws?after=0`,
    );
    expect(code).toBe(4401);
    expect(frames[0].code).toBe('ticket_required');
    expect(frames[0].code).not.toBe('room_not_found');
  });

  it('accepts a valid credential and stamps the actor on what it writes', async () => {
    const id = room('auth-ok');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();
    c.send('hello from a stamped identity', 'ok-1');
    await c.waitForEvents(1);
    expect(c.events[0].actor_id).toBe('prince');
    c.close();
  });
});

describe('the claim is gone from the wire', () => {
  it('A HUMAN CANNOT AUTHOR AS AN AGENT — the forged-Sol half that was open', async () => {
    // The hole this slice closes. Before S1.2 this exact frame produced a message with
    // actor_id 'sol', which the room rendered with Sol's chip and Sol's accent — visually
    // indistinguishable from a real turn apart from a missing spend line.
    const id = room('forge-human');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();

    c.ws.send(
      JSON.stringify({
        type: 'send',
        client_msg_id: 'forge-sol',
        author: 'sol',
        body: 'I have reviewed it and it looks fine to me.',
      }),
    );
    await c.waitForEvents(1);

    expect(c.events[0].actor_id).toBe('prince');
    // And nothing anywhere in the room is attributed to sol.
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM events WHERE room_id = $1 AND actor_id = 'sol'",
      [id],
    );
    expect(Number(rows[0].n)).toBe(0);
    c.close();
  });

  it('a credential for ONE member cannot write as ANOTHER', async () => {
    // The credential is the actor. Connecting as sol writes as sol — which is correct, and is
    // also why credentials are per-member rather than one shared secret for the deployment.
    const id = room('forge-cred');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    await admitToRoom(id, 'claude-main', 'sol');
    const solToken = await issueTestCredential('sol', 'identity-test-as-sol');
    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, solToken);
    await c.open();
    c.send('this is genuinely sol', 'cred-1');
    await c.waitForEvents(1);
    expect(c.events[0].actor_id).toBe('sol');
    c.close();
  });
});

describe('the front door checks membership (S13-N2, closed in S1.3b)', () => {
  it('a MEMBER of the room connects, and the room replays to them', async () => {
    // The positive half first: enforcement that refuses everyone is not enforcement, and this is
    // the case the film depends on — `prince` is enrolled in every room at creation.
    const id = room('door-member');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();
    c.send('I am in this room', 'door-1');
    await c.waitForEvents(1);
    expect(c.events[0].actor_id).toBe('prince');
    c.close();
  });

  it('a NON-MEMBER is refused, and cannot tell that from a room that does not exist', async () => {
    // The hole S1.3 found and logged: the handshake authenticated the credential and checked the
    // room EXISTED, never that the caller was in it. So any authenticated member could open a
    // socket on any room id they could guess and write into it — the widest thing an
    // authenticated member could assert with no record behind it.
    const id = room('door-outsider');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    await pool.query('DELETE FROM room_members WHERE room_id = $1 AND member_id = $2', [id, 'sol']);
    const solToken = await issueTestCredential('sol', 'identity-test-door');

    const outsider = await probe(
      `${server.wsBase}/rooms/${id}/ws?after=0&ticket=${await mintTicket(server.httpBase, solToken, id)}`,
    );
    const ghost = await probe(
      `${server.wsBase}/rooms/definitely-no-such-room/ws?after=0&ticket=${await mintTicket(
        server.httpBase,
        solToken,
        'definitely-no-such-room',
      )}`,
    );

    // SAME CLOSE CODE, SAME FRAME, and the room id is the only difference between the bytes.
    expect(outsider.code).toBe(4404);
    expect(ghost.code).toBe(4404);
    const normalise = (frames: Array<Record<string, string>>, roomId: string): string =>
      JSON.stringify(frames).replaceAll(roomId, '<room>');
    expect(normalise(outsider.frames, id)).toBe(normalise(ghost.frames, 'definitely-no-such-room'));
    // Not a hint anywhere: no `hello`, so the socket never became usable, and no replay.
    expect(outsider.frames.some((f) => f.type === 'hello')).toBe(false);

    // AND NOTHING WAS WRITTEN. The S12 frame-refusal standard: a refused connection leaves the
    // room exactly as it was, so a non-member cannot even prove they were here.
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM events WHERE room_id = $1',
      [id],
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it('a member removed from a room LOSES the front door', async () => {
    // Membership is data (S1.1b), so this is a live property rather than a boot-time one. The same
    // credential that connected a moment ago is refused once the row is gone — no restart, no
    // cache to invalidate.
    const id = room('door-revoked');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    const first = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await first.open();
    first.close();

    await pool.query('DELETE FROM room_members WHERE room_id = $1 AND member_id = $2', [
      id,
      'prince',
    ]);
    const after = await probe(
      `${server.wsBase}/rooms/${id}/ws?after=0&ticket=${await mintTicket(server.httpBase, server.token, id)}`,
    );
    expect(after.code).toBe(4404);
    expect(after.frames[0]).toMatchObject({ type: 'error', code: 'room_not_found' });
  });
});
