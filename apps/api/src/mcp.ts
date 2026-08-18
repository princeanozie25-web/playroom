import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  buildRoomMcpServer,
  RoomMcpError,
  type RoomMcpPort,
  type RoomSummary,
  type RoomView,
} from '@playroom/hosts';
import { executeCommand, type CommandDeps } from './commands/index.js';
import { getRoom, eventsAfter, roomWindowFloor, listRoomsForMember } from './events.js';
import { isRoomMember, listRoomMembers } from './members.js';
import { activeBriefing } from './briefings.js';
import { DECISION_POLL_HINT_MS } from './decisions.js';

// The MCP host mounted in apps/api (B1). It IMPLEMENTS @playroom/hosts' RoomMcpPort — the package owns the
// tool shapes, this owns the wiring to the trust fabric. There is exactly one new idea here and it is not a
// new authority: a Claude subscription reaches a room the same way the SCC door does — a Bearer credential
// resolves to a member, and every write dispatches through executeCommand. What is NEW is only the surface.
//
// IDENTITY IS DERIVED, NEVER CLAIMED. The acting member is the credential's, fixed on the port; no tool takes
// a member/subject argument (buildRoomMcpServer enforces the shapes). The body says what it wants, never who
// it is — the same rule the door holds, now for MCP.

export interface McpIdentity {
  memberId: string;
  principalId: string | null;
}

/** Pull a message body out of an event payload, or null — a read convenience, never trusted for a write. */
function bodyOf(payload: unknown): string | null {
  if (payload && typeof payload === 'object' && 'body' in payload) {
    const b = (payload as { body: unknown }).body;
    if (typeof b === 'string') return b;
  }
  return null;
}

/**
 * Normalise a timestamp to an ISO-8601 string. node-postgres delivers a timestamptz as a JS Date (no type
 * parser is configured), and RoomRow types the column as `string` — so coerce explicitly here rather than
 * lean on JSON.stringify(Date), the same guard rowToServerEvent applies to event timestamps.
 */
function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

/**
 * A RoomMcpPort bound to one authenticated member. Reads are scoped to that member; writes carry their
 * attribution from `identity.memberId` and dispatch through executeCommand — the SAME trust fabric the room
 * service, the WS and the SCC door use. A package cannot reach executeCommand; this closure hands it in.
 */
