import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  expectEvent,
  factoryFor,
  httpCreateRoom,
  scriptedAdapter,
  startTestServer,
  testPool,
  uniqueRoomId,
  type TestServer,
} from './support.js';

// §22b: only one in-flight turn per room; a second summon while streaming is
// rejected with an in-thread notice.
describe('one in-flight turn per room', () => {
  let server: TestServer;
  const roomId = uniqueRoomId('agent-inflight');

  beforeAll(async () => {
    // Slow adapter so the first turn is still streaming when the second arrives.
    const adapter = scriptedAdapter(
      'claude-main',
      [
        { kind: 'text_delta', text: 'slow ' },
        { kind: 'text_delta', text: 'reply' },
        { kind: 'done', tokens_in: 5, tokens_out: 5, stop_reason: 'end_turn' },
      ],
      { delayMs: 150 },
    );
    server = await startTestServer({ adapterFactory: factoryFor(adapter) });
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
  });

  afterAll(async () => {
    const pool = testPool();
    await pool.query('DELETE FROM events WHERE room_id = $1', [roomId]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
    await pool.end();
    await server.close();
  });

  it('rejects the second concurrent summon with a system notice', async () => {
    const c = new Client(`${server.wsBase}/rooms/${roomId}/ws`, server.token);
    await c.open();
    c.send('@claude one', 'a');
    c.send('@claude two', 'b');
    await c.waitForType('agent.turn.completed');
    await new Promise((r) => setTimeout(r, 300));

    // Exactly one turn ran.
    expect(c.ofType('agent.turn.started').length).toBe(1);
    // The rejected second summon posted one in-thread system notice.
    const notices = c.events.filter((e) => e.event_type === 'message' && e.actor_id === 'system');
    expect(notices.length).toBe(1);
    expect(expectEvent(notices[0], 'message').payload.body).toMatch(/already replying/);

    c.close();
  });
});
