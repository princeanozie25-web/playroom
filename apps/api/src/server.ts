import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import {
  PLAYROOM_VERSION,
  ClientFrame,
  ServerHello,
  ServerErrorFrame,
  ERROR_ROOM_NOT_FOUND,
  WS_CLOSE_ROOM_NOT_FOUND,
  type AgentAdapter,
  type ServerEvent,
} from '@playroom/shared';
import { createAdapter } from '@playroom/adapters';
import type { Pool } from 'pg';
import { makePool } from './db.js';
import { RoomBus } from './bus.js';
import { eventsAfter, getRoom, lastSeq } from './events.js';
import { executeCommand, type CommandDeps } from './commands/index.js';
import { warmUp } from './warmup.js';

export interface BuildOptions {
  databaseUrl?: string;
  // Injectable so tests drive turns with a fake adapter — no live provider calls.
  adapterFactory?: (id: string) => AgentAdapter;
  // Injectable so a test can assert that a log line was actually emitted. Logging
  // that nobody has ever observed is indistinguishable from no logging at all —
  // which is how A4-F1 stayed invisible.
  loggerStream?: NodeJS.WritableStream;
  // Raise the level for a test that must observe an info-level record — notably the
  // Bible §9.2 audit line for an ALLOW, which is mandatory but not a warning.
  logLevel?: string;
  /**
   * Warm the database and every enabled adapter once the server is ready.
   *
   * OFF BY DEFAULT, and set only by the real entry point. Warming is real network I/O to
   * real providers; wiring it into every `buildServer` would have the test suite opening
   * provider connections in twenty files, which is both slow and a live dependency in a
   * suite that deliberately has none.
   */
  warmOnBoot?: boolean;
}

const WS_OPEN = 1; // ws.WebSocket.OPEN
const HEARTBEAT_MS = 15_000;

// Fastify's built-in pino, configured. Previously `Fastify()` was constructed with
// no logger at all, so every `app.log.error` in this file — including the foreign-key
// violation behind A4-F1 — was written to nowhere. Structured JSON on stdout, `info`
// normally and `warn` under test so the suite stays readable (`error` still emits at
// `warn`, which is the level the A4-F1 regression test asserts against).
function loggerOptions(opts: BuildOptions): FastifyServerOptions['logger'] {
  const isTest = process.env.NODE_ENV === 'test';
  return {
    level: opts.logLevel ?? process.env.LOG_LEVEL ?? (isTest ? 'warn' : 'info'),
    // Never let a credential reach the log. Paths cover the shapes that actually
    // carry secrets here: request headers, and any object field whose name looks
    // like a key, token, password or connection string.
    redact: {
      // Both bare and one-level-nested forms: in pino, `*.password` matches
      // `anything.password` but NOT a top-level `password`, so each name needs both
      // spellings or half the cases leak.
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'password',
        'secret',
        'token',
        'apiKey',
        'api_key',
        'connectionString',
        'connection_string',
        'databaseUrl',
        '*.password',
        '*.secret',
        '*.token',
        '*.apiKey',
        '*.api_key',
        '*.connectionString',
        '*.connection_string',
        '*.databaseUrl',
        // Every credential-shaped env var, by name, discovered at boot.
        ...secretEnvPaths(),
      ],
      censor: '[redacted]',
    },
    ...(opts.loggerStream ? { stream: opts.loggerStream } : {}),
  };
}

// Credential-shaped names that are NOT provider-specific. Static, because deriving
// everything from process.env turned out to be fragile: a server built before the env is
// loaded derives an empty list, and the field then logs in clear. Discovered by the
// redaction test failing on a nested DATABASE_URL — the derived list is a supplement, not
// a replacement.
const STATIC_SECRET_NAMES = ['DATABASE_URL', 'TEST_DATABASE_URL'];

// Provider keys are discovered rather than named, so this file does not know which
// providers exist (§6) and a key added later is redacted without anyone extending an
// array. Union of the two lists; duplicates are harmless to pino.
function secretEnvPaths(): string[] {
  const looksSecret = /(_KEY|_TOKEN|_SECRET|PASSWORD|DATABASE_URL|CONNECTION_STRING)$/i;
  const discovered = Object.keys(process.env).filter((k) => looksSecret.test(k));
  return [...new Set([...STATIC_SECRET_NAMES, ...discovered])].flatMap((k) => [k, `*.${k}`]);
}

