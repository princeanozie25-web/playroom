import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { PLAYROOM_VERSION, ClientSend, ServerHello, type ServerEvent } from '@playroom/shared';
import type { Pool } from 'pg';
import { makePool } from './db.js';
import { RoomBus } from './bus.js';
import { appendMessage, createRoom, eventsAfter, getRoom, lastSeq } from './events.js';

export interface BuildOptions {
  databaseUrl?: string;
}

const WS_OPEN = 1; // ws.WebSocket.OPEN
const HEARTBEAT_MS = 15_000;

// author is a free-text display name for now — there is no auth, principal, or
// roster yet (that is S1.1). Do not treat it as an identity.
function slugify(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || genId();
}

function genId(): string {
  return `room-${crypto.randomUUID().slice(0, 8)}`;
}

export function buildServer(opts: BuildOptions = {}): FastifyInstance {
  const app = Fastify();
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL;
  const pool: Pool | null = databaseUrl ? makePool(databaseUrl) : null;
  const bus = new RoomBus();

  const db = (): Pool => {
    if (!pool) throw new Error('DATABASE_URL is not configured');
    return pool;
  };

  app.register(fastifyWebsocket);

  app.addHook('onClose', async () => {
    if (pool) await pool.end();
  });

  // Routes live inside a plugin registered after @fastify/websocket so the
  // websocket route is recognised (the plugin's onRoute hook must exist first).
  app.register(async (fastify) => {
    fastify.get('/health', async () => ({
      ok: true,
      service: 'playroom-api',
      version: PLAYROOM_VERSION,
    }));

    // POST /rooms { id?, title } → 201 with the room row (idempotent on id).
    fastify.post('/rooms', async (req, reply) => {
      const body = (req.body ?? {}) as { id?: unknown; title?: unknown };
      const title =
        typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Untitled room';
      const id = typeof body.id === 'string' && body.id.trim() ? slugify(body.id) : genId();
      const room = await createRoom(db(), id, title);
      reply.code(201);
      return room;
    });

    // GET /rooms/:id → the room row, or 404.
    fastify.get('/rooms/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const room = await getRoom(db(), id);
      if (!room) {
        reply.code(404);
        return { error: 'room not found' };
      }
      return room;
    });

    // GET /rooms/:id/ws?after=<seq> — hello, then replay events seq > after in
    // order, then live-tail via the in-process bus.
    fastify.get('/rooms/:id/ws', { websocket: true }, (socket, req) => {
      const { id: roomId } = req.params as { id: string };
      const after = Number((req.query as { after?: string }).after ?? 0) || 0;

      const send = (frame: ServerEvent | ReturnType<typeof ServerHello.parse>): void => {
        if (socket.readyState === WS_OPEN) socket.send(JSON.stringify(frame));
      };

      // Subscribe before replay so no event committed during replay is missed;
      // the client dedupes on seq, so a small replay/live overlap is harmless.
      const unsub = bus.subscribe(roomId, (event) => send(event));

      void (async () => {
        const helloSeq = await lastSeq(db(), roomId);
        send(ServerHello.parse({ type: 'hello', last_seq: helloSeq }));
        const backlog = await eventsAfter(db(), roomId, after);
        for (const event of backlog) send(event);
      })().catch((err) => app.log.error(err));

      // Frames from one socket are processed strictly in order: each send's INSERT
      // commits before the next begins, so seq matches the order the client sent
      // (concurrent handling would let near-simultaneous INSERTs race their seq).
      let sendQueue: Promise<void> = Promise.resolve();
      socket.on('message', (raw: Buffer) => {
        sendQueue = sendQueue
          .then(async () => {
            let msg: ClientSend;
            try {
              msg = ClientSend.parse(JSON.parse(raw.toString()));
            } catch {
              return; // drop malformed frames — never trust unparsed wire data
            }
            // §8 ordering law: persist first, fan out only after COMMIT.
            const event = await appendMessage(
              db(),
              roomId,
              msg.author,
              msg.client_msg_id,
              msg.body,
            );
            bus.publish(roomId, event);
          })
          .catch((err) => app.log.error(err));
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
