import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentTurnChunk } from '@playroom/shared';
import {
  ERROR_ORDER_BAD_STATE,
  ERROR_ORDER_MEMBER_UNKNOWN,
  ERROR_ORDER_NOT_CREATOR,
  ERROR_ORDER_NOT_HUMAN,
  ERROR_ORDER_UNKNOWN,
} from '@playroom/shared';
import { testPool, uniqueRoomId } from './support.js';
import { RoomBus } from '../src/bus.js';
import { createRoom } from '../src/events.js';
import { executeCommand, type CommandDeps } from '../src/commands/index.js';

/**
 * ═══ S-LOOP — THE STANDING-ORDER RECORD: WHO MAY AUTHORISE RECURRING WORK ═══
 *
 * An order is delegated human intent. Only a human creates one; any human may pause it (the safe
 * direction); only the creator resumes or revokes; an agent may do NONE of these — the load-bearing
 * rule, the same reasoning that keeps an agent from signing. Every transition is an evented, attributed
 * record, and the standing_orders row is a projection of that log.
 */

const pool = testPool();
const rooms: string[] = [];

function stub(id: string): AgentAdapter {
  return {
    id,
    async *stream(): AsyncGenerator<AgentTurnChunk> {
      yield { kind: 'done', tokens_in: 0, tokens_out: 0, stop_reason: 'end_turn' };
    },
  };
}

let deps: CommandDeps;
beforeEach(() => {
  deps = {
    pool,
    bus: new RoomBus(),
    log: { info() {}, warn() {}, error() {} },
    adapterFactory: (id) => stub(id),
    execute: (ctx, command) => executeCommand(ctx, command, deps),
  };
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  for (const room of rooms) {
    await pool.query('DELETE FROM standing_orders WHERE room_id = $1', [room]);
    await pool.query('DELETE FROM events WHERE room_id = $1', [room]);
    await pool.query('DELETE FROM room_members WHERE room_id = $1', [room]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [room]);
  }
  rooms.length = 0;
});

async function room(prefix: string): Promise<string> {
  const roomId = uniqueRoomId(prefix);
  rooms.push(roomId);
  await createRoom(pool, roomId, roomId, 'prince');
  return roomId;
}

async function create(
  roomId: string,
  actorId: string,
  opts?: { trigger?: string; action?: string },
) {
  return executeCommand(
    { actorId, mode: actorId === 'prince' || actorId === 'jerry' ? 'human' : 'hosted' },
    {
      kind: 'createOrder',
      roomId,
      clientMsgId: `oc-${actorId}-${Date.now()}`,
      triggerEventType: 'agent.turn.completed',
      triggerMember: opts?.trigger ?? 'sol',
      actionMember: opts?.action ?? 'claude-main',
      task: 'draft, then hand back for review',
      // A CYCLE CAP: S-DIAL refuses a dial above 1 with no end. Generous enough that this
      // fixture behaves exactly as it did.
      maxCycles: 50,
      maxUnattendedCycles: 3,
      expiresAt: null,
    },
    deps,
  );
}

async function control(
  roomId: string,
  actorId: string,
  orderId: string,
  op: 'pause' | 'resume' | 'revoke',
) {
  return executeCommand(
    { actorId, mode: actorId === 'prince' || actorId === 'jerry' ? 'human' : 'hosted' },
    { kind: 'controlOrder', roomId, clientMsgId: `ct-${op}-${Date.now()}`, orderId, op },
    deps,
  );
}

async function orderRow(roomId: string, orderId: string) {
  const { rows } = await pool.query<{
    status: string;
    creator_member_id: string;
    pause_reason: string | null;
  }>(
    `SELECT status, creator_member_id, pause_reason FROM standing_orders WHERE id = $1 AND room_id = $2`,
    [orderId, roomId],
  );
  return rows[0];
}

async function orderEvents(roomId: string, orderId: string) {
  const { rows } = await pool.query<{
    event_type: string;
    payload: { status?: string; actor?: string };
  }>(
    `SELECT event_type, payload FROM events
      WHERE room_id = $1 AND event_type IN ('order.created', 'order.status') AND payload ->> 'order_id' = $2
      ORDER BY seq`,
    [roomId, orderId],
  );
  return rows;
}

