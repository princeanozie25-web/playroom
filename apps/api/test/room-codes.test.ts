import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  httpCreateRoom,
  startTestServer,
  testPool,
  uniqueRoomId,
  type TestServer,
} from './support.js';
import { MintRefused, mintRoomCode, redeemRoomCode } from '../src/room-codes.js';
import { authenticate } from '../src/credentials.js';
import { loadRoomTokens } from '../src/members.js';

// A ROOM CODE IS A WAY TO BE ISSUED A CREDENTIAL, NOT A WAY TO SKIP NEEDING ONE.
//
// That sentence is the design and it is what these tests are for. Redemption ends with an ordinary
// member credential and an ordinary `room_members` row; every request after it walks the identical
// path through the identical checks. If any test here had to reach past the front door to pass, the
// design would be wrong.

const pool = testPool();
const roomId = uniqueRoomId('codes');
const otherRoomId = uniqueRoomId('codes-other');
let server: TestServer;
// The credential the redemption case produces, reused by the front-door case rather than minted
// again: guest-a is permanently spent after it redeems, and weakening that rule to make a test
// convenient would delete the property the rule exists for.
let guestToken = '';

beforeAll(async () => {
  server = await startTestServer();
  expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
  expect((await httpCreateRoom(server.httpBase, otherRoomId, server.token)).status).toBe(201);
});

afterAll(async () => {
  // ── THIS SUITE MUTATES GLOBAL ROWS, SO THE RESTORE IS NOT OPTIONAL ──
  //
  // A redeemed seat is permanently spent and a redeemed principal carries the tester's name — both
  // correct in production and both poison in a shared test database. The first version of this hook
  // used the suite's own pool and ran unguarded; in the FULL run (not in isolation) it failed
  // partway and left `principal:guest-a` named 'Amara', which broke `members.test.ts` two files
  // later. Exactly the cross-file interference `vitest.config.ts` documents.
  //
  // So: a FRESH pool, because this must not depend on the state of one the suite has been using,
  // and try/finally, because a cleanup that only runs when nothing went wrong is a cleanup that
  // runs when it is least needed.
  const cleanup = testPool();
  try {
    // ORDER MATTERS, and it caught me: the guest SENDS A MESSAGE in the front-door case, so
    // `events.actor_member_id` references `guest-a-human`. Deleting the member first violated
    // `events_actor_member_id_fkey` — which is the append-only log refusing to let a member be
    // erased out from under their own acts, i.e. the constraint doing precisely its job. Events
    // first, then the rooms, then the members who acted in them.
    await cleanup.query('DELETE FROM room_codes');
    await cleanup.query("DELETE FROM member_credentials WHERE label LIKE 'room code:%'");
    for (const r of [roomId, otherRoomId]) {
      await cleanup.query('DELETE FROM events WHERE room_id = $1', [r]);
      await cleanup.query('DELETE FROM room_members WHERE room_id = $1', [r]);
      await cleanup.query('DELETE FROM rooms WHERE id = $1', [r]);
    }
    // BY ACTOR, NOT BY ROOM, and self-healing on purpose. Scoping this to the two rooms the suite
    // created was not enough: an earlier aborted run of this file had left guest events in rooms it
    // no longer knows the ids of, and those rows blocked the member delete permanently. A cleanup
    // that only works when the previous run succeeded is a cleanup that needs a cleanup.
    //
    // EVERY TABLE THAT REFERENCES `members`, in FK order — read out of `information_schema` rather
    // than discovered one error at a time. This suite does not currently summon as a guest, so
    // `tasks`, `interrupts` and `ws_tickets` are empty for it today; they are here because the first
    // test that DOES summon would otherwise fail in teardown with a foreign key error and no
    // obvious cause. `routes` is deliberately absent: those belong to the agent, which stays.
    const guest = "LIKE 'guest-%-human'";
    await cleanup.query(`DELETE FROM ws_tickets WHERE member_id ${guest}`);
    await cleanup.query(`DELETE FROM interrupts WHERE raised_by ${guest} OR addressed_to ${guest}`);
    await cleanup.query(`DELETE FROM promotions WHERE approved_by ${guest}`);
    await cleanup.query(
      `DELETE FROM tasks WHERE created_by ${guest} OR origin_member ${guest}
          OR assignee_member_id ${guest}`,
    );
    await cleanup.query(`DELETE FROM events WHERE actor_member_id ${guest}`);
    await cleanup.query(`DELETE FROM room_members WHERE member_id ${guest}`);
    await cleanup.query(`DELETE FROM members WHERE id ${guest}`);
    await cleanup.query(
      "UPDATE principals SET display_name = 'Guest A' WHERE id = 'principal:guest-a'",
    );
    await cleanup.query(
      "UPDATE principals SET display_name = 'Guest B' WHERE id = 'principal:guest-b'",
    );
  } finally {
    await cleanup.end();
    await pool.end().catch(() => {
      /* already ended, or ended under us in the full run — the cleanup above is what mattered */
    });
    await server.close();
  }
});

