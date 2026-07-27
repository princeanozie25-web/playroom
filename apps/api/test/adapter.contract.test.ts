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

// The room turns a streamed adapter into started → delta(s) → completed events,
// in order, with room sequence ids. Uses a fake adapter — no live provider call.
describe('agent turn contract', () => {
  let server: TestServer;
  const roomId = uniqueRoomId('agent-contract');

  beforeAll(async () => {
    const adapter = scriptedAdapter('claude-main', [
      { kind: 'text_delta', text: 'Hel' },
      { kind: 'text_delta', text: 'lo.' },
      { kind: 'done', tokens_in: 12, tokens_out: 3, stop_reason: 'end_turn' },
    ]);
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

  it('writes started → delta(s) → completed in order with ascending seqs', async () => {
    const c = new Client(`${server.wsBase}/rooms/${roomId}/ws`, server.token);
    await c.open();
    c.send('@claude hi', 'm1');
    await c.waitForType('agent.turn.completed');

    const agent = c.events.filter(
      (e): e is Extract<typeof e, { event_type: `agent.turn.${string}` }> =>
        e.event_type.startsWith('agent.turn'),
    );
    const kinds = agent.map((e) => e.event_type);
    expect(kinds[0]).toBe('agent.turn.started');
    expect(kinds.at(-1)).toBe('agent.turn.completed');
    expect(kinds.filter((k) => k === 'agent.turn.delta').length).toBe(2);

    const seqs = agent.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

    const completed = expectEvent(c.ofType('agent.turn.completed')[0], 'agent.turn.completed');
    expect(completed.payload.text).toBe('Hello.');
    expect(completed.payload.success).toBe(true);
    // every agent event shares the started turn's id
    const turnId = expectEvent(c.ofType('agent.turn.started')[0], 'agent.turn.started').payload
      .turn_id;
    expect(agent.every((e) => e.payload.turn_id === turnId)).toBe(true);

    c.close();
  });
});
