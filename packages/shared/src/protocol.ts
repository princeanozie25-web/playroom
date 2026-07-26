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

// Client → server: a request to perform a governed action on behalf of a member.
//
// This is the transport for the action surface the command layer already dispatches on
// — not a new product surface. It is the same shape a host sidecar sends (Bible §3.2:
// "Buzz calls the sidecar before protected actions"), with the Playroom client standing
// in as the caller until hosts exist.
//
// A chat message is NOT one of these. Room content is not a governed action: mandates
// bind members to the principals who grant them (Bible §9.1), and a human typing in
// their own room acts as a principal, not under a mandate.
//
// `subject` is UNAUTHENTICATED in v0 — any caller may name any member. S1.2 stamps
// identity at the gateway and drops unstamped messages; until then this frame proves
// the evaluator, not the identity. Recorded as a finding rather than left implicit.
export const ClientRequestAction = z.object({
  type: z.literal('request_action'),
  client_msg_id: z.string().min(1),
  subject: z.string().min(1), // the member the action is attributed to
  action: z.string().min(1), // action type, matched against mandate scope
  resource: z.string().min(1), // what it is against
});
export type ClientRequestAction = z.infer<typeof ClientRequestAction>;

/** Every frame a client may send. Parsed as a union; an unknown `type` is dropped. */
export const ClientFrame = z.discriminatedUnion('type', [ClientSend, ClientRequestAction]);
export type ClientFrame = z.infer<typeof ClientFrame>;

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

// A cross-boundary action the fabric stopped, awaiting a co-signature (§4.3 CO_SIGN,
// §12.1 DECISION). Nothing emits this yet — S2.2 builds the co-sign flow and S2.1 the
// engine that decides. It lives in the contract now so the DECISION card has exactly
// one possible input: a `decision` row in the event log. There is deliberately no
// other way to make that card appear, because a demo surface able to display a block
// the fabric did not produce would make the product a lie.
// Bible §9.3's decision contract, minus `signature` (mandates are unsigned in v0 —
// omit, never stub) and minus the replay fields `nonce` / `expires_at` / `request_id`
// (S2.1 owns replay protection and the decisions table they live in). `room_id` is
// already on the event envelope, so it is not duplicated into the payload.
//
// This REPLACED an earlier shape invented in S-UI (`attempted_by`, a human-readable
// `reason`) which predated the Bible landing in the repository. The canonical contract
// wins and the card yields to it: `subject` is the member, and the human sentence is
// derived from `reason_code` in the UI, because the code is data and the sentence is
// presentation.
export const DecisionEvent = z.object({
  ...eventBase,
  event_type: z.literal('decision'),
  payload: z.object({
    decision_id: z.string(),
    subject: z.string(), // the member the decision is about
    principal: z.string(), // who that member speaks for
    action: z.string(), // e.g. "pr.merge"
    resource: z.string(), // e.g. "repo:playroom/playroom#pr-41"
    arguments_hash: z.string(), // sha256 over the canonical arguments
    decision: z.string(), // ALLOW | CO_SIGN | BLOCK — open per the code convention
    reason_code: z.string(), // e.g. PROTECTED_ACTION — open string, see above
    required_signer: z.string().nullable(), // null unless a human must sign
    effective_mandate_hash: z.string().nullable(),
    policy_version: z.string().nullable(),
  }),
});

// A summon: the durable record that an agent turn was ASKED FOR, and by whom.
// Canonical — Bible §19 lists `summon` in the event_type enum.
//
// The invariant this exists to make checkable: EVERY AGENT TURN TRACES TO A HUMAN
// SUMMON. `root_actor` / `root_is_human` are recorded here at write time rather than
// resolved later, because members are not in the database until S1.1 and so there is
// nothing for SQL to look them up in.
//
// `depth` is CARRIED here and enforced in S0.5b. It is always 0 today: only
// human-rooted summons exist, and an agent cannot yet raise one.
export const SummonEvent = z.object({
  ...eventBase,
  event_type: z.literal('summon'),
  payload: z.object({
    summon_id: z.string(),
    member: z.string(), // the member asked to take a turn
    requested_by: z.string(), // the actor whose message raised this summon
    root_actor: z.string(), // the actor at the head of the chain
    root_is_human: z.boolean(), // judged against the roster when written, then frozen
    depth: z.number(), // 0 = human-rooted. S0.5b enforces a cap on this.
    cause_seq: z.number(), // the event that triggered it — the log's first back-reference
  }),
});
export type SummonEvent = z.infer<typeof SummonEvent>;

/**
 * A route was selected for a member's turn — Bible §6.2: "record which route was selected and
 * why".
 *
 * A NEW EVENT TYPE, not a field on `summon`, because it is a different fact with a different
 * lifetime: a summon says a member was ASKED, a route selection says HOW they were reached.
 * When a member has two routes and the first fails, there will be two selections for one
 * summon, and a field could not carry that.
 *
 * `reason` is an open string (CONTRIBUTING: open strings for taxonomies that grow) and today
 * it is trivially `only_available_route` — there is one route per member, so selection is not
 * a decision. That is honest, and the value is the record rather than the sophistication: when
 * a second route exists the reason stops being trivial and nothing else has to move.
 */
export const RouteSelectedEvent = z.object({
  ...eventBase,
  event_type: z.literal('route.selected'),
  payload: z.object({
    summon_id: z.string(),
    member: z.string(),
    route_id: z.string(),
    /** `hosted` | `connected` | `bridged`. Never a provider name — §6. */
    route_type: z.string(),
    reason: z.string(),
  }),
});
export type RouteSelectedEvent = z.infer<typeof RouteSelectedEvent>;

export const ServerEvent = z.discriminatedUnion('event_type', [
  SummonEvent,
  RouteSelectedEvent,
  MessageEvent,
  AgentTurnStarted,
  AgentTurnDelta,
  AgentTurnCompleted,
  DecisionEvent,
]);
export type ServerEvent = z.infer<typeof ServerEvent>;
export type DecisionEvent = z.infer<typeof DecisionEvent>;

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
