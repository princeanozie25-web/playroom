import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  factoryFor,
  httpCreateRoom,
  scriptedAdapter,
  startTestServer,
  testPool,
  uniqueRoomId,
  type TestServer,
} from './support.js';

// §22a: a message authored by an agent (its id is a known adapter id) must never
// summon an agent — no agent-to-agent loop is possible.
describe('agent loop guard', () => {
  let server: TestServer;
  const roomId = uniqueRoomId('agent-loop');

  beforeAll(async () => {
    // If a summon wrongly fired, this adapter would emit detectable agent events.
    const adapter = scriptedAdapter('claude-main', [
      { kind: 'text_delta', text: 'should not run' },
      { kind: 'done', tokens_in: 1, tokens_out: 1, stop_reason: 'end_turn' },
    ]);
    server = await startTestServer({ adapterFactory: factoryFor(adapter) });
    expect((await httpCreateRoom(server.httpBase, roomId)).status).toBe(201);
  });

  afterAll(async () => {
    const pool = testPool();
    await pool.query('DELETE FROM events WHERE room_id = $1', [roomId]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
    await pool.end();
    await server.close();
  });

  it('does not summon on an agent-authored @claude message', async () => {
    const c = new Client(`${server.wsBase}/rooms/${roomId}/ws`);
    await c.open();
    // author === 'claude-main' → an agent actor.
    c.send('@claude please loop', 'loop-1', 'claude-main');
    await c.waitForEvents(1); // the message itself lands
    await new Promise((r) => setTimeout(r, 800)); // give any (wrong) summon time to fire

    const agent = c.events.filter((e) => e.event_type.startsWith('agent.turn'));
    expect(agent.length).toBe(0);

    c.close();
  });
});
