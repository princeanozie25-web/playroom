import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  ERROR_BRIEFING_ABSENT,
  ERROR_BRIEFING_MALFORMED,
  ERROR_BRIEFING_NOT_HUMAN,
  ERROR_BRIEFING_NOT_OWNER,
  ERROR_BRIEFING_NO_ROOM_OWNER,
  ERROR_BRIEFING_TOO_LARGE,
} from '@playroom/shared';
import {
  admitToRoom,
  Client,
  httpCreateRoom,
  issueTestCredential,
  startTestServer,
  testPool,
  uniqueRoomId,
  type TestServer,
} from './support.js';
import { RoomBus } from '../src/bus.js';
import { createRoom } from '../src/events.js';
import { executeCommand, type CommandDeps } from '../src/commands/index.js';
import { activeBriefing, briefingContentHash, BRIEFING_MAX_CHARS } from '../src/briefings.js';

/**
 * ═══ S1.7 — THE BRIEFING RECORD (S17-1) ═══
 *
 * A briefing is owner-authored framing pinned to the room, written as a RECORD BEFORE ANY COPY (the
 * S1.5 shape). This proves the record, the owner-only and human-only rules by the reason each fires,
 * the before/after of a replacement, that clearing is explicit, and that absent and empty are distinct.
 */

const pool = testPool();
const rooms: string[] = [];

// Direct-command deps — no adapter is built (a briefing never triggers a turn), so a factory call is a
// bug the test should surface loudly rather than reach a live provider. `execute` self-references deps.
const deps: CommandDeps = {
  pool,
  bus: new RoomBus(),
  log: { info() {}, warn() {}, error() {} },
  adapterFactory: () => {
    throw new Error('a briefing must never build an adapter');
  },
  execute: (ctx, command) => executeCommand(ctx, command, deps),
};

