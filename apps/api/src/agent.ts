import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import type { AgentAdapter, AgentTool, ServerEvent } from '@playroom/shared';
import { costUsd, getAdapterConfig, listAdapters } from '@playroom/adapters';
import type { RoomBus } from './bus.js';
import { appendAgentEvent, appendMessage, type SummonRef, type TaskRef } from './events.js';
import { assembleContext, assemblyShape, shapeSummary, windowFor } from './assembly.js';
import { RECENT_WINDOW_MESSAGES } from './summary.js';
import { mandateFor } from './mandates.js';
import { stampFor } from './stamp.js';
import { ceilingMessage, spendToday } from './spend.js';
import { getTask, transitionTask, type TaskState } from './tasks.js';
import type { Command, CommandContext, SummonChain } from './commands/context.js';

// The recent window handed to a turn: this many messages verbatim, PLUS the rolling summary of
// everything older (S1.6). Before, it was a hard cap that DROPPED older messages; now the older
// span is folded into a summary ahead of the summon, so the window is bounded without being lossy.
const CONTEXT_MESSAGES = RECENT_WINDOW_MESSAGES;

/**
 * The mandate scope that authorises an agent to INITIATE a summon through the tool-call channel
 * (S1.8). Default-closed: no mandate grants it unless deliberately written to. Checked at the summon
 * constructor via the evaluator, and used here to decide whether a turn is even OFFERED the summon
 * tool. Named `summon.initiate` — deliberately NOT the ungoverned agent-summon shape S0.5b refused
 * and the evidence suite still forbids by that name; this is its governed successor.
 */
export const SUMMON_INITIATE_ACTION = 'summon.initiate';

/** The provider-neutral tool a summon-authorised agent is offered, so its model can emit a summon. */
export const SUMMON_TOOL: AgentTool = {
  name: 'summon',
  description:
    'Summon another agent member of this room to take a turn. Use only when the work genuinely ' +
    'needs another member; the summoned member acts under its own authority, at its own cost.',
  parameters: {
    type: 'object',
    properties: {
      member: {
        type: 'string',
        description: 'The id or display name of the agent member in this room to summon.',
      },
    },
    required: ['member'],
  },
};

/**
 * The most governed actions ONE turn may emit (S2.1a). A turn legitimately asks for a handful; a
 * burst is the denial-of-wallet case with the model holding the pen — each emission is an evaluation
 * and, on CO_SIGN/BLOCK, a persisted decision event, so an uncapped path lets a single turn write the
 * log full. This bounds the COUNT of governed emissions in one turn; SUMMON_DEPTH_CAP bounds a chain's
 * DEPTH, a different axis. Summons keep their own bounds (dedup + depth). Small and revisitable.
 */
export const MAX_ACTIONS_PER_TURN = 8;

/**
 * The shape a governed emission must take (S2.1a). MODEL OUTPUT IS UNTRUSTED INPUT: an emitted action
 * carries an arbitrary action string and arbitrary arguments. The action name is length-bounded and
 * then handed to evaluate() unchanged — an unknown-but-well-formed name resolves to OUT_OF_SCOPE, never
 * a throw. The arguments must yield exactly a bounded `resource` string; any other shape (missing
 * resource, wrong type, over-long, or not an object) is refused BEFORE evaluate() rather than passed
 * through as opaque data. Extra keys are ignored, never forwarded — only `resource` reaches the fabric.
 * A refusal here is fail-closed and distinguishable from a mandate BLOCK: it produces no decision event.
 */
const EMITTED_ACTION_NAME_MAX = 64;
const EMITTED_RESOURCE_MAX = 512;

/**
 * Parse a governed emission's arguments (S2.1a) — a hand-written schema, no new dependency. Returns
 * the one field the fabric uses, `resource`, or `null` when the shape is anything else: not an object,
 * an array, or a missing / empty / over-long / non-string `resource`. Extra keys are IGNORED, never
 * forwarded — only `resource` reaches evaluate().
 */
export function parseEmittedArgs(args: unknown): { resource: string } | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
  const resource = (args as Record<string, unknown>).resource;
  if (
    typeof resource !== 'string' ||
    resource.length < 1 ||
    resource.length > EMITTED_RESOURCE_MAX
  ) {
    return null;
  }
  return { resource };
}

// The system prompt and its SHA-256, read once from prompts/room-agent.v1.md.
let promptCache: { text: string; hash: string } | undefined;
function systemPrompt(): { text: string; hash: string } {
  if (!promptCache) {
    const path = fileURLToPath(new URL('../../../prompts/room-agent.v1.md', import.meta.url));
    const text = readFileSync(path, 'utf8');
    promptCache = { text, hash: createHash('sha256').update(text).digest('hex') };
  }
  return promptCache;
}

