import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { buildServer } from '../src/server.js';

// The regression that lets the whole A4-F1 class recur. The server was built with
// `Fastify()` and no logger, so every `app.log.error` in the codebase wrote to
// nowhere: a foreign-key violation on the write path produced no event, no client
// error and no log line. Logging that has never been observed is indistinguishable
// from no logging, so this asserts emission against a real captured stream rather
// than trusting that a logger is configured.

function capture(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, stream };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('server logging', () => {
  it('actually emits an app.log.error, as structured JSON', async () => {
    const { lines, stream } = capture();
    const app = buildServer({ loggerStream: stream });
    try {
      app.log.error({ err: new Error('boom'), room_id: 'r1' }, 'send failed');
      await flush();

      expect(lines.length).toBeGreaterThan(0);
      const record = JSON.parse(lines.join('').trim().split('\n').pop() ?? '{}');
      expect(record.level).toBe(50); // pino: 50 = error
      expect(record.msg).toBe('send failed');
      expect(record.room_id).toBe('r1');
      expect(record.err?.message).toBe('boom');
    } finally {
      await app.close();
    }
  });

  it('emits at error level even under the test level (warn)', async () => {
    const { lines, stream } = capture();
    const app = buildServer({ loggerStream: stream });
    try {
      app.log.info({ noise: true }, 'chatter');
      app.log.error({ room_id: 'r2' }, 'the important one');
      await flush();

      const msgs = lines
        .join('')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l).msg);
      expect(msgs).toContain('the important one');
    } finally {
      await app.close();
    }
  });

  it('redacts credentials, at the top level and nested', async () => {
    const { lines, stream } = capture();
    const app = buildServer({ loggerStream: stream });
    try {
      app.log.error(
        {
          password: 'hunter2',
          api_key: 'sk-live-TOPLEVEL',
          config: { DATABASE_URL: 'postgres://u:pw@host/db', token: 'nested-TOKEN' },
        },
        'credential shapes',
      );
      await flush();

      const raw = lines.join('');
      expect(raw).not.toContain('hunter2');
      expect(raw).not.toContain('sk-live-TOPLEVEL');
      expect(raw).not.toContain('nested-TOKEN');
      expect(raw).not.toContain('postgres://');
      expect(raw).toContain('[redacted]');
    } finally {
      await app.close();
    }
  });
});
