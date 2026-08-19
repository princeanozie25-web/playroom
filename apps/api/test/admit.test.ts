import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  ERROR_ADMIT_NOT_HUMAN,
  ERROR_ADMIT_NOT_OWNER,
  ERROR_ADMIT_NO_ROOM_OWNER,
  ERROR_ADMIT_NO_SUCH_MEMBER,
} from '@playroom/shared';
import {
  Client,
  httpCreateRoom,
  scriptedAdapter,
  startTestServer,
  testPool,
  uniqueRoomId,
} from './support.js';
import { RoomBus } from '../src/bus.js';
import { createRoom } from '../src/events.js';
import { isRoomMember } from '../src/members.js';
import { executeCommand, type CommandDeps } from '../src/commands/index.js';
import { type AdmitResult } from '../src/commands/admit.js';

/**
 * ═══ ADR-009 — THE ROOM DOOR: SCOPED ADMISSION ═══
 *
 * Creation now enrols only the creator (events.ts). This is the governed way everyone else gets in: the
 * room OWNER, and only a human, admits a named member. The tests assert the two things that make the door
 * a door — the gate (an agent may never admit; a non-owner may not; a NULL-owner room admits no one; a
 * non-existent member is refused by name) and the effect (an admitted member is in the room, idempotently,
 * and an admitted AGENT is thereby summonable — membership is what makes @tag resolve).
 */

const pool = testPool();
const rooms: string[] = [];

function deps(): CommandDeps {
  const d: CommandDeps = {
    pool,
    bus: new RoomBus(),
    log: { info() {}, warn() {}, error() {} },
    adapterFactory: (id) =>
      scriptedAdapter(id, [
        { kind: 'text_delta', text: `${id} here` },
        { kind: 'done', tokens_in: 3, tokens_out: 2, stop_reason: 'end_turn' },
      ]),
    execute: (ctx, command) => executeCommand(ctx, command, d),
  };
  return d;
}

function admit(actorId: string, roomId: string, member: string): Promise<AdmitResult> {
  return executeCommand(
    { actorId, mode: actorId === 'prince' || actorId === 'jerry' ? 'human' : 'hosted' },
    { kind: 'admit', roomId, member },
    deps(),
  );
}

afterEach(async () => {
  for (const room of rooms) {
    await pool.query('DELETE FROM events WHERE room_id = $1', [room]);
    await pool.query('DELETE FROM room_members WHERE room_id = $1', [room]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [room]);
  }
  rooms.length = 0;
});

afterAll(async () => {
  await pool.end();
});

describe('the room door admits (ADR-009)', () => {
  it('the owner admits a member, and the member is then in the room', async () => {
    const roomId = uniqueRoomId('admit-ok');
    rooms.push(roomId);
    await createRoom(pool, roomId, roomId, 'prince');
    // Creation enrols only the creator now, so sol is NOT here to begin with.
    expect(await isRoomMember(pool, roomId, 'sol')).toBe(false);

    const res = await admit('prince', roomId, 'sol');
    expect(res).toEqual({ ok: true, alreadyMember: false });
    expect(await isRoomMember(pool, roomId, 'sol')).toBe(true);
  });

  it('admitting a member already in the room is an idempotent no-op', async () => {
    const roomId = uniqueRoomId('admit-idem');
    rooms.push(roomId);
    await createRoom(pool, roomId, roomId, 'prince');

    expect(await admit('prince', roomId, 'sol')).toEqual({ ok: true, alreadyMember: false });
    // The second time the door is asked to open for someone already inside: still ok, but nothing written.
    expect(await admit('prince', roomId, 'sol')).toEqual({ ok: true, alreadyMember: true });
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM room_members WHERE room_id = $1 AND member_id = $2',
      [roomId, 'sol'],
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it('an admitted agent becomes summonable — membership is what makes @tag resolve', async () => {
    const server = await startTestServer({
      adapterFactory: (id) =>
        scriptedAdapter(id, [
          { kind: 'text_delta', text: `${id} here` },
          { kind: 'done', tokens_in: 4, tokens_out: 2, stop_reason: 'end_turn' },
        ]),
    });
    const roomId = uniqueRoomId('admit-summon');
    rooms.push(roomId);
    try {
      expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
      // Admit claude-main through the COMMAND (owner = prince, the creator). The server shares this DB, so
      // its send-path token table (loadRoomTokens) sees the new membership on the very next message.
      expect(await admit('prince', roomId, 'claude-main')).toEqual({
        ok: true,
        alreadyMember: false,
      });

      const c = new Client(`${server.wsBase}/rooms/${roomId}/ws?after=0`, server.token);
      await c.open();
      c.send('@claude are you there?', 'admit-1');
      await c.waitForType('agent.turn.completed');
      // The tag resolved to the admitted agent and it took exactly one attributed turn.
      expect(c.ofType('summon')).toHaveLength(1);
      c.close();
    } finally {
      await server.close();
    }
  });

  it('a human who is not the owner may not admit', async () => {
    const roomId = uniqueRoomId('admit-notowner');
    rooms.push(roomId);
    await createRoom(pool, roomId, roomId, 'prince');

    // jerry is a human member of the roster but not this room's owner.
    const res = await admit('jerry', roomId, 'sol');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('narrowing');
    expect(res.refusal.code).toBe(ERROR_ADMIT_NOT_OWNER);
    // Nothing was admitted — the refusal is total.
    expect(await isRoomMember(pool, roomId, 'sol')).toBe(false);
  });

  it('an agent may never admit — refused by KIND, before ownership', async () => {
    // The room is OWNED by an agent (a shape the product does not produce, constructed here to prove the
    // ordering): claude-main is both the owner and the actor, and it is STILL refused — by kind, not identity.
    const roomId = uniqueRoomId('admit-agent');
    rooms.push(roomId);
    await createRoom(pool, roomId, roomId, 'claude-main');

    const res = await admit('claude-main', roomId, 'sol');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('narrowing');
    expect(res.refusal.code).toBe(ERROR_ADMIT_NOT_HUMAN);
    expect(await isRoomMember(pool, roomId, 'sol')).toBe(false);
  });

  it('admitting a member that does not exist is refused by name, not a foreign-key crash', async () => {
    const roomId = uniqueRoomId('admit-ghost');
    rooms.push(roomId);
    await createRoom(pool, roomId, roomId, 'prince');

    const res = await admit('prince', roomId, 'ghost-member-nobody');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('narrowing');
    expect(res.refusal.code).toBe(ERROR_ADMIT_NO_SUCH_MEMBER);
  });

  it('a room with no recorded owner admits no one — fail closed', async () => {
    const roomId = uniqueRoomId('admit-noowner');
    rooms.push(roomId);
    await createRoom(pool, roomId, roomId, 'prince');
    // Simulate a room that predates owner records (migration 026): created_by is NULL.
    await pool.query('UPDATE rooms SET created_by = NULL WHERE id = $1', [roomId]);

    const res = await admit('prince', roomId, 'sol');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('narrowing');
    expect(res.refusal.code).toBe(ERROR_ADMIT_NO_ROOM_OWNER);
    expect(await isRoomMember(pool, roomId, 'sol')).toBe(false);
  });
});