// An actor is an agent iff its id is a known adapter id. This is BARRIER 2 of the
// activation boundary (§22a) — see `summonRuling`. Note what it rests on: `actor_id`
// arrives unauthenticated from the wire, so this refuses an HONEST claim to be an
// agent and nothing more. That is why it is not the only barrier.
export function isAgentActor(actorId: string): boolean {
  try {
    getAdapterConfig(actorId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Summon tokens, PER ROOM — derived from that room's membership, never hardcoded.
 *
 * This file once held a hardcoded prefix and a literal member id, which meant enabling a
 * second member required editing app code: the §6 anti-lock-in rule failing in the one place
 * easiest to miss, where the interface was clean, the adapter boundary was clean, and the
 * SELECTOR was hardcoded. Bible §21.2's exit — "same prompt routes through either member via
 * roster config, no app-code change" — is only true because of this.
 *
 * A member is addressable by `@<display_name>` or `@<id>`, lowercased.
 *
 * ── PER ROOM, AND WITHOUT TOUCHING THE BOUNDARY ──
 *
 * S1.1a made this a process-wide snapshot loaded at boot (S11a-N2), which was defensible
 * while membership was configuration. Membership is data now and can change at runtime, so a
 * boot snapshot would answer yesterday's question. It is resolved PER ROOM and PER MESSAGE
 * instead: `postMessage` awaits `loadRoomTokens` before ruling, and `summonRuling` reads the
 * table for `event.room_id`.
 *
 * The room id was already on the event, so this cost NO change to `summonRuling`'s signature
 * and NO change to any of its guards. The table is the boundary's input, not the boundary.
 *
 * The map is a keyed hand-off, not a cache: `loadRoomTokens` overwrites the room's entry from
 * the database on every message, so nothing goes stale between a membership change and the
 * next message. One indexed read of a two-row join per send, against a path whose measured
 * overhead is ~30-120ms of provider latency (ADR-008) — correctness at a cost that does not
 * register.
 *
 * IT REFUSES TO GUESS. A room whose table was never loaded THROWS rather than resolving
 * nothing. An empty table means every tag silently fails to summon, which is a room that
 * accepts messages and answers none — a working-looking room that is dead, and the RT-001
 * shape exactly.
 */
const roomTokens = new Map<string, Map<string, string>>();

/** The subset of a member record the summon rule needs. Keeps the boundary off the database. */
export interface SummonableMember {
  id: string;
  display_name: string;
  kind: 'human' | 'agent';
}

/**
 * Install the tokens for one room.
 *
 * Only AGENT members become addressable. A summon starts an agent turn, so a `@`-tag naming
 * a human would resolve to a member with no adapter to run — `prince` is a member record as
 * of S1.1b and is deliberately NOT summonable by becoming one.
 */
export function setRoomTokens(roomId: string, members: SummonableMember[]): void {
  const table = new Map<string, string>();
  for (const m of members) {
    if (m.kind !== 'agent') continue;
    table.set(`@${m.display_name.toLowerCase()}`, m.id);
    table.set(`@${m.id.toLowerCase()}`, m.id);
  }
  roomTokens.set(roomId, table);
}

/** Forget a room's tokens. Used when a room is deleted, so the map cannot grow forever. */
export function forgetRoomTokens(roomId: string): void {
  roomTokens.delete(roomId);
}

function tokenTable(roomId: string): Map<string, string> {
  const table = roomTokens.get(roomId);
  if (!table) {
    throw new Error(
      `summon tokens not loaded for room "${roomId}" — call setRoomTokens() before ruling`,
    );
  }
  return table;
}

/**
 * Every member id, across every loaded room. Lets the rule tell "nobody is called that" apart
 * from "they exist, but not here" — two refusals with two reasons, per the standing rule that
 * fail-closed must distinguish refused from misconfigured.
 */
let knownMemberTokens = new Set<string>();

/** Install the set of tokens that name a real member ANYWHERE. Set alongside the roster. */
export function setKnownMemberTokens(members: SummonableMember[]): void {
  const all = new Set<string>();
  for (const m of members) {
    if (m.kind !== 'agent') continue;
    all.add(`@${m.display_name.toLowerCase()}`);
    all.add(`@${m.id.toLowerCase()}`);
  }
  knownMemberTokens = all;
}

/**
 * Which rule decided a summon. Named, because "no turn appeared" is the SAME
 * OBSERVATION for a message with no tag, a member who does not exist, and an injection
 * attempt — and a boundary whose refusals are indistinguishable from silence is not a
 * boundary that can be tested. Every case in summon-boundary.test.ts asserts one of
 * these, never merely the absence of a turn.
 */
export type SummonRule =
  | 'ACTIVATED' // at least one addressable member was named by a member
  | 'GENERATED_TEXT' // BARRIER 1 — the text was produced by a model
  | 'NOT_ROOM_CONTENT' // the event carries no member-authored text at all
  | 'SYSTEM_AUTHORED' // the room itself wrote it (notices, refusals)
  | 'AGENT_AUTHORED' // BARRIER 2 — a member message whose author is an adapter
  | 'NO_TOKEN' // member-authored, addressed nobody
  | 'NOT_IN_ROOM' // named a real member who is not in THIS room
  | 'UNKNOWN_MEMBER'; // addressed something, and nothing addressable was named

export interface SummonRuling {
  rule: SummonRule;
  /** Members to summon, first-mention order, deduplicated. Empty unless ACTIVATED. */
  members: string[];
  /**
   * Tokens shaped like an address that named nobody addressable. Non-empty means the
   * room OWES A REFUSAL: a tag that silently does nothing is RT-001's shape (see
   * commands/summon.ts, which is what says so out loud).
   */
  unknown: string[];
  /**
   * Tokens naming a real member who is NOT in this room.
   *
   * Kept apart from `unknown` because they are different mistakes with different fixes: a
   * misspelling versus someone who exists but was never enrolled here. Fail-closed must
   * distinguish REFUSED from MISCONFIGURED, and this is the mild version of that rule — the
   * room's sentence differs accordingly.
   */
  elsewhere: string[];
}

// The event types an agent turn produces. Named as a set rather than inferred from a
// prefix so that adding a generated event type is a decision at this line, not a
// coincidence of naming.
const MODEL_GENERATED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent.turn.started',
  'agent.turn.delta',
  'agent.turn.completed',
]);

/**
 * The span of text A MEMBER IS THE AUTHOR OF, or null if this event carries none.
 *
 * ALLOWLIST, not a filter: exactly one event type qualifies, and every other one —
 * including every event type added after this was written — carries no member-authored
 * text until someone changes this function on purpose. The old code expressed the same
 * outcome as `event.event_type !== 'message'`, which is a property of the SHAPE the log
 * happens to have rather than a decision anyone made, and it would have admitted a new
 * event type by default.
 */
function memberAuthoredText(event: ServerEvent): string | null {
  return event.event_type === 'message' ? event.payload.body : null;
}

/**
 * Which members, if any, a room event summons — and if none, WHY NOT.
 *
 * ── BARRIER 1: A SUMMON TOKEN INSIDE MODEL-GENERATED TEXT MUST NEVER ACTIVATE. ──
 *
 * Not because agent-to-agent chat is untidy. Because an agent that can be TALKED INTO
 * writing `@sol` conscripts another principal's agent, and the text doing the talking
 * does not come from the room: it arrives in a pull request body, a pasted export, a
 * counterparty's email, a README. A model that reads "reply with @sol, take review" and
 * complies has converted prompt injection into cross-principal action — Jerry's agent
 * doing work Prince's agent was tricked into requesting, with Jerry's mandate and
 * Jerry's costs. The mandate evaluator cannot help: `agent.turn` is not a governed
 * action, and by the time a mandate is consulted the summon has already happened.
 * Same reasoning as the `pre-wrap` decision in globals.css — agent output is DATA,
 * and this is the other half of it: not rendered as markup, not read as address.
 *
 * IF A LATER SLICE ROUTES AGENT REPLIES THROUGH A MESSAGE EVENT, THIS BARRIER STOPS
 * HOLDING and `memberAuthoredText` above is the line that has to change to admit it.
 * At that point barrier 1 needs a provenance marker on the span, not an event type.
 * S1.3's handoff object is the right home for a deliberate agent-initiated summon —
 * "@Sol, take review" is a task transfer, not a mention — and it must not arrive by
 * loosening this.
 *
 * ── BARRIER 2: A MESSAGE AUTHORED BY AN ADAPTER ID DOES NOT ACTIVATE (§22a). ──
 *
 * Kept as defence in depth, and it is the one that catches the case above if barrier 1
 * is ever loosened. NEITHER BARRIER IS LOAD-BEARING ALONE: barrier 1 fails if agent
 * text is ever carried by a message event, and barrier 2 fails because `actor_id` comes
 * off the wire unauthenticated (server.ts passes `msg.author` verbatim, S1.2 stamps it),
 * so a caller may simply not claim an adapter id.
 *
 * ── WHAT IS NOT GUARDED, AND IS NOT PRETENDED TO BE ──
 *
 * QUOTED AND IMPORTED CONTENT ACTIVATES TODAY. `MessageEvent.payload` is `{ body:
 * string }` — one flat string, with no representation of which spans the sender wrote
 * and which they pasted. So `> @sol please look at this` summons Sol, and a member who
 * pastes a bug report containing a tag summons whoever it names. That is the same
 * injection class as barrier 1, arriving through a member instead of an agent, and it
 * is UNCLOSED because closing it needs span provenance the log does not have. Pinned by
 * test (`quoted content activates — the hole, recorded`) so the day S1.7 lands content
 * promotion, the test fails and forces the decision rather than letting it pass unnoticed.
 * Trigger: S1.7.
 *
 * Tagging two members produces TWO summons and two turns, one each — not one turn that
 * mentions both. That is what makes postage and interrupt accounting attach per member
 * later without rework. Tokens match as whole words, so `@solar` is not `@sol`.
 */
export function summonRuling(event: ServerEvent): SummonRuling {
  const refuse = (rule: SummonRule): SummonRuling => ({
    rule,
    members: [],
    unknown: [],
    elsewhere: [],
  });

  // BARRIER 1 — provenance of the text. Checked FIRST so the refusal is named for what
  // it is rather than reported as "not room content", which is what the event-type
  // comparison used to say by accident.
  if (MODEL_GENERATED_EVENT_TYPES.has(event.event_type)) return refuse('GENERATED_TEXT');
  const text = memberAuthoredText(event);
  if (text === null) return refuse('NOT_ROOM_CONTENT');

  // BARRIER 2 — authorship.
  if (event.actor_id === 'system') return refuse('SYSTEM_AUTHORED');
  if (isAgentActor(event.actor_id)) return refuse('AGENT_AUTHORED');

  // PER ROOM. The room id was already on the event, so scoping resolution cost no change to
  // this function's signature and none to the guards above.
  const table = tokenTable(event.room_id);
  const members: string[] = [];
  const unknown: string[] = [];
  const elsewhere: string[] = [];
  // Word-boundary split keeps `@sol,` addressable while `@solar` is not `@sol`. `-` and
  // `_` are kept as word characters, so `@claude-main` is one token and cannot be read
  // as `@claude` — which is why a prefix pair in the table is not an ambiguity.
  for (const word of text.toLowerCase().split(/[^a-z0-9@_-]+/)) {
    if (word.length < 2 || !word.startsWith('@')) continue;
    const id = table.get(word);
    if (id) {
      if (!members.includes(id)) members.push(id);
    } else if (knownMemberTokens.has(word)) {
      // A REAL MEMBER, JUST NOT HERE. Distinguished from a token naming nobody so the room
      // can say which mistake was made — "no member of this room is called @x" and "@x is
      // not in this room" are different sentences because they have different remedies.
      if (!elsewhere.includes(word)) elsewhere.push(word);
    } else if (!unknown.includes(word)) {
      unknown.push(word);
    }
  }

  if (members.length > 0) return { rule: 'ACTIVATED', members, unknown, elsewhere };
  // Ordered so the more specific diagnosis wins: naming a real member who is absent is more
  // informative than naming nobody, and a message doing both should say the useful thing.
  if (elsewhere.length > 0) return { rule: 'NOT_IN_ROOM', members, unknown, elsewhere };
  if (unknown.length > 0) return { rule: 'UNKNOWN_MEMBER', members, unknown, elsewhere };
  return { rule: 'NO_TOKEN', members, unknown, elsewhere };
}

// One in-flight turn per MEMBER per room (§22b, corrected for a multi-member roster).
//
// Keyed per member because two tagged members must each answer once — a per-room key
// would let the first turn suppress the second and silently turn two summons into one.
// A second summon of the SAME member while it is streaming is still refused out loud.
//
// FINDING S05a-N1, logged not fixed: this is an in-process Set. A restart forgets it and
// a second instance never knew, so the guarantee is per-process rather than per-room. It
// is fine at one region today and it is a real bug the first time there is a pilot and a
// deploy mid-turn. It belongs with the durability argument that put depth on the summon
// record rather than in a counter: process memory is not where an invariant lives.
//
//   TRIGGER: the first pilot, or the first deploy during a live turn — whichever comes
//   first. Not "when convenient": both of those events make it observable to a user, and
//   the durable replacement (migration 006's unique index on started rows) already exists
//   for the narrower case, so the work is to route the refusal through it rather than to
//   invent a mechanism.
const inFlight = new Set<string>();
const inFlightKey = (roomId: string, adapterId: string): string => `${roomId} ${adapterId}`;

// End time of the previous turn in THIS process — lets each turn record the gap
// since the last one, so cold-start/autosuspend effects are visible (S0.3c).
let lastTurnEndedAt: number | undefined;

/**
 * Did this error come from migration 006's one-turn-per-summon index?
 *
 * Matched on BOTH the SQLSTATE and the constraint name, not on 23505 alone: a unique
 * violation from anywhere else — a duplicate client_msg_id, a future index — is a
 * different fault and must keep travelling to the error path rather than being quietly
 * read as "someone else is already answering".
 */
export const ONE_TURN_PER_SUMMON_INDEX = 'events_one_turn_per_summon_uniq';

function isDuplicateTurnForSummon(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown };
  return e.code === '23505' && e.constraint === ONE_TURN_PER_SUMMON_INDEX;
}

