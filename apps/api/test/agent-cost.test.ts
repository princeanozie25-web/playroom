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

// §24: a completed turn carries cost and a prompt hash in the events row.
describe('agent cost + telemetry', () => {
  let server: TestServer;
  const roomId = uniqueRoomId('agent-cost');

  beforeAll(async () => {
    const adapter = scriptedAdapter('claude-main', [
      { kind: 'text_delta', text: 'costed reply' },
      { kind: 'done', tokens_in: 10, tokens_out: 20, stop_reason: 'end_turn' },
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

  it('records adapter_id, tokens, cost_usd and prompt_hash on completion', async () => {
    const c = new Client(`${server.wsBase}/rooms/${roomId}/ws`);
    await c.open();
    c.send('@claude cost please', 'cost-1', 'bob');
    await c.waitForType('agent.turn.completed');

    const pool = testPool();
    const { rows } = await pool.query(
      `SELECT adapter_id, tokens_in, tokens_out, cost_usd, prompt_hash, success
       FROM events WHERE room_id = $1 AND event_type = 'agent.turn.completed'`,
      [roomId],
    );
    await pool.end();

    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.adapter_id).toBe('claude-main');
    expect(Number(row.tokens_in)).toBe(10);
    expect(Number(row.tokens_out)).toBe(20);
    expect(row.cost_usd).not.toBeNull();
    expect(Number(row.cost_usd)).toBeGreaterThan(0);
    expect(row.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.success).toBe(true);

    c.close();
  });
});
