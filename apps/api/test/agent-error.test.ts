import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  expectEvent,
  factoryFor,
  httpCreateRoom,
  startTestServer,
  testPool,
  throwingAdapter,
  uniqueRoomId,
  type TestServer,
} from './support.js';

// §24: an adapter failure is written as completed{success:false} with an
// error_class and surfaced in-thread — the room is never left silently hanging.
describe('agent error handling', () => {
  let server: TestServer;
  const roomId = uniqueRoomId('agent-error');

  beforeAll(async () => {
    server = await startTestServer({
      adapterFactory: factoryFor(throwingAdapter('claude-main', 'provider exploded')),
    });
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
  });

  afterAll(async () => {
    const pool = testPool();
    await pool.query('DELETE FROM events WHERE room_id = $1', [roomId]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
    await pool.end();
    await server.close();
  });

  it('emits completed{success:false} with an error_class, no hang', async () => {
    const c = new Client(`${server.wsBase}/rooms/${roomId}/ws`, server.token);
    await c.open();
    c.send('@claude boom', 'err-1');
    await c.waitForType('agent.turn.completed');

    const completed = expectEvent(c.ofType('agent.turn.completed')[0], 'agent.turn.completed');
    expect(completed.payload.success).toBe(false);
    expect(completed.payload.error_class).toBeTruthy();

    const pool = testPool();
    const { rows } = await pool.query(
      `SELECT success, error_class FROM events
       WHERE room_id = $1 AND event_type = 'agent.turn.completed'`,
      [roomId],
    );
    await pool.end();
    expect(rows[0].success).toBe(false);
    expect(rows[0].error_class).toBeTruthy();

    c.close();
  });
});
