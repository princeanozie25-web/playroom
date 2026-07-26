import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import type { AgentAdapter, AgentMessage, ServerEvent } from '@playroom/shared';
import { costUsd, getAdapterConfig, listAdapters } from '@playroom/adapters';
import type { RoomBus } from './bus.js';
import { appendAgentEvent, appendMessage, recentMessages, type SummonRef } from './events.js';

const CONTEXT_MESSAGES = 30; // PM7 hard cap — last 30 room messages, nothing more

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
const inFlightKey = (roomId: string, adapterId: string): string => `${roomId} ${adapterId}`;

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
  // The summon this turn answers. Required, so a turn cannot exist without one.
  summon: SummonRef;
  spans?: { t0: number; t1: number }; // S0.3c: command-entry + message-committed boundaries
}

// Run an agent turn as a sequence of persisted events: started → deltas →
// completed. Persist-before-fanout holds for every one (ADR-003). A failure is
// written as completed{success:false} with an error_class — never a silent hang.
export async function runAgentTurn(deps: AgentTurnDeps): Promise<void> {
  const { pool, bus, roomId, adapterId, adapterFactory, spans, summon } = deps;
  const publish = (ev: ServerEvent): void => bus.publish(roomId, ev);

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
    publish(
      await appendAgentEvent(pool, roomId, adapterId, summon, 'agent.turn.started', {
        turn_id: turnId,
        adapter_id: adapterId,
      }),
    );

    const messages: AgentMessage[] = await recentMessages(pool, roomId, CONTEXT_MESSAGES);
    const adapter = adapterFactory(adapterId); // may throw (e.g. missing key) → caught below

    tStreamInvoked = performance.now(); // span boundary: stream() about to be invoked
    for await (const chunk of adapter.stream(messages, {
      systemPrompt: sys,
      maxOutputTokens: cfg.max_output_tokens,
    })) {
      if (chunk.kind === 'text_delta') {
        if (tFirstChunk === null) tFirstChunk = performance.now(); // span: first chunk from the SDK
        assembled += chunk.text;
        // Same persist-before-fanout sequence, only split to time it (S0.3c).
        const delta = await appendAgentEvent(pool, roomId, adapterId, summon, 'agent.turn.delta', {
          turn_id: turnId,
          text: chunk.text,
        });
        if (tFirstDeltaCommitted === null) tFirstDeltaCommitted = performance.now(); // span: first delta committed
        publish(delta);
        if (tFirstFanout === null) tFirstFanout = performance.now(); // span: first delta frame written
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
    console.log(
      `[agent] turn=${turnId} room=${roomId} adapter=${adapterId} in=${tokensIn} out=${tokensOut} cost=$${cost} latency=${latencyMs}ms ttft=${timings.t_provider_ttft}ms ttfd=${timings.ttfd_total}ms`,
    );

    publish(
      await appendAgentEvent(
        pool,
        roomId,
        adapterId,
        summon,
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
      ),
    );
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
    publish(
      await appendAgentEvent(
        pool,
        roomId,
        adapterId,
        summon,
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
      ),
    );
  } finally {
    lastTurnEndedAt = performance.now();
    inFlight.delete(flightKey);
  }
}
