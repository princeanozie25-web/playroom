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

/**
 * Client → server: hand a task to another member — Bible §21.3.
 *
 * "@Sol take review" is a TASK TRANSFER, not a mention, and this is the frame that carries it.
 * No UI sends one yet: like `request_action`, this is the wire contract a host sidecar speaks,
 * and the composer only sends chat. The film's harness stands in for the sidecar exactly as it
 * does for beat 5.
 *
 * ── `action` IS REQUIRED, AND THAT IS THE POINT ──
 *
 * A handoff must say WHAT WORK is being handed over, because the receiving member's mandate is
 * checked against it. Optional, it would make that check vacuous for every task created by
 * tagging a member in chat (whose action is null), and the refusal "their mandate does not admit
 * this work" would quietly never fire.
 *
 * ── A HANDOFF CONFERS NO AUTHORITY ──
 *
 * The receiving member acts under THEIR OWN mandate. Nothing in this frame can widen it, and
 * there is deliberately no field that could: no scope, no mandate reference, no signer. In most
 * systems delegation passes permissions along; here it must not, and the absence of a field is
 * the strongest way to say so. See commands/handoff.ts.
 */
export const ClientHandoff = z.object({
  type: z.literal('handoff'),
  client_msg_id: z.string().min(1),
  task_id: z.string().min(1),
  to_member: z.string().min(1),
  /** The work being handed over, as an action type. Checked against the RECEIVER's mandate. */
  action: z.string().min(1),
});
export type ClientHandoff = z.infer<typeof ClientHandoff>;

/**
 * Client → server: lower an interrupt's claim on you by one step (Bible §21.3's one tap).
 *
 * THE ONLY INTERRUPT FRAME. There is no raise frame, because nothing a client can do today raises
 * an interrupt — the co-sign path does, server-side, from a decision the fabric produced. Adding
 * a raise frame now would be a surface with no caller, and the first thing to reach for the day an
 * agent gets a tool-call channel, which is the wrong reason to have built it.
 *
 * And there is no upgrade frame, deliberately. See `InterruptDowngradedEvent`.
 */
export const ClientDowngrade = z.object({
  type: z.literal('downgrade'),
  client_msg_id: z.string().min(1),
  interrupt_id: z.string().min(1),
});
export type ClientDowngrade = z.infer<typeof ClientDowngrade>;

/** Every frame a client may send. Parsed as a union; an unknown `type` is dropped. */
export const ClientFrame = z.discriminatedUnion('type', [
  ClientSend,
  ClientRequestAction,
  ClientHandoff,
  ClientDowngrade,
]);
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
    subject: z.string(), // the member whose mandate was evaluated
    /**
     * THE AUTHENTICATED MEMBER WHO ASKED (S1.3).
     *
     * `actor_id` on the event has carried this since S1.2, and the payload says it too because a
     * projection, a receipt or a host adapter reading the payload alone must not have to infer
     * the requester from an envelope field. Both halves of §9.3's question — whose mandate was
     * evaluated, and who asked — are now in the record the card renders from.
     */
    requested_by: z.string(),
    /**
     * WHICH RECORD entitled the requester to name that subject: `self`, `delegated_task` or
     * `handoff`. Never null on a decision that exists — a request whose subject no record
     * justifies is refused before the evaluator runs, so it produces no decision at all.
     */
    subject_basis: z.string(),
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

/**
 * A task moved from one member to another — Bible §21.3's exit criterion, as a record.
 *
 * "moves the task with state and mandate reference, logged" is this event: `from_member` and
 * `to_member` are the move, `state` is where the task now stands, `mandate_hash` is the document
 * the RECEIVING member acts under, and `actor_id` on the event is the authenticated member who
 * performed the transfer.
 *
 * THE ACTOR IS THE ADDITION THAT CLOSES S12-N2. Bible §21.3 names state, mandate reference and
 * logging; it does not name who did it. Without that, a task could move and nothing would record
 * which member decided it should — and the whole reason a handoff exists in this slice is to be
 * the record that makes acting-for-another legitimate. A record of a delegation that cannot say
 * who delegated is not a record of a delegation.
 *
 * `mandate_hash` identifies WHICH document was in force. It does not prove anyone authorised it —
 * the mandate is still an unsigned file (S04-N2), and S2.1 is what changes that.
 */
export const TaskHandoffEvent = z.object({
  ...eventBase,
  event_type: z.literal('task.handoff'),
  payload: z.object({
    task_id: z.string(),
    from_member: z.string(),
    to_member: z.string(),
    /** The work handed over. Never null on a handoff — a transfer must say what it transfers. */
    action: z.string(),
    /** The receiving member's mandate, by hash. Null only if they hold none. */
    mandate_hash: z.string().nullable(),
    state: z.string(),
  }),
});
export type TaskHandoffEvent = z.infer<typeof TaskHandoffEvent>;

