import { Pool } from 'pg';
import WebSocket from 'ws';
import {
  ServerEvent,
  ServerHello,
  ServerErrorFrame,
  type ServerErrorFrame as ServerErrorFrameT,
  type AgentAdapter,
  type AgentTurnChunk,
  type ServerEvent as ServerEventT,
} from '@playroom/shared';
import { loadRootEnv } from '../src/env.js';
import { buildServer } from '../src/server.js';
import { makePool } from '../src/db.js';
import { issueCredential } from '../src/credentials.js';

loadRootEnv();

export function testDbUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required for integration tests');
  return url;
}

export function testPool(): Pool {
  return makePool(testDbUrl());
}

export function uniqueRoomId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

export interface TestServer {
  httpBase: string;
  wsBase: string;
  close: () => Promise<void>;
  /**
   * A real credential for `prince`, issued against the test database.
   *
   * NOT A BYPASS. Every test connects through the same handshake the product uses, because a
   * test-only path around authentication is the thing S1.2 exists to remove — and a suite that
   * skips the handshake proves nothing about the server a viewer is talking to.
   */
  token: string;
}

/** Issue a credential against the test database, for a suite that needs its own. */
export async function issueTestCredential(memberId: string, label = 'test'): Promise<string> {
  const pool = testPool();
  try {
    return (await issueCredential(pool, memberId, label)).token;
  } finally {
    await pool.end();
  }
}

