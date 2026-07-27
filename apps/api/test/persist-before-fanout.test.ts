import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  httpCreateRoom,
  startTestServer,
  testPool,
  uniqueRoomId,
  type TestServer,
} from './support.js';

// §8 ordering law: an event must be committed to Postgres before it is fanned
// out. So the instant a client receives it, an independent SQL SELECT must
// already find it.
describe('persist-before-fanout', () => {
  let server: TestServer;
  const roomId = uniqueRoomId('pbf');

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

  it('finds the event committed the moment a client receives it', async () => {
    const pool = testPool();
    const a = new Client(`${server.wsBase}/rooms/${roomId}/ws`, server.token);
    const b = new Client(`${server.wsBase}/rooms/${roomId}/ws`, server.token);
    await Promise.all([a.open(), b.open()]);

    a.send('committed?', 'pbf-1');
    await b.waitForEvents(1);
    const seq = b.events[0].seq;

    const { rows } = await pool.query('SELECT seq FROM events WHERE room_id = $1 AND seq = $2', [
      roomId,
      seq,
    ]);
    await pool.end();

    expect(rows.length).toBe(1);

    a.close();
    b.close();
  });
});