/**
 * SOMETHING CLAIMS A MEMBER'S ATTENTION — Bible §21.3, §12.1.
 *
 * `raised_by` and `addressed_to` are MEMBERS, never people. Per-human identity does not exist
 * (S04-N2) and this slice does not invent it: a record naming a person would have to be reshaped
 * the day a second human appears behind a principal, and a record naming a member does not.
 *
 * `urgency` is an open string like every other taxonomy here, and the three values differ in
 * BEHAVIOUR: BLOCKER halts the owning task, DECISION queues, FYI never interrupts.
 */
export const InterruptRaisedEvent = z.object({
  ...eventBase,
  event_type: z.literal('interrupt.raised'),
  payload: z.object({
    interrupt_id: z.string(),
    urgency: z.string(),
    raised_by: z.string(),
    addressed_to: z.string(),
    about_kind: z.string(),
    about_id: z.string(),
    /** The sentence the room shows. Written by the raiser, never assembled by the reader. */
    summary: z.string(),
  }),
});
export type InterruptRaisedEvent = z.infer<typeof InterruptRaisedEvent>;

/**
 * The recipient lowered the claim, and the RAISER paid for it.
 *
 * `raised_by` is carried on the downgrade as well as the raise, so the budget can be counted from
 * the log without a join — and so the record says, in one row, who was charged.
 *
 * There is no `interrupt.upgraded`. A recipient may lower a claim on their attention; nobody may
 * raise it after the fact, because a second attempt that cost nothing would make the budget a
 * suggestion.
 */
export const InterruptDowngradedEvent = z.object({
  ...eventBase,
  event_type: z.literal('interrupt.downgraded'),
  payload: z.object({
    interrupt_id: z.string(),
    urgency: z.string(),
    from_urgency: z.string(),
    raised_by: z.string(),
    addressed_to: z.string(),
  }),
});
export type InterruptDowngradedEvent = z.infer<typeof InterruptDowngradedEvent>;

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
  TaskHandoffEvent,
  InterruptRaisedEvent,
  InterruptDowngradedEvent,
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
/**
 * THE SOCKET PRESENTED NO TICKET (S1.3c).
 *
 * Kept apart from `ticket_invalid` for the usual reason: a client that was never wired to fetch
 * one and a client whose ticket was refused send someone to different places.
 */
export const ERROR_TICKET_REQUIRED = 'ticket_required';
/**
 * The ticket was refused — and the caller is not told which of the four reasons applied.
 *
 * Fabricated, already consumed, expired, or minted for a different room: one answer at the door.
 * A refusal that diagnoses is a refusal that can be probed, and here it would leak whether a
 * ticket ever existed. The log names the reason; S1.3b's ruling, applied one layer in.
 */
export const ERROR_TICKET_INVALID = 'ticket_invalid';

/**
 * The raising member has no interrupt budget left today — `limits.interrupts_per_day` (S1.4).
 *
 * ITS OWN CODE, because an exhausted budget is not an out-of-scope action and must not be reported
 * as one: the member may do this, and has done it too often. Reporting it as OUT_OF_SCOPE would
 * send someone to edit a mandate scope when the answer is to wait for tomorrow or to raise less.
 */
export const ERROR_INTERRUPT_BUDGET = 'interrupt_budget_exhausted';
/** A downgrade names an interrupt that is not there, is not yours, or is already at the floor. */
export const ERROR_DOWNGRADE_REFUSED = 'downgrade_refused';

/** The bytes were not JSON. A broken client or a corrupted frame, not a rejected request. */
export const ERROR_FRAME_MALFORMED = 'frame_malformed';
/**
 * THE FOUR HANDOFF REFUSALS, kept apart because they are four different mistakes.
 *
 * Collapsing them into one "handoff refused" would be correct and useless — the standing rule
 * since `NOT_IN_ROOM` was split from `UNKNOWN_MEMBER`: a refusal that does not say which
 * constraint failed sends someone to check the wrong thing.
 */
/** No such task in this room. A client bug, or a task id from another room. */
export const ERROR_UNKNOWN_TASK = 'unknown_task';
/** The caller is neither the task's creator nor the member currently holding it. */
export const ERROR_NOT_YOUR_TASK = 'not_your_task';
/** One of the two members is not in this room — the roster rule (§9.2 counterparties). */
export const ERROR_HANDOFF_ROSTER = 'handoff_roster_violation';
/** The receiving member's mandate does not admit the work. They would BLOCK on arrival. */
export const ERROR_HANDOFF_MANDATE = 'handoff_mandate_does_not_admit';

/**
 * The requester named a subject no record entitles them to name — S12-N2, closed.
 *
 * NOT a mandate verdict, and deliberately not written as a `decision` event: the fabric never
 * evaluated anything, because the room refused the ATTRIBUTION. A BLOCK card reading "requested
 * under Sol's mandate" would repeat the very claim being rejected, which is why this refusal
 * travels to the caller and leaves the room's log alone.
 */
export const ERROR_SUBJECT_NOT_JUSTIFIED = 'subject_not_justified';

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