const mint = (principalId: string, label = 'a tester') =>
  mintRoomCode(pool, {
    roomId,
    principalId,
    label,
    codeHours: 1,
    credentialHours: 2,
    createdBy: 'prince',
  });

describe('minting refuses the seats that are not ours to give', () => {
  it('REFUSES A NON-GUEST PRINCIPAL — the load-bearing check', async () => {
    // A code against `principal:prince` would issue a stranger a credential for a member bound to
    // my principal: my agent, my mandate, my private context store. This is the one refusal in the
    // file whose absence would be a disclosure rather than an inconvenience.
    await expect(mint('principal:prince')).rejects.toMatchObject({
      reason: 'not_a_guest_principal',
    });
    await expect(mint('principal:jerry')).rejects.toMatchObject({
      reason: 'not_a_guest_principal',
    });
  });

  it('refuses a principal that does not exist, and a room that does not exist', async () => {
    await expect(mint('principal:nobody')).rejects.toBeInstanceOf(MintRefused);
    await expect(
      mintRoomCode(pool, {
        roomId: 'no-such-room',
        principalId: 'principal:guest-a',
        label: 'x',
        codeHours: 1,
        credentialHours: 1,
        createdBy: 'prince',
      }),
    ).rejects.toMatchObject({ reason: 'no_such_room' });
  });

  it('refuses a SECOND live code for the same seat — two codes, one identity', async () => {
    // Enforced by a partial unique index rather than by a check in application code, because the
    // check would be a SELECT then an INSERT with nothing in between. Two live codes for one seat
    // is a race for one identity in which the loser was told by a person that they had a code.
    await mint('principal:guest-b', 'first');
    await expect(mint('principal:guest-b', 'second')).rejects.toMatchObject({
      reason: 'principal_already_has_a_live_code',
    });
    await pool.query("DELETE FROM room_codes WHERE principal_id = 'principal:guest-b'");
  });

  it('generates codes a person can read aloud', async () => {
    const { generateCode } = await import('../src/room-codes.js');
    const codes = Array.from({ length: 200 }, () => generateCode());
    for (const c of codes) {
      expect(c).toMatch(/^PLAY-[A-Z2-9]{4}$/);
      // The ambiguous characters, absent by construction. Someone reads these over a phone.
      expect(c.slice(5)).not.toMatch(/[OI1L0U]/);
    }
    // And they are not all the same, which is the only thing that makes the alphabet matter.
    expect(new Set(codes).size).toBeGreaterThan(100);
  });
});

describe('redeeming gives one person one seat', () => {
  it('names the seat, enrols the person AND their agent, and issues an expiring credential', async () => {
    const code = await mint('principal:guest-a', 'Amara (phone test)');
    const redemption = await redeemRoomCode(pool, code.code, 'Amara');

    expect(redemption.member_id).toBe('guest-a-human');
    expect(redemption.display_name).toBe('Amara');
    expect(redemption.room_id).toBe(roomId);
    // THE AGENT THEY NOW HAVE, returned so a welcome screen can say what to tag without guessing.
    expect(redemption.agent_id).toBe('ada');
    expect(redemption.agent_name).toBe('Ada');
    expect(redemption.expires_at, 'a stranger got a credential with no expiry').not.toBeNull();

    // THE SEAT TOOK THE PERSON'S NAME, so the room renders `Ada (Amara)` and nothing in it names
    // an invented human.
    const { rows: principal } = await pool.query<{ display_name: string }>(
      "SELECT display_name FROM principals WHERE id = 'principal:guest-a'",
    );
    expect(principal[0].display_name).toBe('Amara');

    // BOTH ROWS. The agent's enrolment is not a nicety: the summon token table is per-room and
    // built from membership, so without it `@ada` resolves to nobody and the tester's agent is
    // unreachable while appearing to exist.
    const { rows: enrolled } = await pool.query<{ member_id: string }>(
      'SELECT member_id FROM room_members WHERE room_id = $1 ORDER BY member_id',
      [roomId],
    );
    const ids = enrolled.map((r) => r.member_id);
    expect(ids).toContain('guest-a-human');
    expect(ids).toContain('ada');

    // AND THE CREDENTIAL WORKS, through the ordinary path — which is the whole claim.
    guestToken = redemption.token;
    const auth = await authenticate(pool, redemption.token);
    expect(auth.ok).toBe(true);
    if (auth.ok) {
      expect(auth.auth.member_id).toBe('guest-a-human');
      expect(auth.auth.principal_id).toBe('principal:guest-a');
    }
  });

  it("and the tester's agent is tag-resolvable in that room", async () => {
    // The end of the chain the enrolment above exists for. `@ada` must MEAN something in this room.
    await loadRoomTokens(pool, roomId);
    const { summonRuling } = await import('../src/agent.js');
    const ruling = summonRuling({
      type: 'event',
      seq: 1,
      room_id: roomId,
      ts: '2026-07-27T00:00:00.000Z',
      actor_id: 'guest-a-human',
      event_type: 'message',
      payload: { body: '@ada what do you make of this?' },
    });
    expect(ruling.members).toEqual(['ada']);
  });

  it('A SPENT CODE IS SPENT — and the refusal does not say so', async () => {
    // One reason outward. "That code was already used" tells someone holding a guessed string that
    // they guessed a real one, and which seat it was for.
    const code = await mint('principal:guest-b', 'Bo tester');
    await redeemRoomCode(pool, code.code, 'Ola');
    const second = await redeemRoomCode(pool, code.code, 'Someone Else').catch((e) => e);
    expect(second).toMatchObject({ reason: 'no_such_code' });

    const wrong = await redeemRoomCode(pool, 'PLAY-ZZZZ', 'Someone Else').catch((e) => e);
    expect(wrong.reason, 'a spent code is distinguishable from a wrong one').toBe(second.reason);
  });

  it('and a SPENT SEAT cannot be re-minted for a different person', async () => {
    // Because events hold `actor_member_id`. Renaming the principal for a second tester would
    // silently re-attribute every act `guest-b-human` already took to somebody who did not take
    // it — and attribution is the product, not a feature of it.
    await expect(mint('principal:guest-b', 'a different person')).rejects.toMatchObject({
      reason: 'principal_already_redeemed',
    });
  });

  it('refuses an empty name — every act needs somebody to attribute it to', async () => {
    await pool.query("DELETE FROM room_codes WHERE principal_id = 'principal:guest-a'");
    // guest-a is spent from the earlier case, so mint against it is refused; assert the name check
    // directly, which is what this case is about.
    await expect(redeemRoomCode(pool, 'PLAY-ABCD', '   ')).rejects.toMatchObject({
      reason: 'name_required',
    });
  });
});

