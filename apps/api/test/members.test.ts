import { afterAll, describe, expect, it } from 'vitest';
import {
  Client,
  admitToRoom,
  httpCreateRoom,
  issueTestCredential,
  startTestServer,
  testPool,
  type TestServer,
} from './support.js';

// The non-creator members a full room used to get by blanket enrolment (ADR-009). Creation now enrols only
// the creator, so these roster tests admit them explicitly — the same rows a room code or the `admit`
// command would write — and the reads then follow the membership the way the product does.
const NON_CREATOR_MEMBERS = ['claude-audit', 'claude-code', 'claude-main', 'jerry', 'sol'];
import { listMembers, listRoomMembers, loadRoomTokens } from '../src/members.js';
import { mandateFor } from '../src/mandates.js';

// THE ROSTER, AS RECORDS AND AS THE ROOM SEES IT.
//
// Two things are asserted, and the second matters more than it looks:
//
//   1. `listMembers` returns what the room needs, from the database.
//   2. WHAT IT RETURNS IS WHAT THE ROOM SHOWED BEFORE THE MOVE. S1.1a changed where the
//      roster comes from and must change nothing a viewer can see. "Same two members, same
//      affiliations, same accents" is the whole exit criterion for the change, and it is the
//      kind of thing that is easy to break and hard to notice — an ordinal off by one
//      recolours the room, a missing join drops an affiliation.

const pool = testPool();
let server: TestServer;

afterAll(async () => {
  await pool.end();
  if (server) await server.close();
});

