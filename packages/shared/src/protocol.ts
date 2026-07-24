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
