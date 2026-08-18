import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RoomMcpError, type RoomMcpPort } from './port.js';

// buildRoomMcpServer — the room, as MCP tools (B1). An ADAPTER OVER COMMANDS: every tool validates its
// input and calls one RoomMcpPort method, which the host has already bound to an authenticated member.
// There is no business logic here and no identity argument on any tool — the acting member is the port's,
// derived from a credential, so the fabric rules on WHO the credential is, never on a name a tool passed.
//
// Streamable-HTTP transport, stateless, is mounted by the host (apps/api). This function only builds the
// server + its tool set, so it is pure and unit-testable against a fake port.

// Bounds mirror the SCC HTTP door exactly (server.ts), so the two front-ends refuse the same oversized
// input the same way rather than drifting.
const ROOM_ID = z.string().min(1).max(128).describe('The room id.');
const CLIENT_MSG_ID = z
  .string()
  .max(128)
  .optional()
  .describe('Optional idempotency key; a repeat with the same value collapses to one write.');

/** A tool result carrying JSON text. */
function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/** A governed refusal, rendered as an MCP error result rather than a thrown fault. */
function refusal(e: RoomMcpError) {
  return {
    content: [{ type: 'text' as const, text: `refused (${e.code}): ${e.message}` }],
    isError: true as const,
  };
}

/** The OPAQUE result for an unexpected fault — never the raw message (see makeRun). */
function internalError() {
  return {
    content: [
      { type: 'text' as const, text: 'refused (internal_error): an unexpected error occurred' },
    ],
    isError: true as const,
  };
}

/**
 * Run a port call. A {@link RoomMcpError} is a governed refusal → an error RESULT the caller may read.
 * ANYTHING ELSE is an unexpected fault, and it must NOT be re-thrown: the MCP SDK turns a thrown error into a
 * tool result carrying `error.message` verbatim, which would leak Postgres/TypeScript internals to the model
 * on the other end of an internet-facing surface. So an unexpected fault is reported server-side through
 * `onError` (which the host wires to its logger) and returned to the caller as an OPAQUE `internal_error`.
 */
function makeRun(onError?: (e: unknown) => void) {
  return async (fn: () => Promise<unknown>) => {
    try {
      return ok(await fn());
    } catch (e) {
      if (e instanceof RoomMcpError) return refusal(e);
      onError?.(e);
      return internalError();
    }
  };
}

export function buildRoomMcpServer(
  port: RoomMcpPort,
  opts: { onError?: (e: unknown) => void } = {},
): McpServer {
  const run = makeRun(opts.onError);
  const server = new McpServer(
    { name: 'playroom', version: '0.1.0' },
    {
      instructions:
        `Playroom: a governed multi-agent workspace. You act as member "${port.memberId}". Read rooms ` +
        `you belong to, post messages, and ask the trust fabric to rule on governed actions (nothing ` +
        `executes — you receive a verdict, and for a co-sign a decision_id to poll with respond_to_decision ` +
        `once a human has signed). You cannot act as anyone else: your identity is fixed by your credential.`,
    },
  );

  server.registerTool(
    'list_rooms',
    {
      title: 'List rooms',
      description: 'List the rooms you are a member of.',
    },
    () => run(() => port.listRooms()),
  );

  server.registerTool(
    'read_room',
    {
      title: 'Read a room',
      description:
        'Read a room you belong to: its roster, recent transcript, and active briefing. Refuses a room ' +
        'you are not a member of the same way it refuses one that does not exist.',
      inputSchema: { room_id: ROOM_ID },
    },
    ({ room_id }) => run(() => port.readRoom(room_id)),
  );

  server.registerTool(
    'post_message',
    {
      title: 'Post a message',
      description:
        'Post a message into a room. Attribution is derived from your credential, not this call.',
      inputSchema: {
        room_id: ROOM_ID,
        body: z.string().min(1).max(8000).describe('The message text.'),
        client_msg_id: CLIENT_MSG_ID,
      },
    },
    ({ room_id, body, client_msg_id }) =>
      run(() => port.postMessage({ roomId: room_id, body, clientMsgId: client_msg_id })),
  );

  server.registerTool(
    'request_action',
    {
      title: 'Request a governed action',
      description:
        'Ask the trust fabric to rule on an action (e.g. "pr.merge") under your mandate. NOTHING EXECUTES: ' +
        'you receive the verdict (ALLOW / CO_SIGN / BLOCK), and for a CO_SIGN a decision_id and a ' +
        'poll_after_ms interval to wait before checking whether a human has signed.',
      inputSchema: {
        room_id: ROOM_ID,
        action: z
          .string()
          .min(1)
          .max(64)
          .describe('The action type, e.g. "pr.review" or "pr.merge".'),
        resource: z
          .string()
          .min(1)
          .max(512)
          .describe('What the action is against, e.g. "repo:owner/name#pr-1".'),
        client_msg_id: CLIENT_MSG_ID,
      },
    },
    ({ room_id, action, resource, client_msg_id }) =>
      run(() =>
        port.requestAction({ roomId: room_id, action, resource, clientMsgId: client_msg_id }),
      ),
  );

  server.registerTool(
    'respond_to_decision',
    {
      title: 'Respond to a decision',
      description:
        'Approve or deny a co-sign decision that awaits your signature. Only the named signer can resolve ' +
        'it, and only once.',
      inputSchema: {
        room_id: ROOM_ID,
        decision_id: z.string().min(1).max(128).describe('The decision id from a CO_SIGN verdict.'),
        resolution: z.enum(['APPROVED', 'DENIED']),
        client_msg_id: CLIENT_MSG_ID,
      },
    },
    ({ room_id, decision_id, resolution, client_msg_id }) =>
      run(() =>
        port.respondToDecision({
          roomId: room_id,
          decisionId: decision_id,
          resolution,
          clientMsgId: client_msg_id,
        }),
      ),
  );

  server.registerTool(
    'raise_hand',
    {
      title: 'Raise a hand',
      description:
        'Raise a BLOCKER or FYI to the humans of your principal in a room — for when you need attention but ' +
        'have nothing for the fabric to rule on. Priced by your daily interrupt budget.',
      inputSchema: {
        room_id: ROOM_ID,
        urgency: z.enum(['BLOCKER', 'FYI']),
        reason: z
          .string()
          .min(1)
          .max(1000)
          .describe('A short sentence: what you need attention for.'),
        client_msg_id: CLIENT_MSG_ID,
      },
    },
    ({ room_id, urgency, reason, client_msg_id }) =>
      run(() => port.raiseHand({ roomId: room_id, urgency, reason, clientMsgId: client_msg_id })),
  );

  return server;
}
