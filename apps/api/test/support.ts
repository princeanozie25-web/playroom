import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { ServerEvent, ServerHello, type ServerEvent as ServerEventT } from '@playroom/shared';
import { loadRootEnv } from '../src/env.js';
import { buildServer } from '../src/server.js';
import { makePool } from '../src/db.js';

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
}

export async function startTestServer(): Promise<TestServer> {
  const app = buildServer({ databaseUrl: testDbUrl() });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as AddressInfo;
  return {
    httpBase: `http://127.0.0.1:${addr.port}`,
    wsBase: `ws://127.0.0.1:${addr.port}`,
    close: () => app.close(),
  };
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
  hello: number | undefined;
  private readonly seen = new Set<number>();
  private waiters: Array<() => void> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data) => {
      const raw = JSON.parse(data.toString());
      if (raw?.type === 'hello') {
        this.hello = ServerHello.parse(raw).last_seq;
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

  send(body: string, clientMsgId: string, author = 'tester'): void {
    this.ws.send(JSON.stringify({ type: 'send', client_msg_id: clientMsgId, author, body }));
  }

  seqs(): number[] {
    return this.events.map((e) => e.seq);
  }

  bodies(): string[] {
    return this.events.map((e) => e.payload.body);
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

  terminate(): void {
    this.ws.terminate();
  }

  close(): void {
    this.ws.close();
  }
}