async function room(owner: string): Promise<string> {
  const id = uniqueRoomId('brief');
  rooms.push(id);
  await createRoom(pool, id, id, owner);
  return id;
}
async function set(roomId: string, actor: string, content: string, purpose = 'standing brief') {
  return executeCommand(
    { actorId: actor, mode: 'human' },
    {
      kind: 'setBriefing',
      roomId,
      clientMsgId: `bs-${roomId}-${content.length}`,
      content,
      purpose,
    },
    deps,
  );
}
async function clear(roomId: string, actor: string) {
  return executeCommand(
    { actorId: actor, mode: 'human' },
    { kind: 'clearBriefing', roomId, clientMsgId: `bc-${roomId}` },
    deps,
  );
}
async function briefingEvents(roomId: string, type: 'briefing.set' | 'briefing.cleared') {
  const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM events WHERE room_id = $1 AND event_type = $2 ORDER BY seq`,
    [roomId, type],
  );
  return rows.map((r) => r.payload);
}

afterEach(async () => {
  for (const id of rooms) {
    await pool.query('DELETE FROM events WHERE room_id = $1', [id]);
    await pool.query('DELETE FROM room_briefings WHERE room_id = $1', [id]);
    await pool.query('DELETE FROM room_members WHERE room_id = $1', [id]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [id]);
  }
  rooms.length = 0;
});
afterAll(async () => {
  await pool.end();
});

describe('the record: the copy is derived from a record written first', () => {
  it('the owner sets a briefing; the room event is derived from the row that recorded it', async () => {
    const roomId = await room('prince');
    const content =
      'You are reviewing PRs for the playroom repo. Prefer small, reversible changes.';
    const r = await set(roomId, 'prince', content, 'brief for the nightly review loop');
    expect(r.ok).toBe(true);

    // THE RECORD exists, with the hash and provenance the S1.5 shape requires.
    const active = await activeBriefing(pool, roomId);
    expect(active).not.toBeNull();
    expect(active?.content).toBe(content);
    expect(active?.content_hash).toBe(briefingContentHash(content));
    expect(active?.purpose).toBe('brief for the nightly review loop');
    expect(active?.set_by).toBe('prince');
    expect(active?.cleared_at).toBeNull();

    // THE COPY is one briefing.set event, and every field is the record's — content and hash agree, so
    // the copy was derived from the record, not written alongside it. First briefing → replaces_hash null.
    const sets = await briefingEvents(roomId, 'briefing.set');
    expect(sets).toHaveLength(1);
    expect(sets[0].content).toBe(content);
    expect(sets[0].content_hash).toBe(active?.content_hash);
    expect(sets[0].briefing_id).toBe(active?.id);
    expect(sets[0].set_by).toBe('prince');
    expect(sets[0].replaces_hash).toBeNull();
  });
});

describe('only the room owner, and only a human', () => {
  it('a human who is not the owner is refused, naming the owner-only rule', async () => {
    const roomId = await room('prince');
    const r = await set(roomId, 'jerry', 'jerry tries to brief a room he does not own');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe(ERROR_BRIEFING_NOT_OWNER);
    // Nothing was written — the room has no briefing and no briefing.set from jerry.
    expect(await activeBriefing(pool, roomId)).toBeNull();
    expect(await briefingEvents(roomId, 'briefing.set')).toHaveLength(0);
  });

  it('an AGENT is refused BY KIND even when it owns the room — the mechanism, not the outcome', async () => {
    // The load-bearing rule: an agent may never set a briefing. Proven by mechanism — an agent that
    // OWNS the room is still refused, and the reason is not-human (checked first), never not-owner. So
    // even if a future path made an agent a room's owner, the kind check would still stop it.
    const agentOwned = await room('claude-main');
    const r1 = await set(agentOwned, 'claude-main', 'an agent-owner tries to brief its own room');
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.refusal.code).toBe(ERROR_BRIEFING_NOT_HUMAN);

    // And an agent that is merely a member of a human-owned room is refused the same way.
    const humanOwned = await room('prince');
    const r2 = await set(humanOwned, 'claude-main', 'a non-owner agent tries to brief');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.refusal.code).toBe(ERROR_BRIEFING_NOT_HUMAN);

    expect(await activeBriefing(pool, agentOwned)).toBeNull();
    expect(await activeBriefing(pool, humanOwned)).toBeNull();
  });

  it('a room with no recorded owner cannot be briefed by anyone (fail-closed)', async () => {
    // A room predating migration 026 has created_by NULL. Simulated by nulling it after creation — the
    // set must refuse with its own reason, distinct from "you are not the owner".
    const roomId = await room('prince');
    await pool.query('UPDATE rooms SET created_by = NULL WHERE id = $1', [roomId]);
    const r = await set(roomId, 'prince', 'nobody owns this room');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe(ERROR_BRIEFING_NO_ROOM_OWNER);
  });
});

describe('replacing a briefing is a before/after change', () => {
  it('a replacement carries the prior hash, leaves exactly one active row, and shows both in history', async () => {
    const roomId = await room('prince');
    const first = 'v1: review PRs, prefer small changes';
    const second = 'v2: review PRs, and open follow-up issues for anything deferred';
    await set(roomId, 'prince', first, 'v1');
    const firstHash = briefingContentHash(first);
    const r2 = await set(roomId, 'prince', second, 'v2');
    expect(r2.ok).toBe(true);

    // The active briefing is the SECOND; there is exactly one active row (the one-active index holds).
    const active = await activeBriefing(pool, roomId);
    expect(active?.content).toBe(second);
    const { rows: activeRows } = await pool.query(
      'SELECT id FROM room_briefings WHERE room_id = $1 AND cleared_at IS NULL',
      [roomId],
    );
    expect(activeRows).toHaveLength(1);

    // The replacement's event carries BEFORE (the prior hash) and AFTER (its own) — the order.updated
    // shape — so the change is legible from the log alone. History holds both briefing.set events.
    const sets = await briefingEvents(roomId, 'briefing.set');
    expect(sets).toHaveLength(2);
    expect(sets[0].replaces_hash).toBeNull();
    expect(sets[1].replaces_hash).toBe(firstHash);
    expect(sets[1].content_hash).toBe(briefingContentHash(second));
  });
});

describe('absent, empty and cleared are different states', () => {
  it('a fresh room is ABSENT (null), not empty', async () => {
    const roomId = await room('prince');
    expect(await activeBriefing(pool, roomId)).toBeNull();
  });

  it('clearing a room with no briefing is refused — there is nothing to clear', async () => {
    const roomId = await room('prince');
    const r = await clear(roomId, 'prince');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe(ERROR_BRIEFING_ABSENT);
    // A clear-of-nothing writes no event — a cleared room and a never-briefed room stay distinguishable.
    expect(await briefingEvents(roomId, 'briefing.cleared')).toHaveLength(0);
  });

  it('setting then clearing returns to absent, but leaves a record that it was cleared', async () => {
    const roomId = await room('prince');
    await set(roomId, 'prince', 'a briefing that will be cleared');
    const before = await activeBriefing(pool, roomId);
    const r = await clear(roomId, 'prince');
    expect(r.ok).toBe(true);

    // Absent again — no active briefing region will be delivered.
    expect(await activeBriefing(pool, roomId)).toBeNull();
    // But ON THE RECORD: a briefing.cleared event names which briefing was cleared, so history tells a
    // cleared room apart from one that never had a briefing.
    const cleared = await briefingEvents(roomId, 'briefing.cleared');
    expect(cleared).toHaveLength(1);
    expect(cleared[0].briefing_id).toBe(before?.id);
    expect(cleared[0].content_hash).toBe(before?.content_hash);

    // And a second clear is refused — absent again, nothing to clear.
    const r2 = await clear(roomId, 'prince');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.refusal.code).toBe(ERROR_BRIEFING_ABSENT);
  });

  it('blank content or blank purpose is refused — there is no implicit empty briefing', async () => {
    const roomId = await room('prince');
    const blankContent = await set(roomId, 'prince', '   ', 'a purpose');
    expect(blankContent.ok).toBe(false);
    if (!blankContent.ok) expect(blankContent.refusal.code).toBe(ERROR_BRIEFING_MALFORMED);
    const blankPurpose = await set(roomId, 'prince', 'real content', '   ');
    expect(blankPurpose.ok).toBe(false);
    if (!blankPurpose.ok) expect(blankPurpose.refusal.code).toBe(ERROR_BRIEFING_MALFORMED);
    expect(await activeBriefing(pool, roomId)).toBeNull();
  });
});

describe('the size cap is refused at set time, never truncated', () => {
  it('a briefing over the cap is refused with its own reason; one at the cap is accepted', async () => {
    const roomId = await room('prince');
    const over = 'x'.repeat(BRIEFING_MAX_CHARS + 1);
    const r = await set(roomId, 'prince', over, 'too big');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe(ERROR_BRIEFING_TOO_LARGE);
    // Nothing was stored — a briefing the room believes it has and the model never saw is the failure
    // the cap exists to prevent, so it is refused, not truncated.
    expect(await activeBriefing(pool, roomId)).toBeNull();

    const atCap = 'y'.repeat(BRIEFING_MAX_CHARS);
    const ok = await set(roomId, 'prince', atCap, 'at the cap');
    expect(ok.ok).toBe(true);
    expect((await activeBriefing(pool, roomId))?.content.length).toBe(BRIEFING_MAX_CHARS);
  });
});

describe('the transport: owner sets over the socket; a non-owner is refused there too', () => {
  let server: TestServer | undefined;
  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
    // The non-owner credential issued for the refusal probe — deleted, not left to accumulate (S12-N3).
    await pool.query("DELETE FROM member_credentials WHERE label = 'brief-nonowner'");
  });

  it('the owner sets a briefing over the wire and the room receives a briefing.set event', async () => {
    server = await startTestServer();
    const roomId = uniqueRoomId('brief-ws');
    rooms.push(roomId);
    // The creator is the token's member — prince — so prince is the owner.
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);

    const c = new Client(`${server.wsBase}/rooms/${roomId}/ws`, server.token);
    await c.open();
    c.ws.send(
      JSON.stringify({
        type: 'briefing_set',
        client_msg_id: 'ws-brief-1',
        content: 'brief set over the socket by the owner',
        purpose: 'transport check',
      }),
    );
    await c.waitForType('briefing.set');
    c.close();

    const evt = c.ofType('briefing.set')[0];
    expect(evt.event_type).toBe('briefing.set');
    expect((await activeBriefing(pool, roomId))?.set_by).toBe('prince');
  });

  it('a non-owner human is refused over the wire, by the owner-only code', async () => {
    server = await startTestServer();
    const roomId = uniqueRoomId('brief-ws-deny');
    rooms.push(roomId);
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    await admitToRoom(roomId, 'jerry');

    // Jerry is a human member of the room (creation enrols him) but not its owner.
    const jerryToken = await issueTestCredential('jerry', 'brief-nonowner');
    const c = new Client(`${server.wsBase}/rooms/${roomId}/ws`, jerryToken);
    await c.open();
    c.ws.send(
      JSON.stringify({
        type: 'briefing_set',
        client_msg_id: 'ws-brief-deny',
        content: 'jerry tries to brief a room he does not own',
        purpose: 'should be refused',
      }),
    );
    const err = await c.waitForError((e) => e.code === ERROR_BRIEFING_NOT_OWNER);
    expect(err.code).toBe(ERROR_BRIEFING_NOT_OWNER);
    c.close();
    expect(await activeBriefing(pool, roomId)).toBeNull();
  });
});
