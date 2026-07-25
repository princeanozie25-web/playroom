import { z } from 'zod';

// The room WebSocket wire contract. Both sides parse with these schemas and never
// cast raw wire data — an untrusted frame is validated or dropped, never trusted.

// Client → server: a message send. `client_msg_id` is the idempotency key.
export const ClientSend = z.object({
  type: z.literal('send'),
  client_msg_id: z.string().min(1),
  author: z.string().min(1),
  body: z.string(),
});
export type ClientSend = z.infer<typeof ClientSend>;

// Server → client: a persisted event, replayed on resume and tailed live.
// Fields common to every event; the discriminator is `event_type`.
const eventBase = {
  type: z.literal('event'),
  seq: z.number(),
  room_id: z.string(),
  ts: z.string(),
  actor_id: z.string(),
};

// A human (or system) chat message.
export const MessageEvent = z.object({
  ...eventBase,
  event_type: z.literal('message'),
  payload: z.object({ body: z.string() }),
});

// An agent turn is streamed as: started → many delta → completed. All three
// share a `turn_id` so the client groups deltas into one bubble and resume
// reassembles the same text. Deltas are prunable; completed carries the whole.
export const AgentTurnStarted = z.object({
  ...eventBase,
  event_type: z.literal('agent.turn.started'),
  payload: z.object({ turn_id: z.string(), adapter_id: z.string() }),
});
export const AgentTurnDelta = z.object({
  ...eventBase,
  event_type: z.literal('agent.turn.delta'),
  payload: z.object({ turn_id: z.string(), text: z.string() }),
});
export const AgentTurnCompleted = z.object({
  ...eventBase,
  event_type: z.literal('agent.turn.completed'),
  payload: z.object({
    turn_id: z.string(),
    adapter_id: z.string(),
    text: z.string(),
    success: z.boolean(),
    tokens_in: z.number().nullable(),
    tokens_out: z.number().nullable(),
    cost_usd: z.number().nullable(),
    error_class: z.string().nullable(),
  }),
});

export const ServerEvent = z.discriminatedUnion('event_type', [
  MessageEvent,
  AgentTurnStarted,
  AgentTurnDelta,
  AgentTurnCompleted,
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

// Server → client: the first frame, carrying the room's high-water sequence.
export const ServerHello = z.object({
  type: z.literal('hello'),
  last_seq: z.number(),
});
export type ServerHello = z.infer<typeof ServerHello>;

// Server → client: an explicit refusal. Deny-by-default is only half a guarantee
// if a refused action is indistinguishable from an accepted one, so every refusal
// the client could otherwise mistake for success travels as one of these (A4-F1).
//
// `code` is an open string, deliberately, and this is the one place the repo does
// not close a union. A closed enum would make an older client fail to parse a code
// added later — and a frame that fails to parse is a frame that gets dropped, which
// is precisely the silent-failure class this schema exists to end. Unknown code =
// still rendered as a refusal. Known codes are listed below.
export const ServerErrorFrame = z.object({
  type: z.literal('error'),
  code: z.string().min(1),
  message: z.string().min(1),
  room_id: z.string().optional(), // snake_case, matching every other wire field
});
export type ServerErrorFrame = z.infer<typeof ServerErrorFrame>;

// Known `code` values. Add here as new refusals appear; never remove one.
export const ERROR_ROOM_NOT_FOUND = 'room_not_found';

// Application WebSocket close codes (4000-4999 is the application-reserved range).
// The frame carries the human-readable reason; the close code is what a client can
// branch on without string matching — in particular, to stop reconnecting to a room
// that does not exist rather than looping on it.
export const WS_CLOSE_ROOM_NOT_FOUND = 4404;