// The one refusal both transports serialise through, so an HTTP 404 body and a
// WebSocket error frame are the same shape.
function roomNotFound(roomId: string): ServerErrorFrame {
  return ServerErrorFrame.parse({
    type: 'error',
    code: ERROR_ROOM_NOT_FOUND,
    message: `room "${roomId}" does not exist`,
    room_id: roomId,
  });
}

export function buildServer(opts: BuildOptions = {}): FastifyInstance {
  const app = Fastify({ logger: loggerOptions(opts) });
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL;
  const pool: Pool | null = databaseUrl ? makePool(databaseUrl) : null;
  const bus = new RoomBus();
  const adapterFactory = opts.adapterFactory ?? createAdapter;

  const db = (): Pool => {
    if (!pool) throw new Error('DATABASE_URL is not configured');
    return pool;
  };

  // Every room mutation flows through executeCommand (ADR-004). `pool` is a getter
  // so a missing DATABASE_URL fails exactly as before; `execute` lets a command
  // re-enter the entry (postMessage → triggerAgentTurn) without a circular import.
  const deps: CommandDeps = {
    get pool() {
      return db();
    },
    bus,
    // One logger for the whole process (F1). The command layer logs through the same
    // destination the server does, so an evaluation is observable wherever requests are.
    log: app.log,
    adapterFactory,
    execute: (ctx, command) => executeCommand(ctx, command, deps),
  };

  app.register(fastifyWebsocket);

  app.addHook('onClose', async () => {
    if (pool) await pool.end();
  });

  // Warm THIS server's own pool and adapter factory. Not a separate pool built at the
  // entry point: connection state is per-object and per-process, so warming a second pool
  // would wake the Neon compute (shared) and leave this server's connections cold
  // (not shared) — a warm-up that measures beautifully and helps nobody.
  //
  // Started in onReady and deliberately NOT awaited. Fastify awaits onReady hooks before
  // `listen` resolves, so awaiting here would move the cold cost off the member's first
  // request and onto every deploy. A request arriving mid-warm-up pays what it would have
  // paid anyway; nothing is made worse by not waiting.
  if (opts.warmOnBoot) {
    app.addHook('onReady', async () => {
      if (!pool) return;
      void warmUp({ pool, adapterFactory, log: app.log });
    });
  }

  // Routes live inside a plugin registered after @fastify/websocket so the
  // websocket route is recognised (the plugin's onRoute hook must exist first).
  app.register(async (fastify) => {
    fastify.get('/health', async () => ({
      ok: true,
      service: 'playroom-api',
      version: PLAYROOM_VERSION,
    }));

    // POST /internal/warmup → pay the cold connection costs now, and report what it cost.
    //
    // AN ENDPOINT RATHER THAN A SCRIPT, because connection state is PER-PROCESS. A script
    // warming its own sockets would wake the Neon compute (shared) and do nothing at all
    // for this process's provider connections (not shared) — a warm-up that measured
    // beautifully and helped nobody. The capture harness has to be able to warm the
    // process that will serve the recording, which means asking it.
    //
    // Unauthenticated, like POST /rooms — the same acceptance as RT-002 and bounded by the
    // same conditions. What makes it a smaller surface than that one: it spends NO tokens
    // (the adapters warm with a model-catalogue read), writes nothing, reads no room, and
    // returns only timings. What would make it unreasonable, and re-opens this: exposing
    // the api beyond localhost, or a warm-up mechanism that ever costs money.
    fastify.post('/internal/warmup', async () => {
      return warmUp({ pool: db(), adapterFactory, log: app.log });
    });

    // POST /rooms { id?, title } → 201 with the room row (idempotent on id).
    fastify.post('/rooms', async (req, reply) => {
      const body = (req.body ?? {}) as { id?: unknown; title?: unknown };
      const room = await executeCommand(
        { actorId: 'anonymous', mode: 'human' },
        {
          kind: 'createRoom',
          id: typeof body.id === 'string' ? body.id : undefined,
          title: typeof body.title === 'string' ? body.title : undefined,
        },
        deps,
      );
      reply.code(201);
      return room;
    });

    // GET /rooms/:id → the room row, or a typed 404. The body shape matches the
    // WebSocket error frame so a client has one refusal shape to handle, not two.
    fastify.get('/rooms/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const room = await getRoom(db(), id);
      if (!room) {
        reply.code(404);
        return roomNotFound(id);
      }
      return room;
    });

    // GET /rooms/:id/ws?after=<seq> — hello, then replay events seq > after in
    // order, then live-tail via the in-process bus.
    fastify.get('/rooms/:id/ws', { websocket: true }, (socket, req) => {
      const { id: roomId } = req.params as { id: string };
      const after = Number((req.query as { after?: string }).after ?? 0) || 0;

      const send = (
        frame: ServerEvent | ReturnType<typeof ServerHello.parse> | ServerErrorFrame,
      ): void => {
        if (socket.readyState === WS_OPEN) socket.send(JSON.stringify(frame));
      };

      // Subscribe before replay so no event committed during replay is missed;
      // the client dedupes on seq, so a small replay/live overlap is harmless.
      const unsub = bus.subscribe(roomId, (event) => send(event));

      // A room that does not exist is refused here, once, at the boundary — before
      // the socket is usable and before any send can be attempted. Previously the
      // socket opened for any id, `hello` claimed last_seq 0, and every send died on
      // the events→rooms foreign key with nothing surfaced (A4-F1). The FK remains
      // the last line of defence; it must never again be the first thing to notice.
      //
      // One extra SELECT per connection, not per message: the write path is unchanged.
      const refuse = (): void => {
        unsub();
        app.log.warn({ room_id: roomId, code: ERROR_ROOM_NOT_FOUND }, 'ws refused: room not found');
        send(roomNotFound(roomId));
        socket.close(WS_CLOSE_ROOM_NOT_FOUND, 'room not found');
      };

      // Resolves true once the room is confirmed, false if the socket was refused or
      // failed to open. Never rejects.
      //
      // The send queue awaits this, which is the whole point: a client that sends
      // immediately on open would otherwise race the existence check and land on the
      // foreign key instead — making the FK the first thing to notice, which is the
      // bug. Gating here means a write is attempted only after the room is known to
      // exist. The FK stays as the last line of defence (a room deleted mid-session
      // still fails there, now loudly).
      const accepted: Promise<boolean> = (async () => {
        if (!(await getRoom(db(), roomId))) {
          refuse();
          return false;
        }
        const helloSeq = await lastSeq(db(), roomId);
        send(ServerHello.parse({ type: 'hello', last_seq: helloSeq }));
        const backlog = await eventsAfter(db(), roomId, after);
        for (const event of backlog) send(event);
        return true;
      })().catch((err) => {
        app.log.error({ err, room_id: roomId }, 'ws open failed');
        return false;
      });

      // Frames from one socket are processed strictly in order: each send's INSERT
      // commits before the next begins, so seq matches the order the client sent
      // (concurrent handling would let near-simultaneous INSERTs race their seq).
      let sendQueue: Promise<void> = Promise.resolve();
      socket.on('message', (raw: Buffer) => {
        sendQueue = sendQueue
          .then(async () => {
            // Refused socket (or one that failed to open): never attempt the write.
            if (!(await accepted)) return;
            let msg: ClientFrame;
            try {
              msg = ClientFrame.parse(JSON.parse(raw.toString()));
            } catch {
              return; // drop malformed frames — never trust unparsed wire data
            }
            // Thin translation. Both frames go through the single entry (ADR-004):
            // `send` persists room content, `request_action` traverses the mandate
            // evaluator. Neither bypasses executeCommand.
            if (msg.type === 'request_action') {
              await executeCommand(
                { actorId: msg.subject, mode: 'hosted' },
                {
                  kind: 'requestAction',
                  roomId,
                  clientMsgId: msg.client_msg_id,
                  subject: msg.subject,
                  action: msg.action,
                  resource: msg.resource,
                },
                deps,
              );
              return;
            }
            await executeCommand(
              { actorId: msg.author, mode: 'human' },
              { kind: 'postMessage', roomId, clientMsgId: msg.client_msg_id, body: msg.body },
              deps,
            );
          })
          // The line that swallowed A4-F1. It was never wrong to catch here — a
          // rejected send must not take the socket down — but with no logger
          // configured the failure went nowhere, so a refused write and an accepted
          // one were indistinguishable from every angle. Context added so the next
          // one is greppable by room.
          .catch((err) => app.log.error({ err, room_id: roomId }, 'send failed'));
      });

      // Heartbeat: ping every 15s, terminate a socket that missed the last pong.
      let alive = true;
      socket.on('pong', () => {
        alive = true;
      });
      const heartbeat = setInterval(() => {
        if (!alive) {
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
      }, HEARTBEAT_MS);
      heartbeat.unref();

      socket.on('close', () => {
        clearInterval(heartbeat);
        unsub();
      });
    });
  });

  return app;
}
