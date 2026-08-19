import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
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
  ERROR_DOWNGRADE_REFUSED,
  ERROR_ORDER_UNKNOWN,
  ERROR_PUSH_MALFORMED,
  ERROR_PUSH_NOT_HUMAN,
  ERROR_ORDER_NOT_HUMAN,
  ERROR_ORDER_NOT_CREATOR,
  WS_CLOSE_ROOM_NOT_FOUND,
  WS_CLOSE_UNAUTHENTICATED,
  type AgentAdapter,
  type ServerEvent,
} from '@playroom/shared';
import { createAdapter } from '@playroom/adapters';
import { countFor, deleteSubscription, upsertSubscription } from './push.js';
import type { Pool } from 'pg';
import { makePool } from './db.js';
import { RoomBus } from './bus.js';
import {
  decisionEventById,
  decisionResolutionEvent,
  eventsAfter,
  eventsBefore,
  getRoom,
  hasEventsBefore,
  lastSeq,
  roomWindowFloor,
  HISTORY_PAGE_DEFAULT,
  HISTORY_PAGE_MAX,
} from './events.js';
import { executeCommand, type CommandDeps } from './commands/index.js';
import { handleMcpRequest } from './mcp.js';
import { chainCommitmentEvents } from './audit.js';
import { warmUp } from './warmup.js';
import { makeScrubStream } from './scrub.js';
import { authenticate, diagnoseCredential, type AuthFailure } from './credentials.js';
import { downgradeInterrupt } from './interrupts.js';
import { activeBriefing } from './briefings.js';
import { activeDocuments } from './documents.js';
import { DECISION_POLL_HINT_MS, decisionExpiryMs, isExpired } from './decisions.js';
import { consumeTicket, issueTicket, type TicketFailure, type TicketHolder } from './tickets.js';
import { RedeemRefused, redeemRoomCode } from './room-codes.js';
import { listMembers, listRoomMembers, memberRecord, roomAccess } from './members.js';
import { ordersInRoom } from './orders.js';
import { setKnownMemberTokens } from './agent.js';
import { roomSpend } from './spend.js';

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
  /**
   * SLIVE-N1: the IP-keyed throttle on POST /redeem — attempts per IP per window. Configurable so a
   * test can drive it low and hammer one IP to a 429 without tuning the production number. Defaults
   * throttle a brute-force script hard while never inconveniencing a tester who redeems once or twice.
   */
  redeemRateMax?: number;
  redeemRateWindowMs?: number;
  /**
   * S2.1b: the credential-keyed throttle on POST /rooms/:id/actions — governed requests per credential
   * per window. Configurable so a test can drive it low and burst one caller to a 429. The default lets
   * a real service (Drift, Claude Code) make governed requests freely while bounding a runaway loop.
   */
  actionRateMax?: number;
  actionRateWindowMs?: number;
  /**
   * A3: how often (ms) to fold new commitment events into the tamper-evident audit chain, in-process.
   * Undefined or ≤0 disables it — the anchor is then a manual/cron concern (scripts/anchor-audit.ts), and
   * tests leave it off so no background writer touches their chain. Set in production so `get_receipt`
   * returns real receipts without an external scheduler; the work is idempotent and off the request path.
   */
  anchorIntervalMs?: number;
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
    // SLIVE-N3: THE SINK ITSELF SCRUBS. The `redact` above is path-based and a key rode into the logs
    // inside an error field nobody named — so the destination is wrapped so every serialized line is
    // scrubbed on the way out (message, stack, nested error, cause chain are all text by here), fail-
    // closed. Wraps the injected test stream, or stdout in production; nothing reaches either unscrubbed.
    stream: makeScrubStream(opts.loggerStream ?? process.stdout).stream,
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
  const app = Fastify({
    logger: loggerOptions(opts),
    // BEHIND FLY'S PROXY the socket peer is the load balancer, so `req.ip` would be one address for
    // everyone and the /redeem throttle (SLIVE-N1) would key on nothing. trustProxy makes `req.ip`
    // the client from X-Forwarded-For, which Fly sets and no caller can forge — the app is reachable
    // only THROUGH that proxy, never directly.
    trustProxy: true,
  });
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

  // ── SLIVE-N1: THE /redeem THROTTLE ──────────────────────────────────────────────────────────
  //
  // POST /redeem is the one unauthenticated write — its whole job is to hand a credential to someone
  // who has none. A 4-character code from a 30-character alphabet is ~810k possibilities, and off
  // localhost, on a public URL, nothing here slowed a script down. This is the "before any code goes
  // out" control: an IP-keyed sliding window that lets a real tester redeem (once, maybe a retry)
  // while making a brute-force script take lifetimes per address. It is a floor, not the whole fence
  // — the companion lever, a longer code, is left to the owner's call and noted in the ledger.
  //
  // IN-MEMORY AND PER-INSTANCE, sufficient for the single always-on machine this deploys as
  // (min_machines_running = 1). A second machine would each keep their own count, which only makes
  // the effective limit STRICTER, never looser — safe if imperfectly shared. A shared store (Redis)
  // is the honest answer once there is more than one machine, and is noted, not pretended.
  const redeemMax = opts.redeemRateMax ?? 20;
  const redeemWindowMs = opts.redeemRateWindowMs ?? 10 * 60_000;
  const redeemHits = new Map<string, number[]>();
  function redeemThrottled(ip: string): boolean {
    const now = Date.now();
    const cutoff = now - redeemWindowMs;
    const hits = (redeemHits.get(ip) ?? []).filter((t) => t > cutoff);
    hits.push(now);
    redeemHits.set(ip, hits);
    // Opportunistic prune so a stream of unique IPs cannot grow the map without bound.
    if (redeemHits.size > 20_000) {
      for (const [k, v] of redeemHits) if (v[v.length - 1] <= cutoff) redeemHits.delete(k);
    }
    return hits.length > redeemMax;
  }

  // ── S2.1b: THE /rooms/:id/actions THROTTLE ────────────────────────────────────────────────────
  //
  // The door is authenticated, so this is keyed on the CREDENTIAL, not the IP: it bounds ONE caller's
  // governed-request rate — the denial-of-wallet vector with a stolen or runaway credential holding the
  // pen — regardless of how many addresses it comes from. Same in-memory sliding window as /redeem
  // (per-instance; a second machine only makes the effective limit stricter, never looser).
  const actionMax = opts.actionRateMax ?? 60;
  const actionWindowMs = opts.actionRateWindowMs ?? 60_000;
  const actionHits = new Map<string, number[]>();
  function actionThrottled(credentialId: string): boolean {
    const now = Date.now();
    const cutoff = now - actionWindowMs;
    const hits = (actionHits.get(credentialId) ?? []).filter((t) => t > cutoff);
    hits.push(now);
    actionHits.set(credentialId, hits);
    if (actionHits.size > 20_000) {
      for (const [k, v] of actionHits) if (v[v.length - 1] <= cutoff) actionHits.delete(k);
    }
    return hits.length > actionMax;
  }

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

  // A3: fold new commitments into the audit chain on an interval, so `get_receipt` returns real receipts
  // without an external cron. OFF the request path and idempotent — a failure only skips one tick, and the
  // next repairs it, so it can never break a decision. `unref` keeps the timer from holding the process
  // open, and onClose stops it so a closed server (every test that starts one) leaves nothing running.
  if (opts.anchorIntervalMs && opts.anchorIntervalMs > 0) {
    const anchor = setInterval(() => {
      if (!pool) return;
      void chainCommitmentEvents(pool).catch((err) =>
        app.log.error({ err }, 'audit anchor failed'),
      );
    }, opts.anchorIntervalMs);
    anchor.unref();
    app.addHook('onClose', async () => clearInterval(anchor));
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

    // ── THE STANDING-ORDER ROUTES (S-UI3) ─────────────────────────────────────────────────────
    //
    // The loops screen reads and steers orders over HTTP — a form is request/response, not a live
    // socket. EVERY WRITE GOES THROUGH executeCommand, so the human-only creation, the creator-only
    // edit/resume/revoke, and the any-human pause are the SAME enforcement the WS frames get: these
    // routes add none and bypass none. Every route is membership-scoped like GET /members — a
    // non-member gets what a missing room gives, because the WS handshake's membership gate does not
    // exist on an HTTP request and orders must not be readable or steerable across rooms.

    /** authenticate + membership, or send the refusal and return null. Same silence as GET /members. */
    async function orderRouteMember(
      req: FastifyRequest,
      reply: FastifyReply,
      roomId: string,
    ): Promise<{ member_id: string; principal_id: string } | null> {
      const auth = await authenticate(db(), bearerToken(req));
      if (!auth.ok) {
        reply.code(401).send(credentialRefusal(auth.failure, roomId));
        return null;
      }
      const access = await roomAccess(db(), roomId, auth.auth.member_id);
      if (!access.room_exists || !access.is_member) {
        reply.code(404).send(roomNotFound(roomId));
        return null;
      }
      return auth.auth;
    }

    /** An order-command refusal → the HTTP status a form acts on, carrying the code and message. */
    const orderRefusalStatus = (code: string): number =>
      code === ERROR_ORDER_UNKNOWN
        ? 404
        : code === ERROR_ORDER_NOT_HUMAN || code === ERROR_ORDER_NOT_CREATOR
          ? 403
          : 400; // member_unknown / bad_state / invalid_config — malformed or wrong-state

    fastify.get('/rooms/:id/orders', async (req, reply) => {
      const { id } = req.params as { id: string };
      const actor = await orderRouteMember(req, reply, id);
      if (!actor) return reply;
      // WHO IS ASKING travels with the list, resolved server-side from the credential — the loops
      // screen is a server component with no WS `hello` to learn it from, and it needs the viewer to
      // render authorisation as visible truth (the creator sees edit/resume/revoke, any human sees
      // pause, an agent sees nothing doable). It is a courtesy for rendering; the command re-checks it.
      const me = await memberRecord(db(), actor.member_id);
      return {
        orders: await ordersInRoom(db(), id),
        viewer: { member_id: actor.member_id, kind: me?.kind ?? 'human' },
      };
    });

    fastify.post('/rooms/:id/orders', async (req, reply) => {
      const { id } = req.params as { id: string };
      const actor = await orderRouteMember(req, reply, id);
      if (!actor) return reply;
      const b = (req.body ?? {}) as Record<string, unknown>;
      const str = (v: unknown): string => (typeof v === 'string' ? v : '');
      const result = await executeCommand(
        { actorId: actor.member_id, principalId: actor.principal_id, mode: 'human' },
        {
          kind: 'createOrder',
          roomId: id,
          clientMsgId: str(b.client_msg_id) || `http-oc-${id}-${str(b.action_member)}`,
          triggerEventType: str(b.trigger_event_type),
          triggerMember: str(b.trigger_member),
          actionMember: str(b.action_member),
          maxCycles: typeof b.max_cycles === 'number' ? b.max_cycles : null,
          maxUnattendedCycles:
            typeof b.max_unattended_cycles === 'number' ? b.max_unattended_cycles : 3,
          expiresAt: typeof b.expires_at === 'string' ? b.expires_at : null,
          // Passed through AS SENT — including absent. The command owns the rule, so a caller that
          // omits it gets `order_task_absent` and a sentence, not a coerced empty string.
          task: typeof b.task === 'string' ? b.task : undefined,
        },
        deps,
      );
      if (!result.ok) {
        reply.code(orderRefusalStatus(result.refusal.code));
        return { type: 'error', code: result.refusal.code, message: result.refusal.message };
      }
      reply.code(201);
      return { order_id: result.orderId };
    });

    // ── PUSH SUBSCRIPTIONS (S-PUSH) ─────────────────────────────────────────────────────
    //
    // NOT ROOM-SCOPED, on purpose: a subscription is a person's address, not a seat at a table, so
    // it is registered once per browser and reaches its owner wherever a claim on them is made.
    //
    // THE PRINCIPAL IS NEVER IN THE BODY. It comes from the authenticated credential, so "register
    // someone else's phone" and "read someone else's addresses" are not refused requests — they are
    // requests with nowhere to put the argument. An AGENT is refused by KIND before anything else,
    // the same rule that keeps one from minting an order or setting a briefing.
    async function pushMember(
      req: FastifyRequest,
      reply: FastifyReply,
    ): Promise<{ member_id: string; principal_id: string } | null> {
      const auth = await authenticate(db(), bearerToken(req));
      if (!auth.ok) {
        // No room id: a subscription is not room-scoped, so the refusal names no room.
        reply.code(401).send(credentialRefusal(auth.failure, undefined));
        return null;
      }
      const me = await memberRecord(db(), auth.auth.member_id);
      if (!me || me.kind !== 'human') {
        app.log.warn(
          { member: auth.auth.member_id, code: ERROR_PUSH_NOT_HUMAN },
          'push refused: only a human may hold a notification address',
        );
        reply.code(403).send({
          type: 'error',
          code: ERROR_PUSH_NOT_HUMAN,
          message: 'only a human may register a device for notifications',
        });
        return null;
      }
      return auth.auth;
    }

    // The PUBLIC half of the VAPID keypair, which is public by construction — it is designed to be
    // handed to every browser that subscribes. Served rather than baked so rotating it does not
    // require rebuilding the web image. Absent key = the feature is off, said plainly.
    fastify.get('/push/key', async (_req, reply) => {
      const key = process.env.PLAYROOM_VAPID_PUBLIC_KEY?.trim();
      if (!key) {
        reply.code(503);
        return {
          type: 'error',
          code: 'push_unconfigured',
          message: 'notifications are not configured',
        };
      }
      return { key };
    });

    fastify.post('/push/subscriptions', async (req, reply) => {
      const actor = await pushMember(req, reply);
      if (!actor) return reply;
      const b = (req.body ?? {}) as {
        endpoint?: unknown;
        keys?: { p256dh?: unknown; auth?: unknown };
      };
      const endpoint = typeof b.endpoint === 'string' ? b.endpoint : '';
      const p256dh = typeof b.keys?.p256dh === 'string' ? b.keys.p256dh : '';
      const authKey = typeof b.keys?.auth === 'string' ? b.keys.auth : '';
      if (!endpoint || !p256dh || !authKey) {
        reply.code(400);
        // The refusal names the SHAPE and never echoes what arrived: a malformed body may still
        // contain key material, and a message that quotes it puts that material in a log.
        return {
          type: 'error',
          code: ERROR_PUSH_MALFORMED,
          message: 'a subscription needs an endpoint and both keys',
        };
      }
      await upsertSubscription(db(), {
        principalId: actor.principal_id,
        memberId: actor.member_id,
        endpoint,
        p256dh,
        auth: authKey,
      });
      // Logged WITHOUT the endpoint: it is the address of a person's phone, and the count is what
      // an operator actually needs.
      app.log.info(
        { principal: actor.principal_id, member: actor.member_id },
        'push subscription registered',
      );
      reply.code(201);
      return { subscribed: true, devices: await countFor(db(), actor.principal_id) };
    });

    fastify.delete('/push/subscriptions', async (req, reply) => {
      const actor = await pushMember(req, reply);
      if (!actor) return reply;
      const b = (req.body ?? {}) as { endpoint?: unknown };
      const endpoint = typeof b.endpoint === 'string' ? b.endpoint : '';
      if (!endpoint) {
        reply.code(400);
        return { type: 'error', code: ERROR_PUSH_MALFORMED, message: 'an endpoint is required' };
      }
      // Scoped to the caller's principal inside the record layer, so knowing an endpoint is not
      // enough to turn off someone else's phone.
      const removed = await deleteSubscription(db(), actor.principal_id, endpoint);
      app.log.info({ principal: actor.principal_id, removed }, 'push subscription removed');
      return { subscribed: false, removed, devices: await countFor(db(), actor.principal_id) };
    });

    // A FAILED NOTIFICATION IS VISIBLE SOMEWHERE A HUMAN CAN FIND IT (S-PUSH, SP-3). A channel that
    // fails quietly is worse than none, because it is trusted: a person who believes their phone
    // will buzz stops opening the room. This is the log of what was actually attempted on their
    // behalf, with outcomes — including the refusals. Their OWN sends only, and no endpoint and no
    // key material appear in it, because neither is stored on a send row in the first place.
    fastify.get('/push/sends', async (req, reply) => {
      const actor = await pushMember(req, reply);
      if (!actor) return reply;
      const { rows } = await db().query(
        `SELECT id, room_id, interrupt_id, urgency, endpoint_origin, disclosed, outcome, detail,
                created_at
           FROM push_sends WHERE principal_id = $1
          ORDER BY created_at DESC LIMIT 50`,
        [actor.principal_id],
      );
      return { sends: rows };
    });

    // "IS THIS THING ON" — a count, and only a count. No endpoints and no key material come back
    // out of this server by any route, so there is no field to forget to strip.
    fastify.get('/push/subscriptions', async (req, reply) => {
      const actor = await pushMember(req, reply);
      if (!actor) return reply;
      return { devices: await countFor(db(), actor.principal_id) };
    });

    fastify.post('/rooms/:id/orders/:orderId/control', async (req, reply) => {
      const { id, orderId } = req.params as { id: string; orderId: string };
      const actor = await orderRouteMember(req, reply, id);
      if (!actor) return reply;
      const b = (req.body ?? {}) as { op?: unknown; client_msg_id?: unknown };
      if (b.op !== 'pause' && b.op !== 'resume' && b.op !== 'revoke') {
        reply.code(400);
        return {
          type: 'error',
          code: 'order_bad_op',
          message: 'op must be pause, resume or revoke',
        };
      }
      const result = await executeCommand(
        { actorId: actor.member_id, principalId: actor.principal_id, mode: 'human' },
        {
          kind: 'controlOrder',
          roomId: id,
          clientMsgId:
            typeof b.client_msg_id === 'string' ? b.client_msg_id : `http-ctl-${orderId}`,
          orderId,
          op: b.op,
        },
        deps,
      );
      if (!result.ok) {
        reply.code(orderRefusalStatus(result.refusal.code));
        return { type: 'error', code: result.refusal.code, message: result.refusal.message };
      }
      return { order_id: result.orderId };
    });

    fastify.patch('/rooms/:id/orders/:orderId', async (req, reply) => {
      const { id, orderId } = req.params as { id: string; orderId: string };
      const actor = await orderRouteMember(req, reply, id);
      if (!actor) return reply;
      const b = (req.body ?? {}) as Record<string, unknown>;
      const result = await executeCommand(
        { actorId: actor.member_id, principalId: actor.principal_id, mode: 'human' },
        {
          kind: 'updateOrder',
          roomId: id,
          clientMsgId:
            typeof b.client_msg_id === 'string' ? b.client_msg_id : `http-upd-${orderId}`,
          orderId,
          maxCycles: typeof b.max_cycles === 'number' ? b.max_cycles : null,
          maxUnattendedCycles:
            typeof b.max_unattended_cycles === 'number' ? b.max_unattended_cycles : 3,
          expiresAt: typeof b.expires_at === 'string' ? b.expires_at : null,
        },
        deps,
      );
      if (!result.ok) {
        reply.code(orderRefusalStatus(result.refusal.code));
        return { type: 'error', code: result.refusal.code, message: result.refusal.message };
      }
      return { order_id: result.orderId };
    });

    // ── S2.1b: THE AUTHENTICATED DOOR ─────────────────────────────────────────────────────────────
    //
    // POST /rooms/:id/actions { action, resource, client_msg_id? } → a governed request from a process
    // OUTSIDE the api (Claude Code from a laptop, Drift as a service). It authenticates a MEMBER and
    // carries no authority of its own: the credential resolves to a member, the member to a principal and
    // a mandate, and the request is ruled on against THAT mandate. Identity is DERIVED, never claimed —
    // `subject` is the credential's member and nothing in the body can change it. Nothing executes under
    // any verdict; the caller receives the verdict and, for a CO_SIGN, a decision id to poll. This is the
    // only inbound path from outside the api: every refusal is fail-closed, and an AUTH failure (401/429)
    // is kept distinct from a MANDATE refusal (a 200 carrying a BLOCK verdict).
    fastify.post('/rooms/:id/actions', async (req, reply) => {
      const roomId = (req.params as { id: string }).id;
      const token = bearerToken(req);
      const auth = await authenticate(db(), token);
      if (!auth.ok) {
        // The WIRE collapses expired/unknown/revoked into one code (credentials.ts ruling); the OPERATOR
        // distinction lives here in the log, never in the response. Diagnosed only for a present token.
        const detail =
          auth.failure === 'credential_required'
            ? 'missing'
            : await diagnoseCredential(db(), token ?? '');
        app.log.warn({ room_id: roomId, reason: detail }, 'action door: credential refused');
        reply.code(401).send(credentialRefusal(auth.failure, roomId));
        return;
      }
      // CREDENTIAL-KEYED THROTTLE, after auth. A throttled caller learns nothing new — same shape as any
      // other request, just a 429.
      if (actionThrottled(auth.auth.credential_id)) {
        app.log.warn(
          { room_id: roomId, credential: auth.auth.credential_id },
          'action door throttled',
        );
        reply.code(429);
        return {
          type: 'error',
          code: 'action_throttled',
          message: 'too many requests — slow down',
        };
      }
      // THE BODY SAYS WHAT IT WANTS, NEVER WHO IT IS. Only `action` and `resource` are read; a `subject`
      // or `member` in the body is ignored, because the subject is the credential's member. Bounded and
      // type-checked before the evaluator — a malformed or hostile body is a 400, never a throw.
      const b = (req.body ?? {}) as Record<string, unknown>;
      const action = b.action;
      const resource = b.resource;
      if (
        typeof action !== 'string' ||
        action.length < 1 ||
        action.length > 64 ||
        typeof resource !== 'string' ||
        resource.length < 1 ||
        resource.length > 512
      ) {
        reply.code(400);
        return {
          type: 'error',
          code: 'action_malformed',
          message: 'action and resource are required strings (action ≤64, resource ≤512 chars)',
        };
      }
      const clientMsgId =
        typeof b.client_msg_id === 'string' && b.client_msg_id.length <= 128
          ? b.client_msg_id
          : `door-${randomUUID()}`;
      if (!(await getRoom(db(), roomId))) {
        reply.code(404).send(roomNotFound(roomId));
        return;
      }
      // IDENTITY DERIVED: subject is the credential's member; mode is `connected` (ADR-004 — this door IS
      // the connector). requestAction stays the sole decision constructor: it evaluates, records, and
      // RETURNS the verdict — it never executes.
      const decided = await executeCommand(
        { actorId: auth.auth.member_id, principalId: auth.auth.principal_id, mode: 'connected' },
        {
          kind: 'requestAction',
          roomId,
          clientMsgId,
          subject: auth.auth.member_id,
          action,
          resource,
        },
        deps,
      );
      if (!decided.ok) {
        // subject === actor here, so standing is always `self` and this is unreachable in practice; kept
        // as a fail-closed guard rather than a claim it cannot happen.
        reply.code(422);
        return { type: 'error', code: decided.refusal.code, message: decided.refusal.message };
      }
      reply.code(200);
      return {
        decision: decided.verdict.decision,
        reason_code: decided.verdict.reason_code,
        required_signer: decided.verdict.required_signer,
        effective_mandate_hash: decided.verdict.effective_mandate_hash,
        decision_id: decided.decisionId,
        // WAIT WELL (SCC-3): a CO_SIGN hands back an honest interval to wait before the FIRST poll. A
        // fresh decision is never expired, so the hint applies whenever there is a decision to poll;
        // ALLOW/BLOCK carry no decision and so no hint. A number, never a callback.
        poll_after_ms: decided.decisionId ? DECISION_POLL_HINT_MS : null,
      };
    });

    // GET /rooms/:id/decisions/:decisionId → the fate of a decision, for the caller that raised a CO_SIGN
    // to POLL. Playroom never calls the caller back (no webhook, no inbound to a laptop); the caller asks.
    fastify.get('/rooms/:id/decisions/:decisionId', async (req, reply) => {
      const { id: roomId, decisionId } = req.params as { id: string; decisionId: string };
      const auth = await authenticate(db(), bearerToken(req));
      if (!auth.ok) {
        reply.code(401).send(credentialRefusal(auth.failure, roomId));
        return;
      }
      const ev = await decisionEventById(db(), roomId, decisionId);
      if (!ev || ev.event_type !== 'decision') {
        reply.code(404);
        return {
          type: 'error',
          code: 'decision_unknown',
          message: 'no such decision in this room',
        };
      }
      const d = ev.payload;
      const res = await decisionResolutionEvent(db(), roomId, decisionId);
      const resolved = res && res.event_type === 'decision.resolved' ? res.payload : null;
      // THE BACKOFF HINT (SCC-3, closes SCC2-N2): a number the caller may honour before its next poll —
      // never a connection this server opens. It is offered ONLY while the decision can still resolve:
      // a resolved one is done, and an unresolved-but-EXPIRED one will never resolve, so suggesting a
      // retry for either would be the spin this closes. `ev.ts` is the decision's opened-at.
      const stillOpen = !resolved && !isExpired(ev.ts, new Date(), decisionExpiryMs());
      reply.code(200);
      return {
        decision_id: decisionId,
        decision: d.decision,
        reason_code: d.reason_code,
        required_signer: d.required_signer,
        effective_mandate_hash: d.effective_mandate_hash,
        status: resolved ? 'resolved' : 'pending',
        resolution: resolved ? resolved.resolution : null,
        signed_by: resolved ? resolved.signed_by : null,
        poll_after_ms: stillOpen ? DECISION_POLL_HINT_MS : null,
      };
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

    // POST /redeem → a room code becomes a credential and a seat.
    //
    // ── THE ONLY UNAUTHENTICATED WRITE IN THE API, AND THAT IS THE POINT ──
    //
    // RT-002 closed the last one in S1.3c by putting `POST /rooms` behind a credential, and this
    // deliberately opens a new one — because it is the endpoint whose entire job is to give a
    // credential to someone who has none. A code cannot be redeemed into anything but a guest seat
    // (`mintRoomCode` refuses a non-guest principal), it is single-use, it expires, and it grants
    // membership of exactly the one room it was minted for.
    //
    // ONE REFUSAL OUTWARD. Wrong code, expired code and already-spent code are all 404 with the
    // same body: distinguishing them tells someone holding a guessed string that they guessed a
    // real one. The operator's version is in the log line and in the row.
    //
    // NOT RATE LIMITED, AND THAT IS A GAP. A four-character code from a 30-character alphabet is
    // ~810,000 possibilities and nothing here slows a script down. Logged as a finding rather than
    // half-solved: the mitigations that matter today are that a hit costs the attacker a seat which
    // then visibly cannot be claimed, only two seats exist, and this is not yet on a public URL.
    fastify.post('/redeem', async (req, reply) => {
      // SLIVE-N1: THROTTLE FIRST, before touching the database or telling the caller anything about
      // the code. A throttled attempt learns nothing — same shape as a wrong code, just a 429 — so
      // the limit cannot be used as its own oracle. Keyed on the client IP (trustProxy, above).
      if (redeemThrottled(req.ip)) {
        app.log.warn({ ip: req.ip }, 'redeem throttled');
        reply.code(429);
        return { error: 'too many attempts — please wait a few minutes and try again' };
      }
      const body = (req.body ?? {}) as { code?: unknown; display_name?: unknown };
      if (typeof body.code !== 'string' || typeof body.display_name !== 'string') {
        reply.code(400);
        return { error: 'code and display_name are required' };
      }
      try {
        const redemption = await redeemRoomCode(db(), body.code, body.display_name);
        app.log.info(
          {
            room_id: redemption.room_id,
            member: redemption.member_id,
            agent: redemption.agent_id,
            expires_at: redemption.expires_at,
          },
          'room code redeemed',
        );
        // The plaintext credential, once. The caller is the web tier's BFF, which puts it straight
        // into an httpOnly cookie — it is NOT logged, for the same reason a ticket is not.
        return redemption;
      } catch (err) {
        if (err instanceof RedeemRefused) {
          app.log.warn({ reason: err.reason }, 'room code refused');
          reply.code(err.reason === 'name_required' ? 400 : 404);
          return {
            error:
              err.reason === 'name_required'
                ? 'a name is required'
                : 'that code does not work — check it with whoever sent it',
          };
        }
        throw err;
      }
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

    // GET /rooms/:id/history — a bounded page of the transcript, from the event log (S16b).
    //
    // ── THE READ SIDE OF THE SOCKET'S OWN REPLAY ──
    //
    // S1.6 moved the AGENT off full-transcript replay — the summary folds the older span and a turn
    // sees a bounded window. This does the same for the CLIENT: it loads a recent window on open and
    // pages older history on demand, instead of the socket replaying every event of a long room
    // (S16-N2) or resuming from a stale cursor and showing a truncated room (S16-N1).
    //
    //   no `before`    → THE RECENT WINDOW: events after the summary's coverage floor — the SAME floor
    //                    the assembly window uses, so the client shows exactly the span the summary
    //                    folded up to, never a different recent set (item 15).
    //   ?before=<seq>  → AN OLDER PAGE: the events just before that cursor, bounded by `limit`.
    //
    // `has_older` says whether a further page exists, so the client only offers "load older" when it
    // would do something. Windowed-by-design, not truncated-by-accident: everything below the window is
    // still in the log and still one request away.
    //
    // BEARER AND MEMBERSHIP, exactly as `GET /rooms/:id` — and NOT the ticket path: a page is an
    // ordinary authenticated read, not a socket, so it authenticates the way every other read does.
    fastify.get('/rooms/:id/history', async (req, reply) => {
      const { id } = req.params as { id: string };
      const auth = await authenticate(db(), bearerToken(req));
      if (!auth.ok) {
        app.log.warn({ room_id: id, code: auth.failure }, 'history refused: no usable credential');
        reply.code(401);
        return credentialRefusal(auth.failure, id);
      }
      const access = await roomAccess(db(), id, auth.auth.member_id);
      if (!access.room_exists || !access.is_member) {
        app.log.warn(
          {
            room_id: id,
            member: auth.auth.member_id,
            reason: access.room_exists ? 'not_in_room' : 'no_room',
          },
          'history refused',
        );
        reply.code(404);
        return roomNotFound(id);
      }
      const q = req.query as { before?: string; limit?: string };
      const limit = Math.min(
        Math.max(1, Number(q.limit) || HISTORY_PAGE_DEFAULT),
        HISTORY_PAGE_MAX,
      );
      // A page before a cursor, or — with no cursor — the recent window: events after the summary
      // floor, the same floor the agent's context window uses.
      const events =
        q.before !== undefined
          ? await eventsBefore(db(), id, Number(q.before) || 0, limit)
          : await eventsAfter(db(), id, await roomWindowFloor(db(), id));
      const oldest = events[0]?.seq;
      const has_older = oldest !== undefined ? await hasEventsBefore(db(), id, oldest) : false;
      // THE ACTIVE BRIEFING (S1.7), as a SEPARATE top-level field — NOT interleaved into `events`. A
      // briefing is PINNED, not a message with a seq: folding it into the paginated feed would put it on
      // the first page only (or on every page) and distort the cursor. As its own field it fits the
      // endpoint's shape and lets a PULLER (claude-code reads history; it is never summoned) inherit the
      // same framing a summoned member gets — the second delivery point. Null when the room has none.
      // Cheaper than a dedicated GET /rooms/:id/briefing: no new route, and no extra round-trip for a
      // puller that already fetches history to read the room.
      const active = await activeBriefing(db(), id);
      const briefing = active
        ? {
            briefing_id: active.id,
            content: active.content,
            content_hash: active.content_hash,
            purpose: active.purpose,
            set_by: active.set_by,
            set_at: active.created_at,
          }
        : null;
      // THE DOCUMENTS (S-UPLOAD), as their own top-level field, for the same reasons the briefing is
      // one: they are PINNED rather than paginated, and a PULLER must inherit what a summoned member
      // gets. Without this a document would reach `claude-audit` and not `claude-code`, which is the
      // asymmetry S1.7 built the briefing's second delivery point to avoid.
      //
      // THE BODY IS INCLUDED HERE, unlike in the event payload: a puller reading history is doing what
      // a summoned member's assembly does — collecting the context it is about to work from — and a
      // manifest it cannot read would just force a second round trip for the thing it came for.
      const documents = (await activeDocuments(db(), id)).map((d) => ({
        document_id: d.id,
        title: d.title,
        purpose: d.purpose,
        provenance: d.provenance,
        content: d.content,
        content_hash: d.content_hash,
        size_chars: d.size_chars,
        uploaded_by: d.uploaded_by,
        uploaded_at: d.created_at,
      }));
      return { events, has_older, briefing, documents };
    });

    // POST /rooms/:id/messages { body, client_msg_id? } — the SPEAK half of a connected member's minimum
    // surface (SCC-2): a puller that read the transcript above posts back into it, over HTTP, outbound
    // only. ATTRIBUTION IS DERIVED, exactly as the door does it — the author is the credential's member,
    // never a name from the body. It reuses postMessage, the one message construction site; it adds none.
    fastify.post('/rooms/:id/messages', async (req, reply) => {
      const roomId = (req.params as { id: string }).id;
      const auth = await authenticate(db(), bearerToken(req));
      if (!auth.ok) {
        reply.code(401);
        return credentialRefusal(auth.failure, roomId);
      }
      // The same membership gate the read half uses: a non-member gets the room-not-found silence, so the
      // door cannot be used to probe which rooms exist or who is in them.
      const access = await roomAccess(db(), roomId, auth.auth.member_id);
      if (!access.room_exists || !access.is_member) {
        reply.code(404);
        return roomNotFound(roomId);
      }
      const b = (req.body ?? {}) as Record<string, unknown>;
      const body = b.body;
      if (typeof body !== 'string' || body.length < 1 || body.length > 8000) {
        reply.code(400);
        return {
          type: 'error',
          code: 'message_malformed',
          message: 'body is a required string (≤8000 chars)',
        };
      }
      const clientMsgId =
        typeof b.client_msg_id === 'string' && b.client_msg_id.length <= 128
          ? b.client_msg_id
          : `msg-${randomUUID()}`;
      const event = await executeCommand(
        { actorId: auth.auth.member_id, principalId: auth.auth.principal_id, mode: 'connected' },
        { kind: 'postMessage', roomId, clientMsgId, body },
        deps,
      );
      reply.code(201);
      return { seq: event.seq, actor_id: event.actor_id };
    });

    // POST /rooms/:id/interrupts { urgency, reason, client_msg_id? } — a connected member RAISES A BARE
    // HAND (SCC-3): a standalone BLOCKER or FYI, the non-decision concern SCC2-N1 said the door could not
    // surface. It is NOT a co-sign: no decision event is minted, and DECISION urgency is rejected here so
    // a hand can never masquerade as one. The reason is a SHORT string, bounded before anything is
    // written. Attribution and addressee are DERIVED (the credential's member, and that member's
    // principal's humans) — the body says what is wrong, never who raised it or whom to reach. The daily
    // interrupt budget binds it; an exhausted budget refuses with its own named code.
    fastify.post('/rooms/:id/interrupts', async (req, reply) => {
      const roomId = (req.params as { id: string }).id;
      const auth = await authenticate(db(), bearerToken(req));
      if (!auth.ok) {
        reply.code(401);
        return credentialRefusal(auth.failure, roomId);
      }
      const access = await roomAccess(db(), roomId, auth.auth.member_id);
      if (!access.room_exists || !access.is_member) {
        reply.code(404);
        return roomNotFound(roomId);
      }
      const b = (req.body ?? {}) as Record<string, unknown>;
      // A raised hand is a BLOCKER or an FYI, case-insensitively. DECISION is refused: it is the co-sign
      // path's urgency and accompanies a real decision — a standalone hand must not be able to mint one.
      const urgency = typeof b.urgency === 'string' ? b.urgency.toUpperCase() : '';
      if (urgency !== 'BLOCKER' && urgency !== 'FYI') {
        reply.code(400);
        return {
          type: 'error',
          code: 'interrupt_malformed',
          message: 'urgency must be "blocker" or "fyi"',
        };
      }
      const reason = b.reason;
      if (typeof reason !== 'string' || reason.length < 1 || reason.length > 1000) {
        reply.code(400);
        return {
          type: 'error',
          code: 'interrupt_malformed',
          message: 'reason is a required string (a short sentence, ≤1000 chars)',
        };
      }
      const clientMsgId =
        typeof b.client_msg_id === 'string' && b.client_msg_id.length <= 128
          ? b.client_msg_id
          : `hand-${randomUUID()}`;
      if (!(await getRoom(db(), roomId))) {
        reply.code(404).send(roomNotFound(roomId));
        return;
      }
      const result = await executeCommand(
        { actorId: auth.auth.member_id, principalId: auth.auth.principal_id, mode: 'connected' },
        // Validated to exactly these two above; the cast carries that past the string-typed body.
        { kind: 'raiseHand', roomId, clientMsgId, urgency: urgency as 'BLOCKER' | 'FYI', reason },
        deps,
      );
      if (result.raised.length === 0) {
        if (result.refused) {
          // THE PRICED CLAIM WAS REFUSED, not the concern — a daily rate hit, named so the agent can stop
          // or continue without escalating. 429 (a limit), and its code distinguishes it from the action
          // throttle and from every other refusal the door produces.
          reply.code(429);
          return {
            type: 'error',
            code: result.refused.code,
            message: 'no interrupt budget left today',
            budget: {
              limit: result.refused.budget.limit,
              spent: result.refused.budget.spent,
              remaining: result.refused.budget.remaining,
            },
          };
        }
        // No human behind the raiser's principal is in this room to reach. Fail-closed and legible: a
        // hand with nobody to raise it to is refused, not silently dropped.
        reply.code(422);
        return {
          type: 'error',
          code: 'no_human_addressee',
          message: 'no human to raise a hand to in this room',
        };
      }
      reply.code(201);
      return {
        raised: true,
        interrupts: result.raised.map((r) => ({
          interrupt_id: r.interrupt_id,
          addressed_to: r.addressed_to,
          budget_remaining: r.budget_remaining,
        })),
      };
    });

    // POST /mcp — the remote MCP server (B1). "Make the infrastructure disappear": a Claude subscription
    // drives a room through the SAME command layer as every other surface, reached now as MCP tools instead
    // of REST. Auth is identical to the SCC door — a Bearer credential resolves to a member — and the tools
    // carry no authority of their own (@playroom/hosts wraps executeCommand, adding no business logic). One
    // real difference from the door: a member/subject is NEVER a tool argument; identity is the credential's.
    //
    // Stateless Streamable-HTTP: authenticate here, then hijack the reply so Fastify does not also answer,
    // and hand the raw socket to a per-request transport bound to this identity. GET/DELETE (SSE sessions)
    // are not offered — a room's state lives in Postgres, so there is no session to stream or to end.
    fastify.post('/mcp', async (req, reply) => {
      const auth = await authenticate(db(), bearerToken(req));
      if (!auth.ok) {
        app.log.warn({ code: auth.failure }, 'mcp: credential refused');
        reply.code(401);
        return credentialRefusal(auth.failure);
      }
      // THE SAME per-credential bound the SCC door applies (S2.1b). B1 introduces exactly the caller that
      // control exists for — a looping autonomous subscription on an internet-facing surface — so the MCP
      // door must not grant a governed-request rate the action door refuses. Applied per request, it bounds
      // the WHOLE write surface (post_message and request_action alike), not just one tool. Before hijack.
      if (actionThrottled(auth.auth.credential_id)) {
        app.log.warn({ credential: auth.auth.credential_id }, 'mcp: throttled');
        reply.code(429);
        return { type: 'error', code: 'mcp_throttled', message: 'too many requests — slow down' };
      }
      reply.hijack();
      // After hijack Fastify neither answers nor reaps the reply, so a rejection out of the handler would
      // dangle the socket. handleRequest itself always writes a response, but the guard covers the setup
      // before it (and any future edit) — an internet-facing door must not be able to leak a connection.
      try {
        await handleMcpRequest(
          req.raw,
          reply.raw,
          req.body,
          { memberId: auth.auth.member_id, principalId: auth.auth.principal_id },
          deps,
        );
      } catch (err) {
        app.log.error({ err }, 'mcp: handler failed');
        if (!reply.raw.headersSent) {
          try {
            reply.raw.writeHead(500);
          } catch {
            /* headers already flushed by the transport */
          }
        }
        reply.raw.destroy();
      }
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
        // The per-room meter's authoritative baseline, summed once at connect (S1.6). Scoped to
        // `helloSeq`: it is the spend up to the high-water mark the client is told, so the client's
        // live increment (turns/summaries after that seq) picks up exactly where this leaves off,
        // with no gap and no double count.
        const roomSpent = await roomSpend(db(), roomId);
        send(
          ServerHello.parse({
            type: 'hello',
            last_seq: helloSeq,
            member_id: result.auth.member_id,
            room_spent_usd: roomSpent,
          }),
        );
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
            if (msg.type === 'sign_decision') {
              // COMPLETE A CO-SIGNATURE (S2.2). The actor is the authenticated member, and that IS
              // the authorisation: the command refuses anyone who is not the human bound to the
              // decision's required principal — so an agent socket cannot sign, whatever it sends.
              const result = await executeCommand(
                { actorId: actor.member_id, principalId: actor.principal_id, mode: 'human' },
                {
                  kind: 'signDecision',
                  roomId,
                  clientMsgId: msg.client_msg_id,
                  decisionId: msg.decision_id,
                  resolution: msg.resolution,
                },
                deps,
              );
              // Refused to the CALLER, typed, its own code, a sentence naming the constraint —
              // wrong signer names the required signer (not an oracle: the card shows it). The socket
              // stays open; this is one signature refused, not an identity problem.
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
            if (msg.type === 'order_create') {
              // CREATE A STANDING ORDER (S-LOOP). The creator is the authenticated member; the command
              // refuses a non-human, so an agent socket cannot mint one. max_unattended_cycles defaults
              // to 3 here when the frame omits it (the attendance dial's config default).
              const result = await executeCommand(
                { actorId: actor.member_id, principalId: actor.principal_id, mode: 'human' },
                {
                  kind: 'createOrder',
                  roomId,
                  clientMsgId: msg.client_msg_id,
                  triggerEventType: msg.trigger_event_type,
                  triggerMember: msg.trigger_member,
                  actionMember: msg.action_member,
                  maxCycles: msg.max_cycles ?? null,
                  maxUnattendedCycles: msg.max_unattended_cycles ?? 3,
                  expiresAt: msg.expires_at ?? null,
                  // Absent stays absent: the command refuses it by name (S-TASK).
                  task: msg.task,
                },
                deps,
              );
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
            if (msg.type === 'order_control') {
              // PAUSE / RESUME / REVOKE (S-LOOP). Any human pauses; only the creator resumes or
              // revokes; an agent does none — all checked against the authenticated member by the command.
              const result = await executeCommand(
                { actorId: actor.member_id, principalId: actor.principal_id, mode: 'human' },
                {
                  kind: 'controlOrder',
                  roomId,
                  clientMsgId: msg.client_msg_id,
                  orderId: msg.order_id,
                  op: msg.op,
                },
                deps,
              );
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
            if (msg.type === 'briefing_set') {
              // SET OR REPLACE THE ROOM'S BRIEFING (S1.7). The actor is the authenticated member; the
              // command refuses anyone who is not the room's human owner, so an agent socket — or a
              // human who is not the owner — cannot set one, whatever this frame says. It confers no
              // authority: the command writes framing, never a mandate field.
              const result = await executeCommand(
                { actorId: actor.member_id, principalId: actor.principal_id, mode: 'human' },
                {
                  kind: 'setBriefing',
                  roomId,
                  clientMsgId: msg.client_msg_id,
                  content: msg.content,
                  purpose: msg.purpose,
                },
                deps,
              );
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
            if (msg.type === 'briefing_clear') {
              // CLEAR THE ROOM'S BRIEFING (S1.7). Owner-only and human-only, like the set; a room with
              // no active briefing is refused (nothing to clear), not silently no-op'd.
              const result = await executeCommand(
                { actorId: actor.member_id, principalId: actor.principal_id, mode: 'human' },
                { kind: 'clearBriefing', roomId, clientMsgId: msg.client_msg_id },
                deps,
              );
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
            if (msg.type === 'document_upload') {
              // GIVE THE ROOM A DOCUMENT (S-UPLOAD). The actor is the authenticated member; the command
              // refuses any non-human BY KIND — before the screen and the caps — so an agent socket
              // cannot give a room a document whatever this frame says. Reference material, pinned into
              // every summon and inert: it confers no authority and can no more act than a briefing can.
              const result = await executeCommand(
                { actorId: actor.member_id, principalId: actor.principal_id, mode: 'human' },
                {
                  kind: 'uploadDocument',
                  roomId,
                  clientMsgId: msg.client_msg_id,
                  title: msg.title,
                  purpose: msg.purpose,
                  provenance: msg.provenance,
                  declaredType: msg.declared_type,
                  content: msg.content,
                },
                deps,
              );
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
            if (msg.type === 'document_remove') {
              // TAKE A DOCUMENT BACK (S-UPLOAD). Human-only, like giving one; the command refuses a
              // non-human, and an unknown or already-removed document, each by its own named reason.
              const result = await executeCommand(
                { actorId: actor.member_id, principalId: actor.principal_id, mode: 'human' },
                {
                  kind: 'removeDocument',
                  roomId,
                  clientMsgId: msg.client_msg_id,
                  documentId: msg.document_id,
                },
                deps,
              );
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
            if (msg.type === 'downgrade') {
              // ONE TAP, and it costs the raiser (Bible §21.3). The actor is the authenticated
              // member, which is also the authorisation: only the member an interrupt is
              // ADDRESSED TO may lower its claim on them.
              const result = await downgradeInterrupt(db(), msg.interrupt_id, actor.member_id);
              if (!result.ok) {
                app.log.warn(
                  { room_id: roomId, member: actor.member_id, reason: result.failure },
                  'downgrade refused',
                );
                // ONE REFUSAL FOR THREE REASONS. Unknown, not-yours and already-lowest are told
                // apart in the log and not to the caller: distinguishing them would say whether
                // an interrupt exists and who it is addressed to, which is a claim about someone
                // else's attention that a stranger has no business reading.
                socket.send(
                  JSON.stringify(
                    ServerErrorFrame.parse({
                      type: 'error',
                      code: ERROR_DOWNGRADE_REFUSED,
                      message: 'that interrupt cannot be lowered',
                      room_id: roomId,
                    }),
                  ),
                );
                return;
              }
              bus.publish(roomId, result.event);
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