describe('listMembers', () => {
  it('returns the agents exactly as they rendered before members were records', async () => {
    // `prince` joined the records in S1.1b as a HUMAN member, so the full list is no longer
    // agents-only. The agents' fields are what the roster strip draws and must not move.
    const members = (await listMembers(pool)).filter((m) => m.kind === 'agent');
    expect(members).toEqual([
      // ── THE BRIEF-WRITER (AUDIT-FABLE, migration 030) ──────────────────────────────
      //
      // First within principal:prince because the tiebreak is the member id and 'claude-audit' sorts
      // before 'claude-code'. It exists to hold ITS OWN interrupt budget: a standing order's stop
      // interrupts are charged to its action member, so a long loop sharing a member with the rest of
      // the room goes silent on a budget it did not spend.
      //
      // ITS AUTHORITY IS PINNED EMPTY HERE, deliberately, for the same reason claude-code's was
      // pinned before SCC-2 widened it: a member that writes briefs needs no governed action, and a
      // later widening should have to delete this expectation rather than slip past it.
      {
        id: 'claude-audit',
        kind: 'agent',
        display_name: 'Claude Audit',
        principal_id: 'principal:prince',
        principal_name: 'Prince',
        principal_ordinal: 0,
        adapter_id: 'claude-audit',
        scope: [],
        protected_actions: [],
        co_sign: { actions: [], by: 'principal' },
        limits: { interrupts_per_day: 6 },
        policy_version: 'playroom-policy/1.0',
        expires: '2026-11-30T00:00:00Z',
        mandate_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
      // ── THE CONNECTED MEMBER (SCC-2) ───────────────────────────────────────────────
      //
      // Ordinal 0 (principal:prince) like claude-main, and ordered before it because the tiebreak
      // within a principal is the member id and 'claude-code' < 'claude-main'. Its scope was EMPTY until
      // SCC-2, which transcribed Prince's ruling: it may open/review/comment, and pr.merge/deploy are in
      // scope AND protected — co-signed by its principal. Its real WORK still happens outside the fabric
      // (RT-005); the mandate governs its REQUESTS through the door, never its workspace. These values are
      // pinned so a later NON-owner change to CC's authority fails here — the same reason the empty scope
      // was pinned before it.
      {
        id: 'claude-code',
        kind: 'agent',
        display_name: 'Claude Code',
        principal_id: 'principal:prince',
        principal_name: 'Prince',
        principal_ordinal: 0,
        adapter_id: 'claude-code',
        scope: ['pr.open', 'pr.review', 'pr.comment', 'pr.merge', 'deploy'],
        protected_actions: ['pr.merge', 'deploy'],
        co_sign: { actions: ['pr.merge', 'deploy'], by: 'principal' },
        limits: { interrupts_per_day: 6 },
        policy_version: 'playroom-policy/1.0',
        expires: '2026-11-30T00:00:00Z',
        mandate_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
      {
        id: 'claude-main',
        kind: 'agent',
        display_name: 'Claude',
        principal_id: 'principal:prince',
        principal_name: 'Prince',
        principal_ordinal: 0,
        adapter_id: 'claude-main',
        // `summon.initiate` granted in S1.8 — the one agent that may initiate a summon; the others
        // (sol, ada, bo) are default-closed, which is what makes this enumeration worth pinning.
        scope: ['pr.review', 'pr.comment', 'pr.merge', 'summon.initiate'],
        protected_actions: ['pr.merge', 'deploy'],
        co_sign: { actions: ['pr.merge', 'deploy'], by: 'principal' },
        limits: { interrupts_per_day: 6, postage_per_day: 200 },
        policy_version: 'playroom-policy/1.0',
        expires: '2026-11-30T00:00:00Z',
        mandate_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
      {
        id: 'sol',
        kind: 'agent',
        display_name: 'Sol',
        principal_id: 'principal:jerry',
        principal_name: 'Jerry',
        principal_ordinal: 1,
        adapter_id: 'sol',
        scope: ['pr.review', 'pr.comment'],
        protected_actions: ['pr.merge', 'deploy'],
        co_sign: { actions: ['pr.merge', 'deploy'], by: 'principal' },
        limits: { interrupts_per_day: 6, postage_per_day: 200 },
        policy_version: 'playroom-policy/1.0',
        expires: '2026-11-30T00:00:00Z',
        mandate_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
      // ── THE TWO GUEST AGENTS, ADDED ON PURPOSE IN S-LIVE ────────────────────────────
      //
      // This list is UPDATED rather than relaxed, and that is the S1.1c ruling being honoured:
      // an enumeration is what catches a roster changing by ACCIDENT, so replacing it with
      // "there are some agents" would delete the check to accommodate a deliberate change.
      // Ordinals 2 and 3 exhaust the four-hue accent palette — see migration 017.
      //
      // `principal_name` IS OMITTED FOR THESE TWO, AND ONLY THESE TWO. A guest principal's display
      // name is USER DATA: redemption replaces it with the tester's own name, which is the whole
      // point of a seat. Pinning it here would assert that no guest has ever redeemed, which is not
      // an invariant of the roster — it is a fact about the database's current occupancy, and it
      // made this test fail two files after `room-codes.test.ts` renamed a seat. Claude's and Sol's
      // names stay pinned because those are fixed.
      {
        id: 'ada',
        kind: 'agent',
        display_name: 'Ada',
        principal_id: 'principal:guest-a',
        principal_name: expect.any(String),
        principal_ordinal: 2,
        adapter_id: 'ada',
        scope: ['pr.review', 'pr.comment', 'pr.merge'],
        protected_actions: ['pr.merge', 'deploy'],
        co_sign: { actions: ['pr.merge', 'deploy'], by: 'principal' },
        limits: { interrupts_per_day: 6, postage_per_day: 200 },
        policy_version: 'playroom-policy/1.0',
        expires: '2026-11-30T00:00:00Z',
        mandate_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
      {
        id: 'bo',
        kind: 'agent',
        display_name: 'Bo',
        principal_id: 'principal:guest-b',
        principal_name: expect.any(String),
        principal_ordinal: 3,
        adapter_id: 'bo',
        scope: ['pr.review', 'pr.comment', 'pr.merge'],
        protected_actions: ['pr.merge', 'deploy'],
        co_sign: { actions: ['pr.merge', 'deploy'], by: 'principal' },
        limits: { interrupts_per_day: 6, postage_per_day: 200 },
        policy_version: 'playroom-policy/1.0',
        expires: '2026-11-30T00:00:00Z',
        mandate_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
    ]);
  });

  it('names no provider and no model — §6 survives the roster becoming records', async () => {
    // The roster now travels over HTTP to the web tier, which is a new way for a provider
    // name to escape packages/adapters. Asserted against the serialised shape, because that
    // is what actually leaves the process.
    const serialised = JSON.stringify(await listMembers(pool));
    expect(serialised).not.toMatch(/anthropic|openai|gpt-|claude-haiku/i);
  });

  it('orders by principal ordinal, so the roster strip does not reshuffle', async () => {
    const members = await listMembers(pool);
    const ordinals = members.map((m) => m.principal_ordinal);
    expect([...ordinals].sort((a, b) => a - b)).toEqual(ordinals);
  });

  it('carries prince as a HUMAN member bound to his principal, with no adapter', async () => {
    // The film's human was a free string in actor_id with no referent anywhere. S1.1b makes
    // him a record under the same binding every other member has had since 007.
    const prince = (await listMembers(pool)).find((m) => m.id === 'prince');
    expect(prince).toMatchObject({
      kind: 'human',
      display_name: 'Prince',
      principal_id: 'principal:prince',
      adapter_id: null,
    });
  });

  it('projects the six mandate fields FROM the document, with mandate_hash from the WRAPPER', async () => {
    // The mechanism, not the values: every field the surface renders is read from the mandate the
    // fabric loaded, and mandate_hash is the wrapper's hash — not a re-hash of `.mandate`, and not the
    // mandate_id. The named trap: a hash of the wrong object is a real-looking id that identifies nothing.
    const claude = (await listMembers(pool)).find((m) => m.id === 'claude-main');
    const loaded = mandateFor('claude-main');
    expect(loaded, 'fixture: claude-main must have a mandate').toBeDefined();
    const doc = loaded!.mandate;
    expect(claude?.co_sign).toEqual(doc.co_sign);
    expect(claude?.limits).toEqual(doc.limits);
    expect(claude?.policy_version).toBe(doc.policy_version);
    expect(claude?.expires).toBe(doc.expires);
    expect(claude?.mandate_hash).toBe(loaded!.hash); // the wrapper's hash, verbatim
    expect(claude?.mandate_hash).not.toBe(doc.mandate_id); // not the id — a sha256 of the document
    expect(claude?.mandate_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('keeps ABSENT (no mandate → null) distinct from PRESENT (mandate → real values) on the wire', async () => {
    const members = await listMembers(pool);
    const prince = members.find((m) => m.id === 'prince'); // human, no mandate at all
    const code = members.find((m) => m.id === 'claude-code'); // a real mandate

    // ABSENT: a member with no mandate is null across every mandate field — never [] or {}, which
    // would read as "a mandate that grants/gates nothing" rather than "no mandate exists".
    expect(prince?.co_sign).toBeNull();
    expect(prince?.limits).toBeNull();
    expect(prince?.policy_version).toBeNull();
    expect(prince?.expires).toBeNull();
    expect(prince?.mandate_hash).toBeNull();

    // PRESENT: claude-code HAS a mandate, so its fields serialise as VALUES, never null. SCC-2 populated
    // its co_sign (it gates pr.merge/deploy now — it gated nothing before); the wire distinction this
    // test guards is unchanged: a present mandate is real values where an absent one (prince) is null.
    expect(code?.co_sign).toEqual({ actions: ['pr.merge', 'deploy'], by: 'principal' });
    expect(code?.co_sign).not.toBeNull();
    expect(code?.mandate_hash).toMatch(/^sha256:/); // it has a document; the hash identifies it
  });
});

describe('a room roster, scoped', () => {
  it('GET /rooms/:id/members returns only that room, and 404s for a room that is not there', async () => {
    server = await startTestServer();
    const room = `members-scope-${Date.now()}`;
    expect((await httpCreateRoom(server.httpBase, room, server.token)).status).toBe(201);
    // Admit the roster this test expects. Creation enrols only the creator now (ADR-009); these are the
    // members the product would let in by a room code or an `admit`, written here so the roster read has
    // something to return. The scoping property the assertion checks is unchanged — a room contains exactly
    // who was put in it — only the enrolment is explicit instead of blanket.
    await admitToRoom(room, ...NON_CREATOR_MEMBERS);

    const res = await fetch(`${server.httpBase}/rooms/${room}/members`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Array<{ id: string; principal_name: string }> };
    // The roster is exactly the creator plus the admitted members. `ada` and `bo` are still ABSENT — their
    // principals are flagged `guest` and nothing admitted them, so a guest reaches a room only by redeeming
    // a room code, never incidentally. That property outlived blanket enrolment: it is now the DEFAULT for
    // everyone (no one is here who was not admitted) rather than a guest-only exception.
    // claude-code (S-CC) is a normal agent member of principal:prince, admitted like the others; it always
    // operates in its confined scratch workspace regardless of which room summons it (RT-005 retirement).
    expect(body.members.map((m) => m.id).sort()).toEqual([
      'claude-audit',
      'claude-code',
      'claude-main',
      'jerry',
      'prince',
      'sol',
    ]);

    const ghost = await fetch(`${server.httpBase}/rooms/no-such-room-here/members`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(ghost.status).toBe(404);

    await pool.query('DELETE FROM rooms WHERE id = $1', [room]);
  });

  it('a member removed from a room is no longer in its roster', async () => {
    // The path that makes per-room scoping observable. There is no product surface for
    // removing a member yet — invites and their inverse need an authenticated actor (S1.2) —
    // but membership is data, and the read must follow it.
    const room = `members-remove-${Date.now()}`;
    expect((await httpCreateRoom(server.httpBase, room, server.token)).status).toBe(201);
    await admitToRoom(room, ...NON_CREATOR_MEMBERS);
    await pool.query('DELETE FROM room_members WHERE room_id = $1 AND member_id = $2', [
      room,
      'sol',
    ]);

    const inRoom = await listRoomMembers(pool, room);
    expect(inRoom.map((m) => m.id).sort()).toEqual([
      'claude-audit',
      'claude-code',
      'claude-main',
      'jerry',
      'prince',
    ]);
    // The full-roster read still sees sol — the member exists, they are just not here.
    expect((await listMembers(pool)).map((m) => m.id)).toContain('sol');

    await pool.query('DELETE FROM rooms WHERE id = $1', [room]);
  });

  it('the summon tokens for a room resolve the same tags as before', async () => {
    // `@claude` must still mean claude-main. The display name moved from adapters.yaml to a
    // member record in S1.1a and resolution became per-room in S1.1b; this is the tag the
    // film types, checked through both moves.
    const room = `members-tokens-${Date.now()}`;
    expect((await httpCreateRoom(server.httpBase, room, server.token)).status).toBe(201);
    // @claude and @sol resolve only if claude-main and sol are IN this room — the token table is per-room
    // (S1.1a), built from membership. Admit them, then the tags mean what the film types.
    await admitToRoom(room, 'claude-main', 'sol');
    await loadRoomTokens(pool, room);

    const { summonRuling } = await import('../src/agent.js');
    const ruling = summonRuling({
      type: 'event',
      seq: 1,
      room_id: room,
      ts: '2026-07-26T00:00:00.000Z',
      actor_id: 'prince',
      event_type: 'message',
      payload: { body: '@claude and @sol' },
    });
    expect(ruling.rule).toBe('ACTIVATED');
    expect(ruling.members).toEqual(['claude-main', 'sol']);

    await pool.query('DELETE FROM rooms WHERE id = $1', [room]);
  });
});

describe('who may read a roster (S1.2)', () => {
  it('REFUSES an unauthenticated read — 401, and the two credential codes stay apart', async () => {
    // S11a-N1's other half. The rows were scoped to a room in S1.1b and who may ask was left
    // open, with the finding saying so. A roster is not a room id: it names people, the
    // principals they act for, and the actions each of them has been fenced from.
    const room = `roster-auth-${Date.now()}`;
    expect((await httpCreateRoom(server.httpBase, room, server.token)).status).toBe(201);

    const none = await fetch(`${server.httpBase}/rooms/${room}/members`);
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ type: 'error', code: 'credential_required' });

    const bad = await fetch(`${server.httpBase}/rooms/${room}/members`, {
      headers: { authorization: 'Bearer prm_nonsense' },
    });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ type: 'error', code: 'credential_invalid' });

    // A token in the wrong PLACE is not a credential. Accepting `?token=` here would put a
    // secret into every access log and browser history on the way — the socket does it only
    // because the browser WebSocket API cannot set headers.
    const inUrl = await fetch(`${server.httpBase}/rooms/${room}/members?token=${server.token}`);
    expect(inUrl.status).toBe(401);

    await pool.query('DELETE FROM rooms WHERE id = $1', [room]);
  });

  it('a caller who is NOT IN THE ROOM gets exactly what a non-existent room gives', async () => {
    // The one place a refusal deliberately does NOT distinguish two mistakes. `sol` holds a
    // legitimate credential; if a non-member were told "you are not in this room" it could
    // enumerate room ids by trying, and cross-principal leakage is what the product exists to
    // prevent. The distinction is moved to the server's log, not lost.
    const room = `roster-outsider-${Date.now()}`;
    expect((await httpCreateRoom(server.httpBase, room, server.token)).status).toBe(201);
    await pool.query('DELETE FROM room_members WHERE room_id = $1 AND member_id = $2', [
      room,
      'sol',
    ]);
    const solToken = await issueTestCredential('sol', 'roster-outsider');

    const outsider = await fetch(`${server.httpBase}/rooms/${room}/members`, {
      headers: { authorization: `Bearer ${solToken}` },
    });
    const ghost = await fetch(`${server.httpBase}/rooms/definitely-not-a-room/members`, {
      headers: { authorization: `Bearer ${solToken}` },
    });
    expect(outsider.status).toBe(404);
    expect(ghost.status).toBe(404);
    // Byte-identical bodies, not merely the same status — a different sentence would be the
    // same oracle with extra steps.
    const normalise = (body: string, id: string): string => body.replaceAll(id, '<room>');
    expect(normalise(await outsider.text(), room)).toBe(
      normalise(await ghost.text(), 'definitely-not-a-room'),
    );

    // And a member who IS in the room still reads it. The scoping must not be a wall.
    const insider = await fetch(`${server.httpBase}/rooms/${room}/members`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(insider.status).toBe(200);

    await pool.query("DELETE FROM member_credentials WHERE label = 'roster-outsider'");
    await pool.query('DELETE FROM rooms WHERE id = $1', [room]);
  });
});

describe('the oracle is closed everywhere, not just at the front door (S12-N1)', () => {
  it('GET /rooms/:id requires a credential, and refuses a token in the query string', async () => {
    const roomId = `oracle-auth-${Date.now()}`;
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);

    const none = await fetch(`${server.httpBase}/rooms/${roomId}`);
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ type: 'error', code: 'credential_required' });

    // A token in the wrong PLACE is not a credential — it would be written to every access log
    // and browser history on the way. Same rule as the roster route.
    const inUrl = await fetch(`${server.httpBase}/rooms/${roomId}?token=${server.token}`);
    expect(inUrl.status).toBe(401);

    const ok = await fetch(`${server.httpBase}/rooms/${roomId}`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: roomId });

    await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
  });

  it('THE SILENCE HOLDS END TO END — every route answers a non-member the same way', async () => {
    // The ruling's condition: "an oracle anywhere undoes silence everywhere". The handshake going
    // quiet is worth nothing if a sibling route answers the same question one request later, so
    // this asserts the whole surface at once rather than each route in isolation.
    const roomId = `oracle-end-${Date.now()}`;
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    await pool.query('DELETE FROM room_members WHERE room_id = $1 AND member_id = $2', [
      roomId,
      'sol',
    ]);
    const solToken = await issueTestCredential('sol', 'roster-outsider');
    const bearer = { authorization: `Bearer ${solToken}` };
    const ghostId = 'oracle-no-such-room';

    for (const path of ['', '/members']) {
      const outsider = await fetch(`${server.httpBase}/rooms/${roomId}${path}`, {
        headers: bearer,
      });
      const ghost = await fetch(`${server.httpBase}/rooms/${ghostId}${path}`, { headers: bearer });
      expect(outsider.status, `GET /rooms/:id${path} status`).toBe(404);
      expect(ghost.status).toBe(404);
      const normalise = (body: string, id: string): string => body.replaceAll(id, '<room>');
      expect(normalise(await outsider.text(), roomId), `GET /rooms/:id${path} body`).toBe(
        normalise(await ghost.text(), ghostId),
      );
    }

    // AND THE CREATE ROUTE, which used to return an existing room's title and creation date to
    // anyone who guessed the id — an oracle for content, not merely for existence. It is closed
    // twice over now, and both halves are asserted because they fail independently.
    //
    // FIRST: it takes a credential at all (RT-002, closed in S1.3c).
    const anonymous = await fetch(`${server.httpBase}/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: roomId, title: 'a title I chose' }),
    });
    expect(anonymous.status).toBe(401);

    // SECOND: even an authenticated member learns nothing by guessing. `sol` is not in this room;
    // a collision and a fresh create return the same body, so the response cannot be used to
    // discover that the room exists or what it is called.
    const collide = await fetch(`${server.httpBase}/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer },
      body: JSON.stringify({ id: roomId, title: 'a title I chose' }),
    });
    expect(collide.status).toBe(201);
    expect(await collide.json()).toEqual({ id: roomId });

    await pool.query("DELETE FROM member_credentials WHERE label = 'roster-outsider'");
    await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
  });
});

describe('creating a room requires a credential (RT-002, closed in S1.3c)', () => {
  it('REFUSES an unauthenticated create, in the standard shape', async () => {
    const res = await fetch(`${server.httpBase}/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: `rt002-${Date.now()}`, title: 'no credential here' }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ type: 'error', code: 'credential_required' });

    const bad = await fetch(`${server.httpBase}/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer prm_nope' },
      body: JSON.stringify({ id: `rt002-bad-${Date.now()}` }),
    });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ code: 'credential_invalid' });
  });

  it('ENROLS THE CREATOR in the same transaction, so the room can actually be opened', async () => {
    // The property that makes creation and enrolment one act rather than two: after S1.3b's front
    // door, a room with no members is a room NOBODY can open — including the member who just made
    // it, and there is no product surface to fix it from.
    const roomId = `rt002-enrol-${Date.now()}`;
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);

    const { rows } = await pool.query<{ member_id: string }>(
      'SELECT member_id FROM room_members WHERE room_id = $1 ORDER BY member_id',
      [roomId],
    );
    expect(rows.map((r) => r.member_id)).toContain('prince');

    // And the door opens for them, which is the only assertion that proves the row is the right
    // one rather than merely present.
    const c = new Client(`${server.wsBase}/rooms/${roomId}/ws?after=0`, server.token);
    await c.open();
    c.send('the creator can open their own room', 'rt002-1');
    await c.waitForEvents(1);
    expect(c.events[0].actor_id).toBe('prince');
    c.close();

    await pool.query('DELETE FROM events WHERE room_id = $1', [roomId]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
  });
});