describe('the front door is unchanged', () => {
  it('a redeemed credential OPENS ITS ROOM and is refused by another, exactly like any member', async () => {
    // THE ASSERTION THAT MATTERS MOST IN THIS FILE, and the one that would fail if a room code were
    // secretly a second way in. A code grants membership of exactly ONE room; the handshake —
    // untouched by this slice — is what enforces that, and a guest holding a real credential for a
    // room they are not in must get precisely what a MISSING room gives (S1.3b).
    expect(guestToken, 'the redemption case did not run first').not.toBe('');

    // Its own room: opens, and the act is attributed to the guest rather than to whoever minted it.
    const mine = new Client(`${server.wsBase}/rooms/${roomId}/ws`, guestToken);
    await mine.open();
    mine.send('hello from a phone', 'guest-door-1');
    await mine.waitForEvents(1);
    expect(mine.events[0].actor_id).toBe('guest-a-human');
    mine.close();

    // A real room the code did not grant, versus a room that does not exist. Asserted on the ROSTER
    // ROUTE, which is where S1.3b's own test asserts the same property — and the reason is a wrong
    // oracle I wrote first: membership is refused AFTER the WebSocket upgrade, so `open()` resolves
    // and "did the socket open" cannot tell an enrolled guest from an outsider. The refusal is
    // observable in what the server then does, not in whether the handshake completed.
    //
    // "Refused" is not the claim. INDISTINGUISHABLE is.
    const outsider = await fetch(`${server.httpBase}/rooms/${otherRoomId}/members`, {
      headers: { authorization: `Bearer ${guestToken}` },
    });
    const ghost = await fetch(`${server.httpBase}/rooms/definitely-not-a-room/members`, {
      headers: { authorization: `Bearer ${guestToken}` },
    });
    expect(outsider.status, 'a guest read a room their code did not grant').toBe(404);
    expect(ghost.status).toBe(404);
    const normalise = (body: string, id: string): string => body.replaceAll(id, '<room>');
    expect(normalise(await outsider.text(), otherRoomId)).toBe(
      normalise(await ghost.text(), 'definitely-not-a-room'),
    );

    // And the room the code DID grant reads normally — so the scoping is a boundary, not a wall.
    const granted = await fetch(`${server.httpBase}/rooms/${roomId}/members`, {
      headers: { authorization: `Bearer ${guestToken}` },
    });
    expect(granted.status).toBe(200);
  });

  it('an unredeemed code is not a credential — it opens nothing', async () => {
    // A code is a claim on a seat, not a bearer token. Presenting one where a credential belongs
    // must fail like any other bad string.
    const auth = await authenticate(pool, 'PLAY-ABCD');
    expect(auth.ok).toBe(false);
    const c = new Client(`${server.wsBase}/rooms/${roomId}/ws`, 'PLAY-ABCD');
    await expect(c.open()).rejects.toThrow(/ticket refused/);
  });
});
