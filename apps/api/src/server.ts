import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import {
  PLAYROOM_VERSION,
  ClientFrame,
  ServerHello,
  ServerErrorFrame,
  ERROR_ROOM_NOT_FOUND,
  ERROR_CREDENTIAL_REQUIRED,
  ERROR_CREDENTIAL_INVALID,
  ERROR_FRAME_MALFORMED,
  ERROR_FRAME_UNRECOGNISED,
  ERROR_TICKET_REQUIRED,
  ERROR_TICKET_INVALID,
  WS_CLOSE_ROOM_NOT_FOUND,
  WS_CLOSE_UNAUTHENTICATED,
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
import { authenticate, type AuthFailure } from './credentials.js';
import { consumeTicket, issueTicket, type TicketFailure, type TicketHolder } from './tickets.js';
import { listMembers, listRoomMembers, roomAccess } from './members.js';
import { setKnownMemberTokens } from './agent.js';

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

/**
 * The two credential refusals, as sentences.
 *
 * A MISSING credential and a BAD one are different mistakes and get different words, because
 * they send an operator to different places: the first is a client that was never configured,
 * the second is a token that was revoked, mistyped, or belongs to another deployment. Merging
 * them into "unauthorized" would be the same failure as collapsing NOT_IN_ROOM into
 * UNKNOWN_MEMBER — a refusal that is correct and useless.
 */
function credentialRefusal(failure: AuthFailure, roomId?: string): ServerErrorFrame {
  return ServerErrorFrame.parse({
    type: 'error',
    code: failure === 'credential_required' ? ERROR_CREDENTIAL_REQUIRED : ERROR_CREDENTIAL_INVALID,
    message:
      failure === 'credential_required'
        ? 'no credential was presented — this connection carries no identity'
        : 'the credential presented is not valid — it may have been revoked',
    room_id: roomId,
  });
}

/**
 * The two ticket refusals the CALLER sees, from four the server knows about.
 *
 * `missing` is its own code, because a client that was never wired to fetch a ticket and a client
 * whose ticket was refused send someone to different places. The other four — fabricated,
 * consumed, expired, wrong room — collapse into one answer, because telling them apart would let
 * a caller learn whether a ticket ever existed and for where. The log has already recorded which.
 */
function ticketRefusal(failure: TicketFailure, roomId: string): ServerErrorFrame {
  const missing = failure === 'missing';
  return ServerErrorFrame.parse({
    type: 'error',
    code: missing ? ERROR_TICKET_REQUIRED : ERROR_TICKET_INVALID,
    message: missing
      ? 'no ticket was presented — exchange a credential at POST /ws-ticket first'
      : 'that ticket cannot be spent — request a new one',
    room_id: roomId,
  });
}

/** Marker for "parsed as JSON, is not a frame we accept" — the two cases share one catch. */
class UnrecognisedFrame extends Error {}

/**
 * The credential on an HTTP request: `Authorization: Bearer <token>`.
 *
 * A HEADER, NOT A QUERY PARAMETER, unlike the WebSocket handshake. A secret in a URL is
 * written to every access log, proxy log and browser history along the way, and `?token=` on
 * the socket is a concession to the browser WebSocket API being unable to set headers — not a
 * pattern to copy where headers are available.
 */
function bearerToken(req: { headers: Record<string, unknown> }): string | undefined {
  const raw = req.headers['authorization'];
  if (typeof raw !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match?.[1];
}

/**
 * The two send-path refusals.
 *
 * `ClientFrame` accepts `send`, `request_action` and `handoff`. THERE IS STILL NO FRAME THAT
 * STARTS AN AGENT TURN, and this refusal is where that becomes observable rather than merely
 * true: a caller inventing one is told the frame is not recognised, instead of watching a socket
 * stay silent and having to guess whether the turn is coming.
 *
 * A handoff is not a counter-example. It moves who HOLDS work; being given work and being asked
 * to do it are different events, and only the second one is a summon (agent-path.test.ts asserts
 * that no turn follows a handoff).
 */
function frameRefusal(unrecognised: boolean, roomId: string): ServerErrorFrame {
  return ServerErrorFrame.parse({
    type: 'error',
    code: unrecognised ? ERROR_FRAME_UNRECOGNISED : ERROR_FRAME_MALFORMED,
    message: unrecognised
      ? 'that is not a frame this room accepts — only `send`, `request_action` and `handoff`'
      : 'that frame was not valid JSON',
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

  // THE KNOWN-MEMBER TOKENS, loaded before the server accepts anything.
  //
  // This is the set that lets the summon rule say "@sol is not in this room" rather than
  // "nobody is called @sol". A room's OWN tokens are resolved per message from that room's
  // membership (agent.ts), because membership is data now and a boot snapshot would answer
  // yesterday's question.
  //
  // AWAITED, unlike the warm-up below, and `listMembers` throws here if a mandate names a
  // member that does not exist — so a misconfigured deployment fails to start rather than
  // running a room where one agent quietly cannot act.
  app.addHook('onReady', async () => {
    if (!pool) return;
    setKnownMemberTokens(await listMembers(pool));
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

    // GET /members → the roster, from records.
    //
    // The web tier calls this instead of reading adapters.yaml and mandates/ off the disk.
    // That is UI2-N2 closed properly: the server-only fence in the web app stops being a
    // comment and a lucky type-only import, because there is no filesystem read left in that
    // path to leak `node:fs` into a browser bundle.
    //
    // Read-only, and it names no provider (§6).
    //
    // NOW SCOPED TO WHO IS ASKING, which is what S11a-N1 was waiting for. That finding shipped
    // an unauthenticated roster of EVERY member; S1.1b narrowed the ROWS to one room and said
    // plainly that who may ask was still not enforced. It is enforced here: a credential, and
    // then membership of the room being read.
    //
    // It is not a small thing to have left open. A roster is not a room id — it names people,
    // the principals they act for, and the actions each of them has been fenced from. That is
    // the shape of an organisation, readable by anyone who could reach the port.
    fastify.get('/rooms/:id/members', async (req, reply) => {
      const { id } = req.params as { id: string };

      // IDENTITY FIRST, then existence, then membership — the same order as the handshake.
      const auth = await authenticate(db(), bearerToken(req));
      if (!auth.ok) {
        app.log.warn({ room_id: id, code: auth.failure }, 'roster refused: no usable credential');
        reply.code(401);
        return credentialRefusal(auth.failure, id);
      }

      // A ROOM THE CALLER IS NOT IN ANSWERS EXACTLY AS A ROOM THAT DOES NOT EXIST.
      //
      // Deliberate, and it is the one place this codebase does NOT distinguish two mistakes in
      // its reply. `Jerry's agent` is a legitimate holder of a credential; if a non-member got
      // "you are not in this room" it could enumerate Prince's room ids by trying, and
      // cross-principal leakage is the thing the product exists to prevent. A roster is not a
      // room id: it names people, their principals and their protected actions.
      //
      // The distinction is not lost, it is MOVED: the log below says which of the two it was,
      // server-side, where the caller cannot read it. An operator debugging a 404 has the
      // answer; a caller probing for rooms does not.
      // ONE QUERY, not two (S1.3b). This asked `getRoom` and then `isRoomMember`, which meant a
      // missing room cost one round trip and an unauthorised room cost two — the refusals were
      // byte-identical and separable by a stopwatch. `roomAccess` does both in one, so the timing
      // matches the bytes.
      const access = await roomAccess(db(), id, auth.auth.member_id);
      if (!access.room_exists || !access.is_member) {
        app.log.warn(
          {
            room_id: id,
            member: auth.auth.member_id,
            reason: access.room_exists ? 'not_in_room' : 'no_room',
          },
          'roster refused',
        );
        reply.code(404);
        return roomNotFound(id);
      }
      return { members: await listRoomMembers(db(), id) };
    });

    // POST /ws-ticket { room_id } → a single-use ticket for the authenticated member (S1.3c).
    //
    // BEHIND BEARER, and it asks NO authorisation question beyond the credential. Whether this
    // member may join that room is decided at the handshake and nowhere else — if this route
    // checked, it would answer "does that room exist and am I in it", which is the oracle S1.3b
    // closed, rebuilt one route over.
    //
    // So a ticket for a room the member cannot join is issued happily and refused at the door,
    // identically to a room that does not exist. One choke point, and this is not it.
    fastify.post('/ws-ticket', async (req, reply) => {
      const auth = await authenticate(db(), bearerToken(req));
      if (!auth.ok) {
        app.log.warn({ code: auth.failure }, 'ticket refused: no usable credential');
        reply.code(401);
        return credentialRefusal(auth.failure, undefined);
      }
      const body = (req.body ?? {}) as { room_id?: unknown };
      if (typeof body.room_id !== 'string' || body.room_id.trim() === '') {
        reply.code(400);
        return ServerErrorFrame.parse({
          type: 'error',
          code: ERROR_TICKET_REQUIRED,
          message: 'room_id is required — a ticket is bound to one room',
        });
      }
      const issued = await issueTicket(db(), auth.auth.member_id, body.room_id);
      // The plaintext, once. Not logged: the whole point of a ticket is that it is worthless
      // thirty seconds from now, and a log line outliving it by weeks would undo that.
      app.log.info(
        { room_id: body.room_id, member: auth.auth.member_id, expires_at: issued.expires_at },
        'ticket issued',
      );
      return issued;
    });

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

    // POST /rooms { id?, title } → 201 with THE ID ONLY (idempotent on id).
    //
    // ── THE THIRD ORACLE, AND THE LAST ONE THE HANDSHAKE'S SILENCE DEPENDS ON ─────────────
    //
    // It returned the room ROW. Idempotent on id means a POST against an id that already exists
    // returns the EXISTING room — so an unauthenticated caller who guessed `jerrys-review` got
    // back its title and its creation date. Worse than the existence oracle S12-N1 described:
    // not "this room exists" but a fragment of its content.
    //
    // Closing it did not need a credential, and deliberately does not use one: creation stays
    // unauthenticated (that is RT-002, still open, still accepted for its own reasons) and the
    // browser's create flow keeps working without threading a token through a client form. What
    // changed is that the RESPONSE no longer carries anything a caller did not already supply —
    // just the id, which is either the slug they asked for or one that was generated for them.
    // A fresh create and a collision are now indistinguishable, which is the same property the
    // handshake and the two GETs have.
    //
    // The two consumers used only `id` (the capture harness and the home page's form), so this
    // costs nothing. RT-002's own risk is unchanged: an unauthenticated caller can still CREATE
    // rooms, and that is the finding to close, not this one.
    fastify.post('/rooms', async (req, reply) => {
      // ── RT-002 CLOSES HERE ────────────────────────────────────────────────────────────
      //
      // Anyone who could reach the api could create a room. Accepted in S0.3 "until S1.1",
      // because §1's invite-only roster cannot be enforced by a route guard when nothing knows
      // who is asking — which was true then and stopped being true when S1.2 landed identity.
      // It ran five slices past its own expiry.
      //
      // The creator is now an authenticated member, and `createRoom` enrols them in the same
      // transaction: after S1.3b's front door, a room with no members is a room nobody can open.
      const auth = await authenticate(db(), bearerToken(req));
      if (!auth.ok) {
        app.log.warn({ code: auth.failure }, 'create refused: no usable credential');
        reply.code(401);
        return credentialRefusal(auth.failure, undefined);
      }
      const body = (req.body ?? {}) as { id?: unknown; title?: unknown };
      const room = await executeCommand(
        { actorId: auth.auth.member_id, principalId: auth.auth.principal_id, mode: 'human' },
        {
          kind: 'createRoom',
          id: typeof body.id === 'string' ? body.id : undefined,
          title: typeof body.title === 'string' ? body.title : undefined,
        },
        deps,
      );
      reply.code(201);
      return { id: room.id };
    });

    // GET /rooms/:id → the room row, or a typed 404. The body shape matches the
    // WebSocket error frame so a client has one refusal shape to handle, not two.
    //
    // ── CREDENTIAL AND MEMBERSHIP, BECAUSE AN ORACLE ANYWHERE UNDOES SILENCE EVERYWHERE ──
    //
    // S12-N1, closed. This route answered "does room X exist" to anyone who could reach the
    // port, which made S13b-2's silent handshake pointless one request later: a caller refused
    // at the socket could simply ask here. The two had to close together or neither was worth
    // building, and the owner's ruling says exactly that.
    //
    // Same shape as `GET /rooms/:id/members`: `Authorization: Bearer`, never a token in a query
    // parameter, and a non-member gets what a non-existent room gets — down to the body, which
    // `roomNotFound` produces for both.
    fastify.get('/rooms/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const auth = await authenticate(db(), bearerToken(req));
      if (!auth.ok) {
        app.log.warn({ room_id: id, code: auth.failure }, 'room refused: no usable credential');
        reply.code(401);
        return credentialRefusal(auth.failure, id);
      }
      // ONE QUERY for both questions, so the two refusals cost the same (see `roomAccess`).
      const access = await roomAccess(db(), id, auth.auth.member_id);
      if (!access.room_exists || !access.is_member) {
        app.log.warn(
          {
            room_id: id,
            member: auth.auth.member_id,
            reason: access.room_exists ? 'not_in_room' : 'no_room',
          },
          'room refused',
        );
        reply.code(404);
        return roomNotFound(id);
      }
      const room = await getRoom(db(), id);
      if (!room) {
        // Deleted between the two reads. Refused identically rather than returning null — the
        // race is real and its answer is the same one every other miss gets.
        reply.code(404);
        return roomNotFound(id);
      }
      return room;
    });

    // GET /rooms/:id/ws?after=<seq> — hello, then replay events seq > after in
    // order, then live-tail via the in-process bus.
    fastify.get('/rooms/:id/ws', { websocket: true }, (socket, req) => {
      const { id: roomId } = req.params as { id: string };
      // `ticket`, not `token`, as of S1.3c. The long-lived credential no longer travels here:
      // it is exchanged for a single-use ticket over `POST /ws-ticket`, which a browser CAN
      // authenticate with a header. There is deliberately no `token` fallback — a fallback is
      // the old path still open, and closing the old path is the entire slice.
      const query = req.query as { after?: string; ticket?: string };
      const after = Number(query.after ?? 0) || 0;

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
      //
      // ── AND A ROOM YOU ARE NOT IN IS A ROOM THAT DOES NOT EXIST (S1.3b) ──────────────
      //
      // One refusal for both, byte for byte: same typed frame, same close code 4404, same
      // sentence. The two are told apart only in the LOG, server-side, where the caller cannot
      // read it.
      //
      // Deliberate, and it is the one place this codebase does not distinguish two mistakes to
      // the caller — the same ruling S12-3 applied to the roster read. `sol` holds a legitimate
      // credential; if a non-member were told "you are not in this room" it could enumerate
      // Prince's room ids by trying, and cross-principal leakage is the boundary the product
      // exists to defend. The standing rule that fail-closed distinguishes REFUSED from
      // MISCONFIGURED is about the operator, and the operator has logs.
      const refuse = (reason: 'no_room' | 'not_in_room', member?: string): void => {
        unsub();
        app.log.warn(
          { room_id: roomId, code: ERROR_ROOM_NOT_FOUND, reason, member },
          'ws refused: room not visible to this member',
        );
        send(roomNotFound(roomId));
        socket.close(WS_CLOSE_ROOM_NOT_FOUND, 'room not found');
      };

      // Every refusal travels the same way: a typed frame the client can branch on, a close
      // code it can react to, and a log line. Never a silent drop, and never a socket that
      // opens and then does nothing — RT-001's shape, which this codebase refuses.
      const refuseWith = (frame: ServerErrorFrame, closeCode: number): void => {
        unsub();
        app.log.warn({ room_id: roomId, code: frame.code }, `ws refused: ${frame.message}`);
        send(frame);
        socket.close(closeCode, frame.code);
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
      // ── THE HANDSHAKE STAMPS THE ACTOR, ONCE ─────────────────────────────────────────
      //
      // `accepted` used to resolve a boolean; it now resolves THE IDENTITY, or null if the
      // socket was refused. That is deliberate: awaiting it both gates the write and NARROWS
      // the actor, so there is no path where a frame is handled without an authenticated
      // member in hand and no non-null assertion pretending there isn't.
      //
      // Resolved once, held in this closure for the life of the socket. No frame can override
      // it, because `ClientSend` no longer has a field for the claim.
      // A TICKET HOLDER, not a credential holder, since S1.3c. The socket needs the member and
      // the principal and has never needed anything else — `AuthResult` also carries the
      // credential id, which only the credential path knows and no frame handler reads.
      const accepted: Promise<TicketHolder | null> = (async () => {
        // SPEND THE TICKET BEFORE ANYTHING ELSE, including the room lookup. An unauthenticated
        // caller learns nothing — not even whether a room exists — and no query runs on their
        // behalf beyond the one that claims their ticket. The order is the refusal order:
        // identity, then existence, then membership.
        //
        // Consuming here rather than after the room check is deliberate: a ticket presented at a
        // door that then refuses is still SPENT, because returning it would let a caller probe
        // room ids with one ticket until it expired.
        const spent = await consumeTicket(db(), query.ticket, roomId);
        if (!spent.ok) {
          app.log.warn(
            { room_id: roomId, reason: spent.failure },
            'ws refused: ticket not spendable',
          );
          refuseWith(ticketRefusal(spent.failure, roomId), WS_CLOSE_UNAUTHENTICATED);
          return null;
        }
        const result = { ok: true as const, auth: spent.holder };

        // EXISTENCE AND MEMBERSHIP, IN ONE QUERY. Two queries would make the refusals
        // distinguishable by timing, which is the oracle rebuilt out of latency (see
        // `roomAccess`). S13-N2 closed: the front door now asks the question the handoff and the
        // roster read were already asking.
        const access = await roomAccess(db(), roomId, result.auth.member_id);
        if (!access.room_exists || !access.is_member) {
          refuse(access.room_exists ? 'not_in_room' : 'no_room', result.auth.member_id);
          return null;
        }
        const helloSeq = await lastSeq(db(), roomId);
        send(ServerHello.parse({ type: 'hello', last_seq: helloSeq }));
        const backlog = await eventsAfter(db(), roomId, after);
        for (const event of backlog) send(event);
        return result.auth;
      })().catch((err) => {
        app.log.error({ err, room_id: roomId }, 'ws open failed');
        return null;
      });

      // Frames from one socket are processed strictly in order: each send's INSERT
      // commits before the next begins, so seq matches the order the client sent
      // (concurrent handling would let near-simultaneous INSERTs race their seq).
      let sendQueue: Promise<void> = Promise.resolve();
      socket.on('message', (raw: Buffer) => {
        sendQueue = sendQueue
          .then(async () => {
            // Refused socket (or one that failed to open): never attempt the write. The
            // awaited value IS the authenticated member, so this gate and the actor are the
            // same fact — there is no way to handle a frame without one.
            const actor = await accepted;
            if (!actor) return;
            let msg: ClientFrame;
            try {
              // Two steps, because the two failures are different mistakes and get different
              // words. Neither is trusted: the frame is only ever read through the schema.
              const json: unknown = JSON.parse(raw.toString());
              const parsed = ClientFrame.safeParse(json);
              if (!parsed.success) throw new UnrecognisedFrame();
              msg = parsed.data;
            } catch (err) {
              // REFUSED OUT LOUD, where this used to `return`. A dropped frame is
              // indistinguishable from a lost socket AND from a server that accepted it and
              // did nothing — RT-001's shape, on the send path. The socket STAYS OPEN: the
              // connection is authenticated and its next frame may be perfectly good.
              //
              // Nothing from the frame is echoed back or logged. It is untrusted wire data,
              // and a refusal that quotes it is a refusal that can be made to say anything.
              const unrecognised = err instanceof UnrecognisedFrame;
              const frame = frameRefusal(unrecognised, roomId);
              app.log.warn({ room_id: roomId, code: frame.code }, 'frame refused');
              socket.send(JSON.stringify(frame));
              return;
            }
            // Thin translation. Both frames go through the single entry (ADR-004):
            // `send` persists room content, `request_action` traverses the mandate
            // evaluator. Neither bypasses executeCommand.
            if (msg.type === 'request_action') {
              // THE REQUESTER is the authenticated member. `subject` stays a claim from the
              // frame — a host sidecar asks on its member's behalf, which is beat 5 of the
              // film — so the two are different parties and only one of them is proven.
              const decided = await executeCommand(
                { actorId: actor.member_id, principalId: actor.principal_id, mode: 'human' },
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
              // AN UNJUSTIFIED SUBJECT IS REFUSED TO THE CALLER and writes nothing to the room
              // (S12-N2). Not a BLOCK card: the fabric evaluated nothing, and a card saying
              // "requested under X's mandate" would repeat the claim being rejected.
              if (!decided.ok) {
                socket.send(
                  JSON.stringify(
                    ServerErrorFrame.parse({
                      type: 'error',
                      code: decided.refusal.code,
                      message: decided.refusal.message,
                      room_id: roomId,
                    }),
                  ),
                );
              }
              return;
            }
            if (msg.type === 'handoff') {
              // A TASK TRANSFER — Bible §21.3. The actor is the authenticated member, which is
              // the field that makes this a record of a delegation rather than a state change
              // nobody is accountable for.
              const result = await executeCommand(
                { actorId: actor.member_id, principalId: actor.principal_id, mode: 'human' },
                {
                  kind: 'handoff',
                  roomId,
                  taskId: msg.task_id,
                  toMember: msg.to_member,
                  action: msg.action,
                },
                deps,
              );
              // REFUSED TO THE CALLER, in the same shape as every other refusal: typed frame,
              // its own code, a sentence naming the constraint. The socket stays open — this is
              // one request refused, not an identity problem.
              if (!result.ok) {
                socket.send(
                  JSON.stringify(
                    ServerErrorFrame.parse({
                      type: 'error',
                      code: result.refusal.code,
                      message: result.refusal.message,
                      room_id: roomId,
                    }),
                  ),
                );
              }
              return;
            }
            // THE STAMPED ACTOR, not a claim from the frame.
            await executeCommand(
              { actorId: actor.member_id, principalId: actor.principal_id, mode: 'human' },
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
