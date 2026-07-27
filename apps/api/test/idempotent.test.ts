import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  httpCreateRoom,
  startTestServer,
  testPool,
  uniqueRoomId,
  type TestServer,
} from './support.js';

describe('idempotent sends', () => {
  let server: TestServer;
  const roomId = uniqueRoomId('idempotent');

  beforeAll(async () => {
    server = await startTestServer();
    const res = await httpCreateRoom(server.httpBase, roomId, server.token);
    expect(res.status).toBe(201);
  });

  afterAll(async () => {
    const pool = testPool();
    await pool.query('DELETE FROM events WHERE room_id = $1', [roomId]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
    await pool.end();
    await server.close();
  });

  it('collapses a repeated client_msg_id to one row and one seq', async () => {
    const a = new Client(`${server.wsBase}/rooms/${roomId}/ws`, server.token);
    await a.open();

    a.send('hello', 'dup-1');
    await a.waitForEvents(1);
    const firstSeq = a.events[0].seq;

    // Same client_msg_id again — a duplicate that must not create a new event.
    a.send('hello again — should be ignored', 'dup-1');
    await new Promise((r) => setTimeout(r, 800));

    const pool = testPool();
    const { rows } = await pool.query(
      'SELECT seq FROM events WHERE room_id = $1 AND client_msg_id = $2',
      [roomId, 'dup-1'],
    );
    await pool.end();

    // Exactly one persisted row, at the original seq.
    expect(rows.length).toBe(1);
    expect(Number(rows[0].seq)).toBe(firstSeq);
    // Every frame the client saw carries that same seq — the second ack is the
    // same event, never a new one.
    expect(new Set(a.seqs())).toEqual(new Set([firstSeq]));

    a.close();
  });
});
