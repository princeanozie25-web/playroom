import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admitToRoom,
  httpCreateRoom,
  issueTestCredential,
  startTestServer,
  testPool,
  uniqueRoomId,
  type TestServer,
} from './support.js';

/**
 * ═══ S-UI3 — THE STANDING-ORDER HTTP ROUTES: the loops screen's read + writes ═══
 *
 * The screen reads and steers orders over HTTP. Two properties matter and are asserted here:
 *   1. EVERY WRITE GOES THROUGH executeCommand, so the same refusals the WS frames get come back as
 *      HTTP statuses — an agent's credential creating an order is a 403, not a success.
 *   2. EVERY ROUTE IS MEMBERSHIP-SCOPED like GET /members: a non-member gets what a missing room
 *      gives, so orders cannot be read or steered across rooms the caller is not in.
 */

const pool = testPool();
let server: TestServer;
const roomId = uniqueRoomId('order-routes');

beforeAll(async () => {
  server = await startTestServer();
  expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
  // ADR-009: createRoom enrols only the creator; admit the agents the order wires together
  // (trigger `sol`, action `claude-main`) so the POST create passes its member check. The outsider
  // case below removes and restores `sol` itself, so this admission does not affect it.
  await admitToRoom(roomId, 'sol', 'claude-main');
});

afterAll(async () => {
  await pool.query('DELETE FROM standing_orders WHERE room_id = $1', [roomId]);
  await pool.query('DELETE FROM events WHERE room_id = $1', [roomId]);
  await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
  await pool.end();
  await server.close();
});

function api(path: string, init: RequestInit = {}, token = server.token): Promise<Response> {
  return fetch(`${server.httpBase}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
}

describe('the loops screen reads and steers orders over HTTP', () => {
  let orderId = '';

  it('POST creates an order (201), and GET lists it from records + events', async () => {
    const create = await api(`/rooms/${roomId}/orders`, {
      method: 'POST',
      body: JSON.stringify({
        trigger_event_type: 'agent.turn.completed',
        trigger_member: 'sol',
        action_member: 'claude-main',
        task: 'review the newest draft and say what you would cut',
        max_unattended_cycles: 3,
        // S-DIAL: a dial above 1 needs an end. Generous, so nothing else about this case changes.
        max_cycles: 50,
      }),
    });
    expect(create.status).toBe(201);
    orderId = ((await create.json()) as { order_id: string }).order_id;
    expect(orderId).toMatch(/^ord_/);

    const list = await api(`/rooms/${roomId}/orders`);
    expect(list.status).toBe(200);
    const { orders } = (await list.json()) as {
      orders: Array<{
        id: string;
        status: string;
        cycle_count: number;
        last_fired: string | null;
        action_member_id: string;
        max_unattended_cycles: number;
      }>;
    };
    const row = orders.find((o) => o.id === orderId)!;
    expect(row.status).toBe('ACTIVE');
    expect(row.cycle_count).toBe(0);
    expect(row.last_fired).toBeNull(); // never fired — reconstructed from the absent order.cycled
    expect(row.action_member_id).toBe('claude-main');
    expect(row.max_unattended_cycles).toBe(3);
  });

  it('POST /control pauses it, and PATCH edits the dial — both through the command', async () => {
    const paused = await api(`/rooms/${roomId}/orders/${orderId}/control`, {
      method: 'POST',
      body: JSON.stringify({ op: 'pause' }),
    });
    expect(paused.status).toBe(200);

    const edited = await api(`/rooms/${roomId}/orders/${orderId}`, {
      method: 'PATCH',
      // Raising the dial AND keeping a cap: S-DIAL refuses a raised dial with neither bound.
      body: JSON.stringify({ max_unattended_cycles: 5, max_cycles: 25 }),
    });
    expect(edited.status).toBe(200);

    const list = await api(`/rooms/${roomId}/orders`);
    const row = ((await list.json()) as { orders: Array<Record<string, unknown>> }).orders.find(
      (o) => o.id === orderId,
    )!;
    expect(row.status).toBe('PAUSED');
    expect(row.max_unattended_cycles).toBe(5);
  });

  it('an AGENT credential creating an order is refused 403 — the command, not the route', async () => {
    const agentToken = await issueTestCredential('claude-main', 'order-routes-agent');
    const res = await api(
      `/rooms/${roomId}/orders`,
      {
        method: 'POST',
        body: JSON.stringify({
          trigger_event_type: 'agent.turn.completed',
          trigger_member: 'sol',
          action_member: 'claude-main',
          task: 'review the newest draft and say what you would cut',
        }),
      },
      agentToken,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('order_not_human');
    await pool.query("DELETE FROM member_credentials WHERE label = 'order-routes-agent'");
  });

  it('unauthenticated is 401; a non-member gets exactly what a missing room gives (404)', async () => {
    expect((await fetch(`${server.httpBase}/rooms/${roomId}/orders`)).status).toBe(401);

    // A legitimate credential holder who is NOT in this room — same silence as GET /members.
    const solToken = await issueTestCredential('sol', 'order-routes-outsider');
    await pool.query('DELETE FROM room_members WHERE room_id = $1 AND member_id = $2', [
      roomId,
      'sol',
    ]);
    const outsider = await api(`/rooms/${roomId}/orders`, {}, solToken);
    const ghost = await api(`/rooms/no-such-room-at-all/orders`, {}, solToken);
    expect(outsider.status).toBe(404);
    expect(ghost.status).toBe(404);
    await pool.query("DELETE FROM member_credentials WHERE label = 'order-routes-outsider'");
    await pool.query('INSERT INTO room_members (room_id, member_id) VALUES ($1, $2)', [
      roomId,
      'sol',
    ]);
  });
});
