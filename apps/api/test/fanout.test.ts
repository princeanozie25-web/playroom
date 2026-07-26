import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  httpCreateRoom,
  startTestServer,
  testPool,
  uniqueRoomId,
  type TestServer,
} from './support.js';

describe('fan-out', () => {
  let server: TestServer;
  const roomId = uniqueRoomId('fanout');

  beforeAll(async () => {
    server = await startTestServer();
    const res = await httpCreateRoom(server.httpBase, roomId);
    expect(res.status).toBe(201);
  });

  afterAll(async () => {
    const pool = testPool();
    await pool.query('DELETE FROM events WHERE room_id = $1', [roomId]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
    await pool.end();
    await server.close();
  });

  it("delivers A's three sends to B in seq order", async () => {
    const a = new Client(`${server.wsBase}/rooms/${roomId}/ws`, server.token);
    const b = new Client(`${server.wsBase}/rooms/${roomId}/ws`, server.token);
    await Promise.all([a.open(), b.open()]);

    a.send('one', 'm1');
    a.send('two', 'm2');
    a.send('three', 'm3');

    await b.waitForEvents(3);
    expect(b.bodies()).toEqual(['one', 'two', 'three']);

    const seqs = b.seqs();
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y)); // strictly ascending

    a.close();
    b.close();
  });
});
