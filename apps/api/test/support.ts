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
import { ensureTask, taskCreatedEvent } from '../src/tasks.js';

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

/**
 * Delete a credential the suite issued — S12-N3.
 *
 * DELETED, NOT REVOKED, and the difference matters. Revocation is the PRODUCT's rotation
 * semantics: the row stays because it is the record that the secret existed, which is what makes
 * `revoked_at` mean anything. A test credential has nothing to be the record of. Every
 * `startTestServer` issued one and nothing ever removed it, so the test database had accumulated
 * 479 ACTIVE credentials for `prince` by the end of S1.2 — one per server start, across every
 * run since the table existed.
 *
 * Test-only, so it lives here rather than in `credentials.ts`: the product has no reason to
 * delete a credential, and giving it one would put a function next to `revokeCredential` whose
 * only difference is that it destroys the audit record.
 */
async function deleteTestCredential(id: string): Promise<void> {
  const pool = testPool();
  try {
    await pool.query('DELETE FROM member_credentials WHERE id = $1', [id]);
  } finally {
    await pool.end();
  }
}

/** How many credentials exist right now. For the assertion that they stop accumulating. */
export async function credentialCount(): Promise<number> {
  const pool = testPool();
  try {
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM member_credentials',
    );
    return Number(rows[0].n);
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
  // A REAL CREDENTIAL, CLEANED UP AFTER ITSELF (S12-N3). The suite already deletes the rooms
  // and events it creates; a credential is no different, and 479 of them proved it.
  const pool = testPool();
  let credential;
  try {
    credential = await issueCredential(pool, 'prince', 'test server');
  } finally {
    await pool.end();
  }

  return {
    httpBase: `http://127.0.0.1:${addr.port}`,
    wsBase: `ws://127.0.0.1:${addr.port}`,
    close: async () => {
      // Closed FIRST: a socket still authenticating against this credential while the row
      // disappears would fail for a reason that has nothing to do with what a test was asserting.
      await app.close();
      await deleteTestCredential(credential.id);
    },
    token: credential.token,
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

/**
 * Create a room the way a client does — with a credential, as of S1.3c (RT-002).
 *
 * The token is optional so a test can assert the refusal by omitting it; every ordinary call site
 * passes `server.token` and is otherwise unchanged.
 */
export async function httpCreateRoom(
  httpBase: string,
  id: string,
  token?: string,
): Promise<Response> {
  return fetch(`${httpBase}/rooms`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ id, title: id }),
  });
}

/**
 * Delegate a task to a member — the record that entitles a requester to name them as the subject
 * of a governed action (S12-N2, closed in S1.3).
 *
 * Built through the PRODUCT's own functions, row and event both, so a test's standing comes from
 * the same record the summon path writes. Inserting the row alone would create a task the log
 * cannot rebuild, which is precisely the drift `tasks.test.ts` exists to catch.
 *
 * The alternative for a test that needs standing is to tag a member and wait for a real turn,
 * which several suites do. This exists for the ones that must not: a suite with no injected
 * adapter would reach live providers.
 */
export async function delegateTask(
  pool: Pool,
  roomId: string,
  assignee: string,
  createdBy = 'prince',
): Promise<string> {
  const { task, created } = await ensureTask(pool, {
    roomId,
    assignee,
    state: 'working',
    action: null,
    intent: `standing for ${assignee}`,
    createdBy,
    causeSeq: 0,
  });
  if (created) await taskCreatedEvent(pool, task, createdBy);
  return task.id;
}

/**
 * Exchange a credential for a single-use socket ticket, the way every client now does (S1.3c).
 *
 * Exposed for the tests that drive a RAW socket — the refusal probes, which have to observe a
 * handshake being refused rather than have a helper throw it away.
 */
export async function mintTicket(httpBase: string, token: string, roomId: string): Promise<string> {
  const res = await fetch(`${httpBase}/ws-ticket`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ room_id: roomId }),
  });
  if (!res.ok) throw new Error(`ticket refused: HTTP ${res.status}`);
  return ((await res.json()) as { ticket: string }).ticket;
}

// A ws test client. Frames are zod-parsed on receipt (never cast), matching the
// wire-contract invariant; parsed events are recorded for assertions.
export class Client {
  readonly events: ServerEventT[] = [];
  readonly errors: ServerErrorFrameT[] = [];
  hello: number | undefined;
  /** The per-room spend baseline `hello` carried (S1.6). Undefined until the hello frame lands. */
  helloSpend: number | undefined;
  private readonly seen = new Set<number>();
  private waiters: Array<() => void> = [];

  private socket: WebSocket | null = null;
  private readonly url: string;
  private readonly token: string;

  /**
   * @param url the room's ws URL.
   * @param token the member credential. THE SOCKET NEVER SEES IT: as of S1.3c the credential is
   *   exchanged for a single-use ticket at `POST /ws-ticket`, and the ticket is what travels in
   *   the query string.
   *
   * Nothing connects here. The exchange is asynchronous and `open()` is where the suite already
   * awaits, so that is where it goes — every call site reads exactly as it did, and every test
   * still starts from a real credential and walks the real path. A test helper that skipped the
   * exchange would be the test-only door S1.2 was written to remove.
   */
  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  /** The socket, once open. Throws rather than returning a half-built one. */
  get ws(): WebSocket {
    if (!this.socket)
      throw new Error('Client.open() has not been awaited — there is no socket yet');
    return this.socket;
  }

  /**
   * Exchange the credential for a ticket, connect, and wait for the socket to open.
   *
   * Idempotent: a second call resolves against the socket already open, because several suites
   * call `open()` after constructing and then again defensively.
   */
  async open(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return;

    const roomId = decodeURIComponent(this.url.split('/rooms/')[1].split('/ws')[0]);
    const httpBase = this.url.replace(/^ws/, 'http').split('/rooms/')[0];
    const res = await fetch(`${httpBase}/ws-ticket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ room_id: roomId }),
    });
    if (!res.ok) throw new Error(`ticket refused: HTTP ${res.status}`);
    const { ticket } = (await res.json()) as { ticket: string };

    const ws = new WebSocket(`${this.url}${this.url.includes('?') ? '&' : '?'}ticket=${ticket}`);
    this.socket = ws;
    ws.on('message', (data) => {
      const raw = JSON.parse(data.toString());
      if (raw?.type === 'hello') {
        const h = ServerHello.parse(raw);
        this.hello = h.last_seq;
        this.helloSpend = h.room_spent_usd;
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

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
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

  /**
   * Hand a task to another member (S1.3).
   *
   * The frame a host sidecar sends. There is no UI for it — the composer only sends chat — so
   * this is the same standing-in the film's harness does for `request_action`.
   */
  handoff(taskId: string, toMember: string, action: string, clientMsgId = `ho-${taskId}`): void {
    this.ws.send(
      JSON.stringify({
        type: 'handoff',
        client_msg_id: clientMsgId,
        task_id: taskId,
        to_member: toMember,
        action,
      }),
    );
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