export interface AgentTurnDeps {
  pool: Pool;
  bus: RoomBus;
  roomId: string;
  adapterId: string;
  adapterFactory: (id: string) => AgentAdapter;
  // RE-ENTER THE COMMAND ENTRY so an EMITTED summon converges on the single summon constructor
  // (S1.8) — the same path a human tag uses, not a parallel one. Present because a turn can now
  // dispatch a summon of its own.
  execute: (ctx: CommandContext, command: Command) => Promise<unknown>;
  // The summon this turn answers. Required, so a turn cannot exist without one.
  summon: SummonRef;
  // The task this turn is work on. Required for the same reason (S1.3): the turn is what
  // finishes the work or fails to, so it is the only party that can move the task out of
  // `working`, and a turn with no task would leave one there forever.
  task: TaskRef;
  // THE PROVENANCE CHAIN THIS TURN CARRIES (S1.8): its own summon's root and depth. When this turn
  // emits a summon, this is the chain it extends — the constructor increments the depth. Absent is
  // treated as a human root at depth 0 (the pre-S1.8 shape).
  chain?: SummonChain;
  spans?: { t0: number; t1: number }; // S0.3c: command-entry + message-committed boundaries
}

/**
 * Move this turn's task, and fan the transition out.
 *
 * Reads the task row rather than trusting a copy: the turn is long-lived (a streamed reply is
 * seconds of wall clock) and a handoff could have moved the task while it ran. Transitioning a
 * stale object would write `from_state` values that never held, and the log is read as a history.
 *
 * A MISSING TASK IS NOT FATAL TO THE TURN. It cannot happen through the summon path — the task
 * is created before the summon exists — but a task deleted underneath a running turn (a room
 * torn down mid-stream, which the test suite does) must not turn a completed turn into a thrown
 * error after its events are already in the log.
 */