export async function startTestServer(
  opts: {
    adapterFactory?: (id: string) => AgentAdapter;
    // Capture the server's log output so a test can assert what was — and was not —
    // emitted (A4-F1: an unobserved logger is the same as no logger).
    loggerStream?: NodeJS.WritableStream;
    logLevel?: string;
  } = {},
): Promise<TestServer> {
  const app = buildServer({
    databaseUrl: testDbUrl(),
    adapterFactory: opts.adapterFactory,
    loggerStream: opts.loggerStream,
    logLevel: opts.logLevel,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  // Narrow, don't cast: a port-0 TCP listen returns an AddressInfo object, never
  // a string (that's for pipes/UDS) and never null (we just listened).
  const addr = app.server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('expected an AddressInfo from a TCP listen');
  }
  return {
    httpBase: `http://127.0.0.1:${addr.port}`,
    wsBase: `ws://127.0.0.1:${addr.port}`,
    close: () => app.close(),
    token: await issueTestCredential('prince', 'test server'),
  };
}

// A fake AgentAdapter that yields a scripted list of AgentTurnChunks — no live
// provider call ever happens in the test suite.
export function scriptedAdapter(
  id: string,
  chunks: AgentTurnChunk[],
  opts: { delayMs?: number } = {},
): AgentAdapter {
  return {
    id,
    async *stream() {
      for (const chunk of chunks) {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        yield chunk;
      }
    },
  };
}

// A fake adapter whose stream throws — exercises the error path. `async *` alone
// makes this a generator, so it needs no yield; the first pull throws.
export function throwingAdapter(id: string, message = 'boom'): AgentAdapter {
  return {
    id,
    async *stream(): AsyncGenerator<AgentTurnChunk> {
      throw new Error(message);
    },
  };
}

export function factoryFor(adapter: AgentAdapter): (id: string) => AgentAdapter {
  return () => adapter;
}

export async function httpCreateRoom(httpBase: string, id: string): Promise<Response> {
  return fetch(`${httpBase}/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, title: id }),
  });
}

// A ws test client. Frames are zod-parsed on receipt (never cast), matching the
// wire-contract invariant; parsed events are recorded for assertions.
export class Client {
  readonly ws: WebSocket;
  readonly events: ServerEventT[] = [];
  readonly errors: ServerErrorFrameT[] = [];
  hello: number | undefined;
  private readonly seen = new Set<number>();
  private waiters: Array<() => void> = [];

  /**
   * @param token the member credential this connection authenticates as. Required, because the
   *   handshake refuses a socket without one — there is no unauthenticated path to exercise.
   */
  constructor(url: string, token: string) {
    this.ws = new WebSocket(`${url}${url.includes('?') ? '&' : '?'}token=${token}`);
    this.ws.on('message', (data) => {
      const raw = JSON.parse(data.toString());
      if (raw?.type === 'hello') {
        this.hello = ServerHello.parse(raw).last_seq;
      } else if (raw?.type === 'error') {
        // REFUSALS ARE COLLECTED, not discarded. A helper that drops them makes every
        // refusal look like silence from the test's point of view, which is the observation
        // this codebase spends most of its guards trying to avoid producing.
        this.errors.push(ServerErrorFrame.parse(raw));
      } else if (raw?.type === 'event') {
        // Delivery is at-least-once; dedupe on seq, exactly as a real client must.
        const event = ServerEvent.parse(raw);
        if (!this.seen.has(event.seq)) {
          this.seen.add(event.seq);
          this.events.push(event);
        }
      }
      const w = this.waiters;
      this.waiters = [];
      w.forEach((fn) => fn());
    });
  }

  async open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  /**
   * Send a message.
   *
   * THERE IS NO AUTHOR PARAMETER, and its absence is the exit criterion. It used to accept one
   * and put it on the frame; the frame has no such field now, so a test cannot author as
   * someone else any more than a caller can. Tests that need a different actor connect with a
   * different credential.
   */
  send(body: string, clientMsgId: string): void {
    this.ws.send(JSON.stringify({ type: 'send', client_msg_id: clientMsgId, body }));
  }

  seqs(): number[] {
    return this.events.map((e) => e.seq);
  }

  bodies(): string[] {
    // Only message events carry a body; narrow to them (never read `body` off an
    // agent-turn payload). Every caller drives a message-only stream, so this is
    // the same array the old union-wide map produced — just type-checked.
    return this.events
      .filter(
        (e): e is Extract<ServerEventT, { event_type: 'message' }> => e.event_type === 'message',
      )
      .map((e) => e.payload.body);
  }

  async waitForEvents(count: number, timeoutMs = 15000): Promise<void> {
    const start = Date.now();
    while (this.events.length < count) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out waiting for ${count} events (have ${this.events.length})`);
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 50);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  ofType(eventType: string): ServerEventT[] {
    return this.events.filter((e) => e.event_type === eventType);
  }

  async waitForType(eventType: string, timeoutMs = 15000): Promise<void> {
    const start = Date.now();
    while (this.ofType(eventType).length === 0) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out waiting for event_type ${eventType}`);
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 50);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  /**
   * Wait for a refusal frame matching a predicate.
   *
   * Takes a predicate rather than a count because a test usually cares WHICH refusal arrived,
   * and asserting on `errors[0]` after a bare wait makes the test order-dependent on frames
   * the server is free to reorder.
   */
  async waitForError(
    match: (e: ServerErrorFrameT) => boolean,
    timeoutMs = 10000,
  ): Promise<ServerErrorFrameT> {
    const start = Date.now();
    for (;;) {
      const hit = this.errors.find(match);
      if (hit) return hit;
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `timed out waiting for a refusal (have ${this.errors.map((e) => e.code).join(', ') || 'none'})`,
        );
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 50);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  terminate(): void {
    this.ws.terminate();
  }

  close(): void {
    this.ws.close();
  }
}

// Shared narrowing helper for the ServerEvent discriminated union. A type
// predicate — not a cast — does the narrowing, so member payload fields are
// type-checked rather than asserted away. Throws if the row is the wrong
// variant: a test asking for the wrong event_type is a test bug, not a soft miss.
function isEventType<T extends ServerEventT['event_type']>(
  row: ServerEventT,
  eventType: T,
): row is Extract<ServerEventT, { event_type: T }> {
  return row.event_type === eventType;
}

export function expectEvent<T extends ServerEventT['event_type']>(
  row: ServerEventT,
  eventType: T,
): Extract<ServerEventT, { event_type: T }> {
  if (!isEventType(row, eventType)) {
    throw new Error(`expected event_type ${eventType}, got ${row.event_type}`);
  }
  return row;
}
