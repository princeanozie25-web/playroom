import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  httpCreateRoom,
  startTestServer,
  testPool,
  uniqueRoomId,
  type TestServer,
} from './support.js';

// The slice exit test: a socket dies mid-stream, more events land while it is
// gone, and on reconnect with ?after=<last seq> the client gets exactly what it
// missed — no gap, no duplicate.
describe('resume-from-last-id', () => {
  let server: TestServer;
  const roomId = uniqueRoomId('resume');

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

  it('reconnects with ?after and receives exactly the missed events', async () => {
    const a = new Client(`${server.wsBase}/rooms/${roomId}/ws`, server.token);
    const b1 = new Client(`${server.wsBase}/rooms/${roomId}/ws`, server.token);
    await Promise.all([a.open(), b1.open()]);

    // B receives event 1.
    a.send('first', 'r1');
    await b1.waitForEvents(1);
    const lastSeen = b1.events[0].seq;

    // B's socket is killed mid-stream (abrupt drop, not a clean close).
    b1.terminate();

    // A sends two more while B is gone; wait until A has seen all three itself,
    // which proves 2 and 3 are persisted.
    a.send('second', 'r2');
    a.send('third', 'r3');
    await a.waitForEvents(3);

    // B reconnects from the last seq it saw.
    const b2 = new Client(`${server.wsBase}/rooms/${roomId}/ws?after=${lastSeen}`, server.token);
    await b2.open();
    await b2.waitForEvents(2);

    // No duplicate.
    const seen = new Set<number>();
    for (const e of b2.events) {
      expect(seen.has(e.seq)).toBe(false);
      seen.add(e.seq);
    }
    // No gap: exactly the two missed events, in order, all past the last seen seq.
    expect(b2.bodies()).toEqual(['second', 'third']);
    expect(b2.events.every((e) => e.seq > lastSeen)).toBe(true);

    a.close();
    b2.close();
  });
});