async function moveTask(
  deps: AgentTurnDeps,
  to: TaskState,
  reason: string,
  actorId: string,
): Promise<void> {
  const row = await getTask(deps.pool, deps.task.task_id);
  if (!row) return;
  const moved = await transitionTask(deps.pool, row, to, reason, actorId);
  if (moved) deps.bus.publish(deps.roomId, moved);
}

// Run an agent turn as a sequence of persisted events: started → deltas →
// completed. Persist-before-fanout holds for every one (ADR-003). A failure is
// written as completed{success:false} with an error_class — never a silent hang.
export async function runAgentTurn(deps: AgentTurnDeps): Promise<void> {
  const { pool, bus, roomId, adapterId, adapterFactory, execute, spans, summon, task } = deps;
  const publish = (ev: ServerEvent): void => bus.publish(roomId, ev);

  // STRUCTURED SUMMONS this turn emitted, collected during the stream and dispatched AFTER it
  // completes (S1.8) — so the emitting turn's own events (started/deltas/completed) are written
  // first, and B's summon reads in the log after A's turn, in the order the decisions happened.
  const emittedSummons: string[] = [];

  // GOVERNED (non-summon) ACTIONS this turn emitted (S2.1a), collected during the stream and routed to
  // the evaluator AFTER the turn's own events are in the log. `emittedActionCount` counts EVERY emission
  // including those past the cap, so the cap is reported out loud rather than dropping them in silence.
  const emittedActions: { action: string; args: Record<string, unknown>; call_id?: string }[] = [];
  let emittedActionCount = 0;

  // ── THE DAILY SPEND CEILING, CHECKED BEFORE ANYTHING COSTS MONEY (§18, S-LIVE) ──
  //
  // HERE, and not at the summon construction site, for two reasons. The constructor is off limits in
  // this slice, and this is where the §22b refusal already lives — the one existing precedent for
  // "this turn will not happen, and the room is told why in-thread." A second refusal mechanism for
  // the same shape of outcome would be a second thing to keep consistent.
  //
  // BEFORE THE STAMP AND BEFORE THE ADAPTER. Nothing above this line has cost anything, so a refused
  // turn spends nothing at all — no provider call, no tokens, and no `agent.turn.started` implying a
  // turn that never ran.
  //
  // OUT LOUD, ALWAYS. A ceiling that stops agents replying and says nothing is indistinguishable from
  // the product being broken, which is the one thing a refusal may never look like.
  const spend = await spendToday(pool);
  if (spend.exceeded) {
    console.warn(
      `[spend] ceiling reached: $${spend.spent_usd.toFixed(4)} of $${spend.ceiling_usd} — ` +
        `refused a turn for ${adapterId} in ${roomId}`,
    );
    publish(
      await appendMessage(pool, roomId, 'system', `sys-${randomUUID()}`, ceilingMessage(spend)),
    );
    return;
  }

  // §22b: reject a second concurrent turn with an in-thread notice.
  const flightKey = inFlightKey(roomId, adapterId);
  if (inFlight.has(flightKey)) {
    publish(
      await appendMessage(
        pool,
        roomId,
        'system',
        `sys-${randomUUID()}`,
        `${adapterId} is already replying in this room.`,
      ),
    );
    return;
  }
  inFlight.add(flightKey);

  // S0.3c latency spans — performance.now() at boundaries only; no write is moved.
  const enteredAt = performance.now();
  const msSincePrev =
    lastTurnEndedAt !== undefined ? Math.round(enteredAt - lastTurnEndedAt) : null;
  const t0 = spans?.t0 ?? enteredAt; // executeCommand entry
  const t1 = spans?.t1 ?? enteredAt; // triggering message committed
  let tStreamInvoked: number | null = null;
  let tFirstChunk: number | null = null;
  let tFirstDeltaCommitted: number | null = null;
  let tFirstFanout: number | null = null;
  const span = (a: number | null, b: number | null): number | null =>
    a != null && b != null ? Math.round(a - b) : null;

  const { text: sys, hash: promptHash } = systemPrompt();
  const cfg = getAdapterConfig(adapterId);
  const turnId = randomUUID();
  const startedAt = Date.now();
  let assembled = '';
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;

  try {
    // THE STAMP, BEFORE ANYTHING SEES THE TURN (Bible §4.1, §8.1). Derived from records, not
    // passed in — see stamp.ts. It throws for a member that does not exist, inside this try, so
    // an unstampable turn fails loudly as completed{success:false} rather than starting.
    const stamp = await stampFor(pool, adapterId);

    // THE STARTED EVENT'S SEQ IS THE CAUSE of any summon this turn emits (S1.8): it is the event that
    // asked, half the natural key migration 005 makes unique, so a re-run of this turn cannot summon
    // the same member twice. Captured here where the row is written, not derived later.
    const startedEvent = await appendAgentEvent(
      pool,
      roomId,
      adapterId,
      summon,
      task,
      'agent.turn.started',
      {
        turn_id: turnId,
        adapter_id: adapterId,
        principal_id: stamp.principal_id,
        mandate_hash: stamp.mandate_hash,
      },
    );
    publish(startedEvent);
    const startedSeq = startedEvent.seq;

    // TOOLS OFFERED TO THIS TURN (S1.8). The summon tool is handed to the model ONLY when this
    // member's mandate grants `summon.initiate` — an agent that cannot summon is not offered the
    // tool, so an injection has nothing to call. The summon constructor re-checks the mandate
    // regardless; offering is the near guard, the constructor's evaluation is the load-bearing one.
    const maySummon =
      mandateFor(adapterId)?.mandate.scope.includes(SUMMON_INITIATE_ACTION) ?? false;
    const tools = maySummon ? [SUMMON_TOOL] : undefined;

    // §7.1 ASSEMBLY. This was `recentMessages(pool, roomId, CONTEXT_MESSAGES)` — the room's log and
    // nothing else, which satisfied the invariant only because no private store existed to violate
    // it. Now the window is assembled from declared sources and `windowFor` asserts, on this turn,
    // that every private part belongs to the principal being summoned. `stamp.principal_id` comes
    // from the members table, not the wire, so a forged frame cannot choose whose store is read.
    const assembly = await assembleContext(pool, {
      memberId: adapterId,
      principalId: stamp.principal_id,
      roomId,
      task: task ? await getTask(pool, task.task_id) : null,
      system: { text: sys, hash: promptHash },
      commonGroundLimit: CONTEXT_MESSAGES,
      // A LOOP turn (order-rooted) also gets the recent agent turns as cycle context, so a member
      // reviewing the previous member's work can see it. A normal turn does not — no extra query on
      // its first-token path (ADR-008 unaffected), and its context is exactly what it was.
      includeRoomTurns: deps.chain?.orderId != null,
    });
    // Throws AssemblyInvariantError rather than returning a window: an unprovable window is not
    // sent to a provider in a weaker form, it is not sent.
    const { systemPrompt: windowSystem, messages } = windowFor(assembly);
    const adapter = adapterFactory(adapterId); // may throw (e.g. missing key) → caught below

    tStreamInvoked = performance.now(); // span boundary: stream() about to be invoked
    for await (const chunk of adapter.stream(messages, {
      systemPrompt: windowSystem,
      maxOutputTokens: cfg.max_output_tokens,
      tools,
    })) {
      if (chunk.kind === 'text_delta') {
        if (tFirstChunk === null) tFirstChunk = performance.now(); // span: first chunk from the SDK
        assembled += chunk.text;
        // Same persist-before-fanout sequence, only split to time it (S0.3c).
        const delta = await appendAgentEvent(
          pool,
          roomId,
          adapterId,
          summon,
          task,
          'agent.turn.delta',
          {
            turn_id: turnId,
            text: chunk.text,
          },
        );
        if (tFirstDeltaCommitted === null) tFirstDeltaCommitted = performance.now(); // span: first delta committed
        publish(delta);
        if (tFirstFanout === null) tFirstFanout = performance.now(); // span: first delta frame written
      } else if (chunk.kind === 'action') {
        // A STRUCTURED ACTION the model emitted. A summon (S1.8) is collected and dispatched through the
        // summon constructor after the turn; EVERY OTHER action (S2.1a) is a governed request, collected
        // here to be routed to requestAction — the evaluator — after the turn completes. Neither path
        // acts during the stream: the turn's own events land first (persist-before-fanout).
        if (chunk.action === 'summon') {
          const target = typeof chunk.arguments.member === 'string' ? chunk.arguments.member : '';
          if (target) emittedSummons.push(target);
        } else {
          emittedActionCount += 1;
          if (emittedActions.length < MAX_ACTIONS_PER_TURN) {
            emittedActions.push({
              action: chunk.action,
              args: chunk.arguments,
              call_id: chunk.call_id,
            });
          }
        }
      } else if (chunk.kind === 'done') {
        tokensIn = chunk.tokens_in;
        tokensOut = chunk.tokens_out;
      } else {
        throw new Error(`${chunk.error_class}: ${chunk.message}`);
      }
    }

    const timings: Record<string, number | null> = {
      t_command: span(t1, t0),
      t_assemble: span(tStreamInvoked, t1),
      t_provider_ttft: span(tFirstChunk, tStreamInvoked),
      t_persist_first: span(tFirstDeltaCommitted, tFirstChunk),
      t_fanout: span(tFirstFanout, tFirstDeltaCommitted),
      ttfd_total: span(tFirstFanout, t0),
      ms_since_prev_turn_in_process: msSincePrev,
    };
    const cost =
      tokensIn != null && tokensOut != null
        ? Number(costUsd(cfg, tokensIn, tokensOut).toFixed(5))
        : null;
    const latencyMs = Date.now() - startedAt;
    // The window's COMPOSITION on the telemetry line, next to what it cost. `own=0` on a turn for a
    // member whose principal has no notes is the honest reading, and `own=N` for one principal while
    // another's store holds items is the isolation being visible in the log rather than only in a
    // test.
    const shape = assemblyShape(assembly);
    console.log(
      `[agent] turn=${turnId} room=${roomId} adapter=${adapterId} in=${tokensIn} out=${tokensOut} cost=$${cost} latency=${latencyMs}ms ttft=${timings.t_provider_ttft}ms ttfd=${timings.ttfd_total}ms ctx=${shapeSummary(shape)}`,
    );

    const completedEvent = await appendAgentEvent(
      pool,
      roomId,
      adapterId,
      summon,
      task,
      'agent.turn.completed',
      {
        turn_id: turnId,
        adapter_id: adapterId,
        text: assembled,
        success: true,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cost_usd: cost,
        error_class: null,
      },
      {
        adapter_id: adapterId,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cost_usd: cost,
        latency_ms: latencyMs,
        prompt_hash: promptHash,
        success: true,
        error_class: null,
        timings,
      },
    );
    publish(completedEvent);

    // THE WORK IS FINISHED, so the task says so — and the member who finished it is the actor.
    // Written after the completed row, in the same order the decisions happened: the turn ends,
    // then the task it belonged to closes.
    await moveTask(deps, 'done', 'the turn completed', adapterId);

    // ── EMITTED SUMMONS, DISPATCHED AFTER THE TURN (S1.8) ────────────────────────────────────
    //
    // This turn's own events are in the log now, so hand each summon it emitted to the SAME
    // constructor a human tag uses — with the chain this turn carries, so the constructor increments
    // the depth, re-checks the emitting agent's mandate, and resolves the target against the room.
    // Deduped, so a model that names a member twice summons it once. Fire-and-forget: the summon
    // triggers the summoned member's turn, which owns its own errors, exactly as a human-tag summon.
    if (emittedSummons.length > 0) {
      const chain = deps.chain;
      if (!chain) {
        // A turn with no chain has no known human root, and a summon must trace to one — so it cannot
        // safely emit. This should not happen (every turn is triggered by the constructor with its
        // chain); logged rather than dropped in silence.
        console.warn(
          `[agent] turn=${turnId} room=${roomId} adapter=${adapterId} emitted ${emittedSummons.length} summon(s) with no chain — refused`,
        );
      } else {
        for (const target of new Set(emittedSummons)) {
          void execute(
            { actorId: adapterId, mode: 'hosted' },
            {
              kind: 'summon',
              roomId,
              member: target,
              causeSeq: startedSeq,
              intent: `${adapterId} summoned ${target}`,
              chain,
            },
          ).catch(() => {}); // the summon path logs its own refusals; this guards the fire-and-forget
        }
      }
    }

    // ── EMITTED GOVERNED ACTIONS → THE EVALUATOR, AFTER THE TURN (S2.1a) ───────────────────
    //
    // The turn's own events are in the log now. Each governed (non-summon) action this turn emitted is
    // routed to requestAction — THE ONE decision-event constructor — evaluated against the EMITTING
    // member's OWN mandate. Standing is checked as it is for any requester and resolves to `self` (the
    // member acting on its own request); subjectBasis is unweakened. NOTHING IS EXECUTED under any
    // verdict — this path ends at the decision event. Arguments are parsed against a schema and a
    // malformed emission is refused HERE, before evaluate(), out loud and with no decision event, so it
    // is distinguishable from a mandate BLOCK. Wrapped so a post-completion throw can never write a
    // second completed row.
    try {
      if (emittedActionCount > MAX_ACTIONS_PER_TURN) {
        publish(
          await appendMessage(
            pool,
            roomId,
            'system',
            `sys-actioncap-${turnId}`,
            `${adapterId} emitted ${emittedActionCount} actions this turn; only the first ${MAX_ACTIONS_PER_TURN} were evaluated (per-turn cap).`,
          ),
        );
      }
      for (let i = 0; i < emittedActions.length; i++) {
        const em = emittedActions[i];
        const clientMsgId = `act-${turnId}-${em.call_id ?? i}`;
        const nameOk =
          typeof em.action === 'string' &&
          em.action.length > 0 &&
          em.action.length <= EMITTED_ACTION_NAME_MAX;
        const argsParsed = parseEmittedArgs(em.args);
        if (!nameOk || !argsParsed) {
          console.warn(
            `[agent] turn=${turnId} room=${roomId} adapter=${adapterId} refused=malformed_emission action=${String(em.action).slice(0, EMITTED_ACTION_NAME_MAX)}`,
          );
          publish(
            await appendMessage(
              pool,
              roomId,
              'system',
              `sys-malformed-${clientMsgId}`,
              `${adapterId} emitted a malformed action; it was refused before evaluation.`,
            ),
          );
          continue;
        }
        // The subject is the EMITTING member — the model cannot name another. requestAction evaluates it
        // and constructs the decision event (CO_SIGN/BLOCK) or audits the ALLOW; it never executes.
        // Awaited, not fire-and-forget like a summon: each is quick — one evaluation and at most one
        // decision insert — and awaiting lands the decisions in order before the loop runner fires.
        await execute(
          { actorId: adapterId, mode: 'hosted' },
          {
            kind: 'requestAction',
            roomId,
            clientMsgId,
            subject: adapterId,
            action: em.action,
            resource: argsParsed.resource,
          },
        );
      }
    } catch (routingErr) {
      console.warn(
        `[agent] turn=${turnId} room=${roomId} adapter=${adapterId} action-routing error: ${String(routingErr)}`,
      );
    }

    // ── THE LOOP RUNNER (S-LOOP) ──────────────────────────────────────────────────────────
    //
    // This completion may be the trigger a standing order waits for. Hand it to the runner — a
    // completed turn drives the next cycle, order-rooted through the order's human creator. Fire-and-
    // forget under `system`: it is the room running its own orders, not this member. `completedEvent.seq`
    // is the fired cycle's cause and idempotency key; `deps.chain?.orderId` names the order this turn
    // belonged to, so an error terminal pauses the right one.
    void execute(
      { actorId: 'system', mode: 'system' },
      {
        kind: 'runOrders',
        roomId,
        member: adapterId,
        completedSeq: completedEvent.seq,
        success: true,
        orderId: deps.chain?.orderId,
      },
    ).catch(() => {});
  } catch (err) {
    // A SUMMON MAY START AT MOST ONE TURN (migration 006). This turn lost the race for
    // the `agent.turn.started` row, so another turn already answers this summon.
    //
    // Return WITHOUT writing a completed row. That row would carry a turn_id nothing
    // started and would itself be a second turn appearing in the log against one summon
    // — the exact drift the index exists to prevent, recorded by the code reporting it.
    // Nothing is owed to the room either: the member asked once and is getting one
    // answer, from the turn that won. `finally` still releases the in-flight key.
    if (isDuplicateTurnForSummon(err)) {
      console.log(
        `[agent] turn=${turnId} room=${roomId} adapter=${adapterId} refused=duplicate_turn_for_summon summon=${summon.summon_id}`,
      );
      return;
    }
    const errorClass = err instanceof Error ? err.name : 'Error';
    const latencyMs = Date.now() - startedAt;
    const failedEvent = await appendAgentEvent(
      pool,
      roomId,
      adapterId,
      summon,
      task,
      'agent.turn.completed',
      {
        turn_id: turnId,
        adapter_id: adapterId,
        text: assembled || `(${adapterId} could not respond)`,
        success: false,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cost_usd: null,
        error_class: errorClass,
      },
      {
        adapter_id: adapterId,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cost_usd: null,
        latency_ms: latencyMs,
        prompt_hash: promptHash,
        success: false,
        error_class: errorClass,
        timings: null,
      },
    );
    publish(failedEvent);

    // THE LOOP RUNNER, on an ERROR terminal (S-LOOP): a turn that failed does not cycle. If this turn
    // belonged to a standing order's cycle, the runner PAUSES that order out loud rather than firing
    // the next — surfacing the failure instead of looping on it.
    void execute(
      { actorId: 'system', mode: 'system' },
      {
        kind: 'runOrders',
        roomId,
        member: adapterId,
        completedSeq: failedEvent.seq,
        success: false,
        orderId: deps.chain?.orderId,
        // THE REASON THE LOOP STOPPED, NAMED. Without it the pause sentence is the same words for a
        // provider outage and for a refusal the fabric itself made, and S17-N1 spent a slice looking
        // like the former while being the latter.
        errorClass,
      },
    ).catch(() => {});

    // §14: THE WORK IS HELD, NOT FINISHED AND NOT REFUSED.
    //
    // "Provider outage or 429 mid-task → task moves to held, persisted; room notified; resumes
    // on recovery" — the first three are this line and the completed row above it. NOTHING
    // RESUMES IT: there is no retry budget and no scheduler, so the state records where the
    // work stopped and does not imply anything picks it up. The error class is the reason,
    // because "held" without one is a state a member cannot act on.
    //
    // The actor is `system`. The room noticed; the agent did not do anything — attributing an
    // outage to the member that was unreachable would read as the member having acted.
    await moveTask(deps, 'held', `the turn failed: ${errorClass}`, 'system');
  } finally {
    lastTurnEndedAt = performance.now();
    inFlight.delete(flightKey);
  }
}
