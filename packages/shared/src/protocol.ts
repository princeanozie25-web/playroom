import { z } from 'zod';

// The room WebSocket wire contract. Both sides parse with these schemas and never
// cast raw wire data — an untrusted frame is validated or dropped, never trusted.

// Client → server: a message send. `client_msg_id` is the idempotency key.
//
// THERE IS NO `author` FIELD, AND THAT IS THE POINT OF S1.2. It carried the sender's claim
// about who they were, and the server wrote what it was given: a caller could author as
// `claude-main` and the room rendered it with Claude's chip. Five findings and RT-005 rested
// on this one field.
//
// The actor is now resolved ONCE at the handshake from a credential and held in the socket's
// closure, so the frame has no way to express the claim. That is a stronger guarantee than
// validating the field would have been — a validated claim is still a claim, and every
// mechanism above it stays advisory for as long as it can be made.
export const ClientSend = z.object({
  type: z.literal('send'),
  client_msg_id: z.string().min(1),
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
// `subject` REMAINS A CLAIM, and deliberately so — it is not the same field as `author` was.
//
// The REQUESTER is authenticated as of S1.2: the connection resolves to a member, and that
// member is who the audit line and the decision event record as having asked. `subject` is the
// member the action is attributed to, which is a different party: a host sidecar asks on its
// member's behalf, and beat 5 of the film is exactly that — Prince's client asking under
// Claude's mandate.
//
// So the narrowing is real but partial: WHO ASKED is now proven, WHOSE MANDATE IT WAS ASKED
// UNDER is still asserted by the frame. Binding a subject to the authenticated caller needs the
// host-sidecar identity model, which is P4's connected-member work (ADR-004). Recorded rather
// than left implicit.
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
/**
 * A turn begins, and it arrives STAMPED — Bible §4.1, §8.1.
 *
 * `principal_id` and `mandate_hash` are the stamp: who this member speaks for, and under which
 * mandate document, recorded on the first event anything sees of the turn. All three fields come
 * from records — the member row, its principal binding, the mandate file — so there is nothing
 * here a client could influence.
 *
 * The point is not that the gateway needs convincing. It is that nothing downstream has to
 * TRUST an unstamped turn: a projection, a receipt or a host adapter reading this event has the
 * authority context in hand rather than having to ask, and a turn without it is visibly
 * different from one with it.
 */
export const AgentTurnStarted = z.object({
  ...eventBase,
  event_type: z.literal('agent.turn.started'),
  payload: z.object({
    turn_id: z.string(),
    adapter_id: z.string(),
    principal_id: z.string(),
    /** Null when the member has no mandate. Omitted authority, never a placeholder. */
    mandate_hash: z.string().nullable(),
  }),
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

/**
 * TASK STATE, as A2A shapes it — Bible §21.3, §6.2, §11, §14.
 *
 * Four states, every one reachable today: `working`, `input-required`, `held`, `done`. See
 * migration 011 for what each one means and why `submitted` is deliberately absent.
 *
 * ── WHY TRANSITIONS ARE EVENTS ──
 *
 * The `tasks` row carries the CURRENT state; these events carry the HISTORY. The room's log is
 * the source of truth and the row is a projection of it, which is the same rule that makes the
 * transcript rebuildable on resume: a task whose state only ever existed as a column update
 * could not be replayed, could not be audited, and could not be rendered by a client that
 * reconnected. §11 says task state changes "render as chips the moment they commit" — that
 * only works if committing means appending.
 */
export const TaskCreatedEvent = z.object({
  ...eventBase,
  event_type: z.literal('task.created'),
  payload: z.object({
    task_id: z.string(),
    state: z.string(), // open string, per the reason-code convention
    assignee: z.string(),
    /** The governed action this task names, or null when it names none. Never a placeholder. */
    action: z.string().nullable(),
    intent: z.string(),
    created_by: z.string(),
  }),
});
export type TaskCreatedEvent = z.infer<typeof TaskCreatedEvent>;

export const TaskStateEvent = z.object({
  ...eventBase,
  event_type: z.literal('task.state'),
  payload: z.object({
    task_id: z.string(),
    state: z.string(),
    /** Where it came FROM, so a reader does not have to fold the whole log to know. */
    from_state: z.string(),
    /**
     * WHY, in the room's own words — the failed route constraint, the adapter's error class.
     *
     * Never null: a state change with no stated reason is the shape a member cannot argue
     * with. §6.2's failure rule is explicitly about telling the human which constraint failed.
     */
    reason: z.string(),
    assignee: z.string(),
  }),
});
export type TaskStateEvent = z.infer<typeof TaskStateEvent>;

export const ServerEvent = z.discriminatedUnion('event_type', [
  SummonEvent,
  RouteSelectedEvent,
  MessageEvent,
  AgentTurnStarted,
  AgentTurnDelta,
  AgentTurnCompleted,
  DecisionEvent,
  TaskCreatedEvent,
  TaskStateEvent,
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
/** No credential was presented at all — a client that was never configured. */
export const ERROR_CREDENTIAL_REQUIRED = 'credential_required';
/** A credential was presented and is not valid — revoked, mistyped, or another deployment's. */
export const ERROR_CREDENTIAL_INVALID = 'credential_invalid';
/** The bytes were not JSON. A broken client or a corrupted frame, not a rejected request. */
export const ERROR_FRAME_MALFORMED = 'frame_malformed';
/**
 * Valid JSON, and not a frame this server accepts.
 *
 * Kept apart from `frame_malformed` for the usual reason: a client sending mangled bytes and a
 * client asking for something the server does not offer are different mistakes with different
 * fixes. Both were a SILENT DROP until S1.2 — indistinguishable from a lost socket, and
 * indistinguishable from the server having accepted the frame and done nothing, which is the
 * one shape this codebase refuses to leave in place.
 *
 * `ClientFrame` admits `send` and `request_action` and nothing else. In particular there is no
 * frame that starts an agent turn: a caller inventing `{"type":"triggerAgentTurn"}` now gets
 * this refusal, and the refusal is the evidence that the gateway path is the only path.
 */
export const ERROR_FRAME_UNRECOGNISED = 'frame_unrecognised';

// Application WebSocket close codes (4000-4999 is the application-reserved range).
// The frame carries the human-readable reason; the close code is what a client can
// branch on without string matching — in particular, to stop reconnecting to a room
// that does not exist rather than looping on it.
export const WS_CLOSE_ROOM_NOT_FOUND = 4404;
/**
 * The connection presented no usable credential. 4401 by analogy with HTTP 401.
 *
 * A distinct code from 4404 because a client must react differently: a room that does not
 * exist is permanent and reconnecting is pointless, whereas a credential problem is fixed by
 * configuring the client and retrying. Both stop the reconnect loop; only one is worth a
 * message telling the operator what to change.
 */
export const WS_CLOSE_UNAUTHENTICATED = 4401;