describe('a guest is not enrolled by creating a room', () => {
  it('CREATION ENROLS ONLY THE CREATOR — no guest, and no one else either (ADR-009)', async () => {
    // THE HOLE THIS ONCE CLOSED, and the wider one ADR-009 closed after it. Creation used to enrol every
    // NON-GUEST member, and guests were the single deliberate exclusion — the room code's whole job. That
    // exclusion is now the DEFAULT for everyone: a new room enrols exactly its creator, and every other
    // member (guest or not) arrives by a deliberate admission. So a guest is not auto-enrolled — but neither
    // is any agent or other human, which is the stronger property this now asserts.
    //
    // Asserted on the ROW rather than the handshake, because the handshake is unchanged and must stay that
    // way: this is about who is a member, not what the front door does with one.
    const room = `members-guest-${Date.now()}`;
    expect((await httpCreateRoom(server.httpBase, room, server.token)).status).toBe(201);

    // No guest was enrolled — the property that used to be the point, still true.
    const { rows } = await pool.query<{ member_id: string }>(
      `SELECT rm.member_id FROM room_members AS rm
         JOIN members AS m ON m.id = rm.member_id
         JOIN principals AS p ON p.id = m.principal_id
        WHERE rm.room_id = $1 AND p.guest = true`,
      [room],
    );
    expect(
      rows.map((r) => r.member_id),
      'a guest was enrolled by room creation',
    ).toEqual([]);

    // And the roster is EXACTLY the creator — no blanket enrolment of the non-guest roster follows. This is
    // the assertion that a bug enrolling everyone (the old behaviour) would now fail, the mirror of the old
    // half that a bug enrolling nobody would have failed.
    const all = await listRoomMembers(pool, room);
    expect(all.map((m) => m.id).sort()).toEqual(['prince']);

    await pool.query('DELETE FROM rooms WHERE id = $1', [room]);
  });
});
