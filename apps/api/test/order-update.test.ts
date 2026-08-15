import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentTurnChunk } from '@playroom/shared';
import { testPool, uniqueRoomId } from './support.js';
import { RoomBus } from '../src/bus.js';
import { createRoom } from '../src/events.js';
import { executeCommand, type CommandDeps } from '../src/commands/index.js';

/**
 * ═══ S-UI3 — THE ORDER-UPDATE COMMAND: a narrow, creator-only, evented edit ═══
 *
 * The form over the record needs to edit an order after creation — but only its CADENCE (the dial,
 * the cycle cap, the expiry), never its WIRING (trigger, action, members). The immutable half is
 * enforced by absence: there is no parameter for it. Creator-only, agents refused, every edit an
 * order.updated event carrying before + after, effective next cycle (it never touches the counts).
 */

const pool = testPool();
const rooms: string[] = [];

function replier(id: string): AgentAdapter {
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
    adapterFactory: (id) => replier(id),
    execute: (ctx, command) => executeCommand(ctx, command, deps),
  };
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

afterAll(async () => {
  await pool.end();
});

async function makeOrder(prefix: string): Promise<{ roomId: string; orderId: string }> {
  const roomId = uniqueRoomId(prefix);
  rooms.push(roomId);
  await createRoom(pool, roomId, roomId, 'prince');
  const created = await executeCommand(
    { actorId: 'prince', mode: 'human' },
    {
      kind: 'createOrder',
      roomId,
      clientMsgId: `oc-${prefix}`,
      triggerEventType: 'agent.turn.completed',
      triggerMember: 'sol',
      actionMember: 'claude-main',
      task: 'draft, then hand back for review',
      maxCycles: null,
      maxUnattendedCycles: 3,
      expiresAt: null,
    },
    deps,
  );
  if (!created.ok) throw new Error('order not created');
  return { roomId, orderId: created.orderId! };
}

function edit(
  actorId: string,
  roomId: string,
  orderId: string,
  terms: { maxCycles?: number | null; maxUnattendedCycles?: number; expiresAt?: string | null },
) {
  return executeCommand(
    { actorId, mode: actorId === 'claude-main' ? 'hosted' : 'human' },
    {
      kind: 'updateOrder',
      roomId,
      clientMsgId: `edit-${Date.now()}-${Math.round(performance.now())}`,
      orderId,
      maxCycles: terms.maxCycles ?? null,
      maxUnattendedCycles: terms.maxUnattendedCycles ?? 3,
      expiresAt: terms.expiresAt ?? null,
    },
    deps,
  );
}

interface OrderRow {
  status: string;
  max_cycles: number | null;
  max_unattended_cycles: number;
  expires_at: Date | null;
  cycle_count: number;
  unattended_count: number;
  trigger_member_id: string;
  action_member_id: string;
}
async function orderRow(roomId: string, orderId: string): Promise<OrderRow> {
  const { rows } = await pool.query<OrderRow>(
    `SELECT status, max_cycles, max_unattended_cycles, expires_at, cycle_count, unattended_count,
            trigger_member_id, action_member_id
       FROM standing_orders WHERE id = $1 AND room_id = $2`,
    [orderId, roomId],
  );
  return rows[0];
}

interface UpdatedPayload {
  order_id: string;
  before: { max_cycles: number | null; max_unattended_cycles: number; expires_at: string | null };
  after: { max_cycles: number | null; max_unattended_cycles: number; expires_at: string | null };
  actor: string;
}
async function updatedEvents(roomId: string, orderId: string): Promise<UpdatedPayload[]> {
  const { rows } = await pool.query<{ payload: UpdatedPayload }>(
    `SELECT payload FROM events
      WHERE room_id = $1 AND event_type = 'order.updated' AND payload ->> 'order_id' = $2 ORDER BY seq`,
    [roomId, orderId],
  );
  return rows.map((r) => r.payload);
}

describe('the creator edits the cadence, and the log carries before + after', () => {
  it('changes the dial, the cap and the expiry — evented, and the wiring untouched', async () => {
    const { roomId, orderId } = await makeOrder('edit-ok');
    const expiry = '2027-01-01T00:00:00.000Z';
    const res = await edit('prince', roomId, orderId, {
      maxUnattendedCycles: 5,
      maxCycles: 10,
      expiresAt: expiry,
    });
    expect(res.ok).toBe(true);

    const row = await orderRow(roomId, orderId);
    expect(row.max_unattended_cycles).toBe(5);
    expect(row.max_cycles).toBe(10);
    expect(row.expires_at?.toISOString()).toBe(expiry);
    // THE WIRING IS UNTOUCHED — there was no parameter that could have changed it.
    expect(row.trigger_member_id).toBe('sol');
    expect(row.action_member_id).toBe('claude-main');
    // AND THE COUNTS ARE UNTOUCHED — an edit is not a resume, so it resets no streak.
    expect(row.cycle_count).toBe(0);
    expect(row.unattended_count).toBe(0);

    const events = await updatedEvents(roomId, orderId);
    expect(events).toHaveLength(1);
    expect(events[0].before).toEqual({
      max_cycles: null,
      max_unattended_cycles: 3,
      expires_at: null,
    });
    expect(events[0].after).toEqual({
      max_cycles: 10,
      max_unattended_cycles: 5,
      expires_at: expiry,
    });
    expect(events[0].actor).toBe('prince');
  });
});

describe('what the update refuses', () => {
  it('an AGENT may not edit — the load-bearing refusal, same as create', async () => {
    const { roomId, orderId } = await makeOrder('edit-agent');
    const res = await edit('claude-main', roomId, orderId, { maxUnattendedCycles: 9 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.refusal.code).toBe('order_not_human');
    expect((await orderRow(roomId, orderId)).max_unattended_cycles).toBe(3); // unchanged
    expect(await updatedEvents(roomId, orderId)).toHaveLength(0);
  });

  it('a non-creator human may not edit — only the creator, matching resume/revoke', async () => {
    const { roomId, orderId } = await makeOrder('edit-noncreator');
    const res = await edit('jerry', roomId, orderId, { maxUnattendedCycles: 9 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.refusal.code).toBe('order_not_creator');
    expect((await orderRow(roomId, orderId)).max_unattended_cycles).toBe(3);
  });

  it('a TERMINAL order cannot be edited — its terms are frozen', async () => {
    const { roomId, orderId } = await makeOrder('edit-terminal');
    const revoked = await executeCommand(
      { actorId: 'prince', mode: 'human' },
      { kind: 'controlOrder', roomId, clientMsgId: 'rev-1', orderId, op: 'revoke' },
      deps,
    );
    expect(revoked.ok).toBe(true);
    const res = await edit('prince', roomId, orderId, { maxUnattendedCycles: 9 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.refusal.code).toBe('order_bad_state');
  });

  it('an out-of-range value is refused — the dial below 1, a non-positive cap', async () => {
    const { roomId, orderId } = await makeOrder('edit-invalid');
    const dial = await edit('prince', roomId, orderId, { maxUnattendedCycles: 0 });
    expect(dial.ok).toBe(false);
    if (!dial.ok) expect(dial.refusal.code).toBe('order_invalid_config');

    const cap = await edit('prince', roomId, orderId, { maxUnattendedCycles: 3, maxCycles: 0 });
    expect(cap.ok).toBe(false);
    if (!cap.ok) expect(cap.refusal.code).toBe('order_invalid_config');

    // The order is untouched by a refused edit.
    const row = await orderRow(roomId, orderId);
    expect(row.max_unattended_cycles).toBe(3);
    expect(row.max_cycles).toBeNull();
  });
});