export function roomMcpPortFor(identity: McpIdentity, deps: CommandDeps): RoomMcpPort {
  const pool = deps.pool;
  const ctx = {
    actorId: identity.memberId,
    principalId: identity.principalId ?? undefined,
    mode: 'connected' as const,
  };
  const clientMsg = (given?: string) => given ?? `mcp-${randomUUID()}`;

  // The uniform membership gate. A member only touches a room they belong to, and a non-member gets the SAME
  // room_not_found a missing room gets — no probing which rooms exist or who is in them (server.ts's rule).
  const requireMember = async (roomId: string): Promise<void> => {
    if (!(await isRoomMember(pool, roomId, identity.memberId))) {
      throw new RoomMcpError('room_not_found', 'no such room, or you are not a member of it');
    }
  };

  return {
    memberId: identity.memberId,

    async listRooms(): Promise<RoomSummary[]> {
      const rooms = await listRoomsForMember(pool, identity.memberId);
      return rooms.map((r) => ({
        id: r.id,
        title: r.title,
        created_at: toIso(r.created_at),
        created_by: r.created_by,
      }));
    },

    async readRoom(roomId: string): Promise<RoomView> {
      await requireMember(roomId);
      const room = await getRoom(pool, roomId);
      if (!room) {
        throw new RoomMcpError('room_not_found', 'no such room, or you are not a member of it');
      }
      const members = (await listRoomMembers(pool, roomId)).map((m) => m.id);
      const events = await eventsAfter(pool, roomId, await roomWindowFloor(pool, roomId));
      const recent = events.map((e) => ({
        seq: e.seq,
        ts: e.ts,
        type: e.event_type,
        actor: e.actor_id,
        body: bodyOf(e.payload),
      }));
      const active = await activeBriefing(pool, roomId);
      const briefing = active
        ? { content: active.content, purpose: active.purpose, set_by: active.set_by }
        : null;
      return {
        id: room.id,
        title: room.title,
        created_by: room.created_by,
        members,
        recent,
        briefing,
      };
    },

    async postMessage({ roomId, body, clientMsgId }) {
      await requireMember(roomId);
      const ev = await executeCommand(
        ctx,
        { kind: 'postMessage', roomId, clientMsgId: clientMsg(clientMsgId), body },
        deps,
      );
      return { seq: ev.seq };
    },

    async requestAction({ roomId, action, resource, clientMsgId }) {
      await requireMember(roomId);
      // subject is the credential's member — the door's rule (identity derived), so basis is always 'self'.
      const decided = await executeCommand(
        ctx,
        {
          kind: 'requestAction',
          roomId,
          clientMsgId: clientMsg(clientMsgId),
          subject: identity.memberId,
          action,
          resource,
        },
        deps,
      );
      if (!decided.ok) throw new RoomMcpError(decided.refusal.code, decided.refusal.message);
      return {
        decision: decided.verdict.decision,
        reason_code: decided.verdict.reason_code,
        required_signer: decided.verdict.required_signer,
        effective_mandate_hash: decided.verdict.effective_mandate_hash,
        decision_id: decided.decisionId,
        // A fresh decision is never expired, so the poll hint applies whenever there is one to poll.
        poll_after_ms: decided.decisionId ? DECISION_POLL_HINT_MS : null,
      };
    },

    async respondToDecision({ roomId, decisionId, resolution, clientMsgId }) {
      await requireMember(roomId);
      const res = await executeCommand(
        ctx,
        {
          kind: 'signDecision',
          roomId,
          clientMsgId: clientMsg(clientMsgId),
          decisionId,
          resolution,
        },
        deps,
      );
      if (!res.ok) throw new RoomMcpError(res.refusal.code, res.refusal.message);
      return { ok: true };
    },

    async raiseHand({ roomId, urgency, reason, clientMsgId }) {
      await requireMember(roomId);
      const res = await executeCommand(
        ctx,
        { kind: 'raiseHand', roomId, clientMsgId: clientMsg(clientMsgId), urgency, reason },
        deps,
      );
      // The door's /interrupts semantics: nobody reached is a refusal, not a silent success.
      if (res.raised.length === 0) {
        if (res.refused) throw new RoomMcpError(res.refused.code, 'no interrupt budget left today');
        throw new RoomMcpError('no_human_addressee', 'no human to raise a hand to in this room');
      }
      return {
        addressed: res.addressed,
        raised: res.raised.length,
        refused: res.refused ? res.refused.code : null,
      };
    },
  };
}

/**
 * Serve one MCP request over the Streamable-HTTP transport, STATELESS: a fresh server + transport per
 * request, each bound to the already-authenticated identity. Stateless because a room's state lives in
 * Postgres, not in an MCP session — there is nothing to keep between calls, and per-request construction is
 * what makes the identity un-spoofable (it is closed over, never read from the wire). `enableJsonResponse`
 * returns a single JSON body rather than an SSE stream, which is the whole of a request/response tool call.
 *
 * The caller (server.ts) authenticates and hijacks the reply BEFORE handing the raw socket here.
 */
export async function handleMcpRequest(
  rawReq: IncomingMessage,
  rawRes: ServerResponse,
  body: unknown,
  identity: McpIdentity,
  deps: CommandDeps,
): Promise<void> {
  const server = buildRoomMcpServer(roomMcpPortFor(identity, deps), {
    // An unexpected tool fault is logged HERE (the host has the logger) and returned to the caller opaque —
    // its raw message never crosses the wire to the model. Governed refusals (RoomMcpError) are unaffected.
    onError: (e) =>
      deps.log.error(
        { err: e instanceof Error ? { message: e.message, stack: e.stack } : String(e) },
        'mcp: unexpected tool fault',
      ),
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  rawRes.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(rawReq, rawRes, body);
}