describe('creation — only a human authorises recurring work', () => {
  it('a human creates an order: an event and a projection row, attributed to the creator', async () => {
    const roomId = await room('order-create');
    const result = await create(roomId, 'prince');
    expect(result.ok).toBe(true);
    const orderId = result.ok ? result.orderId! : '';

    const row = await orderRow(roomId, orderId);
    expect(row.status).toBe('ACTIVE');
    expect(row.creator_member_id).toBe('prince');
    const events = await orderEvents(roomId, orderId);
    expect(events.map((e) => e.event_type)).toEqual(['order.created']);
  });

  it('an AGENT cannot create an order — the load-bearing refusal', async () => {
    const roomId = await room('order-agent');
    const result = await create(roomId, 'claude-main');
    expect(result).toEqual({
      ok: false,
      refusal: { code: ERROR_ORDER_NOT_HUMAN, message: expect.any(String) },
    });
    const { rows } = await pool.query(
      `SELECT count(*) AS n FROM standing_orders WHERE room_id = $1`,
      [roomId],
    );
    expect(Number((rows[0] as { n: string }).n)).toBe(0);
  });

  it('refuses a trigger or action member that is not an agent of this room', async () => {
    const roomId = await room('order-badmember');
    const result = await create(roomId, 'prince', { action: 'nobody-real' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe(ERROR_ORDER_MEMBER_UNKNOWN);
  });
});

describe('control — any human pauses, only the creator resumes or revokes, an agent never', () => {
  it('any human may pause; the creator resumes — and the log leads the projection', async () => {
    const roomId = await room('order-pause');
    const created = await create(roomId, 'prince');
    const orderId = created.ok ? created.orderId! : '';

    // jerry (a human, NOT the creator) may pause — the safe direction.
    expect((await control(roomId, 'jerry', orderId, 'pause')).ok).toBe(true);
    expect((await orderRow(roomId, orderId)).status).toBe('PAUSED');
    expect((await orderRow(roomId, orderId)).pause_reason).toContain('jerry');

    // prince (the creator) resumes.
    expect((await control(roomId, 'prince', orderId, 'resume')).ok).toBe(true);
    const row = await orderRow(roomId, orderId);
    expect(row.status).toBe('ACTIVE');
    expect(row.pause_reason).toBeNull();

    // The log leads: created → status(PAUSED) → status(ACTIVE), and the last event's status is the row's.
    const events = await orderEvents(roomId, orderId);
    expect(events.map((e) => `${e.event_type}:${e.payload.status ?? ''}`)).toEqual([
      'order.created:',
      'order.status:PAUSED',
      'order.status:ACTIVE',
    ]);

    // ── A RESUME MUST NOT LEAVE A PERSON BELIEVING SOMETHING IS RUNNING (AF-N1) ──────
    //
    // Resuming fires no cycle: an order fires on a completed turn by its trigger member, and this is
    // not one. The OUTCOME asserted here is that the room says so — not the wording, which may be
    // reworded, but that a person who just resumed is told a completion is still required, and by
    // whom. Under AF-N1 they were told nothing and the chip simply went green.
    const { rows: notices } = await pool.query<{ body: string }>(
      `SELECT payload ->> 'body' AS body FROM events
        WHERE room_id = $1 AND event_type = 'message' AND actor_id = 'system' ORDER BY seq`,
      [roomId],
    );
    const said = notices.map((n) => n.body).join('\n');
    expect(notices.length, `no system notice followed the resume:\n${said}`).toBe(1);
    // It names the member whose next completed turn is the trigger — the actionable half.
    expect(said).toContain('claude-main');
    // And it says a completion is still owed, rather than implying the loop is moving.
    expect(said).toMatch(/next completed turn/);

    // AND IT REMAINS TRUE THAT NOTHING RAN: a resume is not a trigger, and this is the property the
    // sentence exists to describe. A notice that were merely decorative would pass the greps above
    // and fail here the moment resume started firing cycles without a ruling.
    const { rows: cycled } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM events WHERE room_id = $1 AND event_type = 'order.cycled'`,
      [roomId],
    );
    expect(Number(cycled[0].n), 'resuming fired a cycle — that is a ruling, not a fix').toBe(0);
  });

  it('a non-creator human cannot resume or revoke — but could have paused', async () => {
    const roomId = await room('order-notcreator');
    const created = await create(roomId, 'prince');
    const orderId = created.ok ? created.orderId! : '';
    await control(roomId, 'prince', orderId, 'pause'); // now PAUSED

    const resume = await control(roomId, 'jerry', orderId, 'resume');
    expect(resume.ok).toBe(false);
    if (!resume.ok) expect(resume.refusal.code).toBe(ERROR_ORDER_NOT_CREATOR);
    const revoke = await control(roomId, 'jerry', orderId, 'revoke');
    expect(revoke.ok).toBe(false);
    if (!revoke.ok) expect(revoke.refusal.code).toBe(ERROR_ORDER_NOT_CREATOR);
    expect((await orderRow(roomId, orderId)).status).toBe('PAUSED'); // unchanged
  });

  it('an AGENT cannot pause, resume, or revoke', async () => {
    const roomId = await room('order-agentctl');
    const created = await create(roomId, 'prince');
    const orderId = created.ok ? created.orderId! : '';
    const paused = await control(roomId, 'claude-main', orderId, 'pause');
    expect(paused.ok).toBe(false);
    if (!paused.ok) expect(paused.refusal.code).toBe(ERROR_ORDER_NOT_HUMAN);
    expect((await orderRow(roomId, orderId)).status).toBe('ACTIVE'); // unchanged
  });

  it('revoke is terminal; nothing can act on a revoked order', async () => {
    const roomId = await room('order-revoke');
    const created = await create(roomId, 'prince');
    const orderId = created.ok ? created.orderId! : '';
    expect((await control(roomId, 'prince', orderId, 'revoke')).ok).toBe(true);
    expect((await orderRow(roomId, orderId)).status).toBe('REVOKED');

    const resumeDead = await control(roomId, 'prince', orderId, 'resume');
    expect(resumeDead.ok).toBe(false);
    if (!resumeDead.ok) expect(resumeDead.refusal.code).toBe(ERROR_ORDER_BAD_STATE);
  });

  it('refuses control of an unknown order', async () => {
    const roomId = await room('order-unknown');
    const result = await control(roomId, 'prince', 'ord_nope', 'pause');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe(ERROR_ORDER_UNKNOWN);
  });
});
