import { describe, expect, it, afterAll } from 'vitest';
import { Writable } from 'node:stream';
import WebSocket from 'ws';
import { ServerErrorFrame, WS_CLOSE_ROOM_NOT_FOUND } from '@playroom/shared';
import { startTestServer, testPool, uniqueRoomId } from './support.js';

// A4-F1. A write to a room that does not exist used to be accepted by the socket,
// killed by the events→rooms foreign key, and reported to nobody — the client kept a
// connected indicator and a cleared input. Deny-by-default means refuse and say so.

const pool = testPool();
afterAll(async () => {
  await pool.end();
});

async function eventCount(roomId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    'SELECT count(*)::int AS n FROM events WHERE room_id = $1',
    [roomId],
  );
  return Number(rows[0].n);
}

describe('a room that does not exist', () => {
  it('refuses the socket with a typed frame and close 4404, and writes nothing', async () => {
    const server = await startTestServer();
    const ghost = uniqueRoomId('ghost');
    try {
      const ws = new WebSocket(`${server.wsBase}/rooms/${ghost}/ws?after=0`);
      const frames: unknown[] = [];
      const closed = new Promise<{ code: number }>((resolve) => {
        ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
        ws.on('close', (code) => resolve({ code }));
      });
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });

      // Send anyway — a real client would, and this is what used to vanish.
      ws.send(
        JSON.stringify({
          type: 'send',
          client_msg_id: 'f1-ghost-1',
          author: 'tester',
          body: 'does this land?',
        }),
      );

      const { code } = await closed;
      expect(code).toBe(WS_CLOSE_ROOM_NOT_FOUND);

      // An explicit refusal arrived, and it parses as the shared error frame —
      // no untyped ad-hoc shape, and never a `hello` implying the room is fine.
      const errors = frames.map((f) => ServerErrorFrame.safeParse(f)).filter((r) => r.success);
      expect(errors).toHaveLength(1);
      expect(errors[0].data?.code).toBe('room_not_found');
      expect(errors[0].data?.room_id).toBe(ghost);
      expect(frames.some((f) => (f as { type?: string }).type === 'hello')).toBe(false);

      expect(await eventCount(ghost)).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('refuses before the write is attempted — the foreign key is never reached', async () => {
    // The distinction that matters. Zero rows can mean "refused at the boundary" or
    // "attempted and rejected by the database". Only the first satisfies deny-by-
    // default; the second is the original bug with a logger bolted on. A send that
    // races the existence check must be gated, not caught by constraint 23503.
    const logs: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        logs.push(chunk.toString());
        cb();
      },
    });
    const server = await startTestServer({ loggerStream: stream });
    const ghost = uniqueRoomId('ghost-race');
    try {
      const ws = new WebSocket(`${server.wsBase}/rooms/${ghost}/ws?after=0`);
      const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      // Send in the same tick as open — the tightest race against the room check.
      ws.send(
        JSON.stringify({
          type: 'send',
          client_msg_id: 'f1-race-1',
          author: 'tester',
          body: 'racing the check',
        }),
      );
      await closed;
      await new Promise((r) => setTimeout(r, 150)); // let any stray write settle

      const raw = logs.join('');
      expect(raw).toContain('ws refused: room not found');
      expect(raw).not.toContain('23503');
      expect(raw).not.toContain('events_room_id_fkey');
      expect(raw).not.toContain('send failed');
      expect(await eventCount(ghost)).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('answers HTTP with a typed 404 and writes nothing', async () => {
    const server = await startTestServer();
    const ghost = uniqueRoomId('ghost-http');
    try {
      const res = await fetch(`${server.httpBase}/rooms/${ghost}`);
      expect(res.status).toBe(404);

      // Same shape as the WebSocket refusal: one refusal contract, two transports.
      const parsed = ServerErrorFrame.safeParse(await res.json());
      expect(parsed.success).toBe(true);
      expect(parsed.data?.code).toBe('room_not_found');
      expect(parsed.data?.room_id).toBe(ghost);

      expect(await eventCount(ghost)).toBe(0);
    } finally {
      await server.close();
    }
  });
});
