import type { Pool } from 'pg';
import type { AgentMessage } from '@playroom/shared';
import { latestRoomSummary, messagesAfterSeq, recentCompletedTurns } from './events.js';
import { activeBriefing } from './briefings.js';
import { ROOM_SUMMARY_AUTHOR, SUMMARY_TRIGGER_BATCH } from './summary.js';
import { withPrincipalStore } from './principal-store.js';
import type { TaskRow } from './tasks.js';

/**
 * CONTEXT ASSEMBLY — Bible §7.1, and the invariant is enforced HERE, in the code.
 *
 * §7.1: a turn's window is the system frame, the common ground relevant to the task, the summoned
 * member's OWN principal store, and the task's state. Nothing else. Foreign private stores are
 * unreachable by construction, INCLUDING through summaries, embeddings and promoted items.
 *
 * ── WHY THE INVARIANT IS A FUNCTION AND NOT A TEST ──
 *
 * A test says the invariant held on the inputs the test chose. This project has already shipped one
 * control that was true when written and quietly false later (ADR-006's zero-hit grep), so the
 * check that matters runs on the REAL window on EVERY turn and throws.
 *
 * The mechanism is provenance, not inspection. Every part of the window is built with a declared
 * source, and a part drawn from a private store carries WHOSE. `windowFor` is the only function
 * that turns an Assembly into something an adapter can be handed, and it asserts before it
 * flattens — so there is no path from an assembly to a provider that skips the check.
 *
 * What that buys, concretely: a future commit that adds a source beyond these cannot compile without
 * declaring it, and one that adds a source carrying another principal's text throws at the moment
 * of assembly rather than reading correctly and leaking.
 *
 * Scanning the text instead would be theatre. Jerry's note and Prince's note are both English
 * sentences; nothing about the strings distinguishes them. Provenance is the only thing that does.
 */

/**
 * ══ THE PARTS OF A WINDOW, DECLARED ONCE ══
 *
 * This table is the ONLY place a part of the window is declared. The type below is derived from it,
 * so a part that is not here cannot be named; the allowed set, the flatten order, the shared/private
 * rule, the telemetry keys and the telemetry labels are all read FROM it rather than restated.
 *
 * ── WHY IT IS A TABLE AND NOT A UNION PLUS SOME ARRAYS ──
 *
 * It used to be a union plus a list in `assertOwnPrincipalOnly`, a list in `windowFor`, a branch on
 * `own-store`, a literal per key in `assemblyShape`, and a hand-written telemetry string in agent.ts —
 * six enumerations of one fact. S-LOOP added `room-turns` to the union and to `assembleContext` and
 * touched none of the rest, so every order-rooted cycle threw §7.1 on its own feature, `agent.ts`
 * caught it into a failed turn, and the standing order paused wearing a reason that read like an
 * ordinary model failure (S17-N1). S1.7 then hit the same shape and survived it by REMEMBERING to edit
 * four sites. The next part would have had to remember too.
 *
 * The suite could not have caught it: the part is only pushed when the room already holds a completed
 * turn to carry, and the order tests synthesise the trigger without writing one.
 *
 * So the enumerations are gone rather than synchronised. Adding a part is one entry here, and there is
 * no second place that can be forgotten — the failure mode is deleted, not documented.
 *
 * A part is COMMON GROUND unless it says `private`. Common ground is the room's own log, readable by
 * every member, holding nobody's private context; `private` is the one kind that must name whose it is
 * and is checked against the summoned principal below.
 */
interface PartDeclaration {
  /** The name a part carries. Also the key of the assertion and the order below. */
  readonly source: string;
  /** `private` parts MUST name their principal and it must be the summoned one. `shared` must not. */
  readonly ownership: 'shared' | 'private';
  /** The short name this part wears on the telemetry line, so the log follows the declaration. */
  readonly label: string;
  /** Why §7.1 allows it. Written here because this is where the decision is actually made. */
  readonly why: string;
}

/**
 * DECLARATION ORDER IS WINDOW ORDER. Reordering these reorders the window, deliberately.
 *
 * Exported so the tests can walk the declaration itself rather than a copy of it: a test that listed
 * the parts again would be the seventh enumeration, and would pass while the sixth was wrong.
 */
export const ASSEMBLY_PARTS = [
  {
    source: 'briefing',
    ownership: 'shared',
    label: 'brief',
    why:
      "the room's owner-authored framing (S1.7), FIRST so it frames everything after it. Pinned — read " +
      'from the active record, not the message tail, so window pressure cannot evict it. Inherited by ' +
      'every member, and NOT a `message` event, so a briefing that reads like a tag summons nobody.',
  },
  {
    source: 'common-ground',
    ownership: 'shared',
    label: 'common',
    why:
      "the room's own append-only log — the rolling summary of the older messages (S1.6) followed by " +
      'the recent window. Shared by construction: every member of the room can read it.',
  },
  {
    source: 'room-turns',
    ownership: 'shared',
    label: 'turns',
    why:
      'the recent completed agent turns (S-LOOP), so a member summoned into an unattended cycle sees ' +
      'the prior member’s work — which PM7 deliberately keeps out of the message window. Also the ' +
      'room’s own log, and never a `message` event, so the activation boundary is untouched: it ' +
      'changes what an agent READS, not what can summon one.',
  },
  {
    source: 'own-store',
    ownership: 'private',
    label: 'own',
    why:
      "the summoned member's OWN principal store (§7.1) — the only part that may name a principal, " +
      'and the only one the assertion below has anything to compare.',
  },
  {
    source: 'task',
    ownership: 'shared',
    label: 'task',
    why: "the task's state — LAST, so the thing being worked on sits nearest the response.",
  },
] as const satisfies readonly PartDeclaration[];

/** Derived, not restated: a source is a source because it is in the table above. */
export type PartSource = (typeof ASSEMBLY_PARTS)[number]['source'];

/** The lookup the assertion uses. One map, built from the one declaration. */
const DECLARED: ReadonlyMap<string, PartDeclaration> = new Map(
  ASSEMBLY_PARTS.map((part) => [part.source, part]),
);

/** The declared sources, for a refusal that says what WAS expected rather than only what was wrong. */
const DECLARED_SOURCES = ASSEMBLY_PARTS.map((part) => part.source).join(', ');

/** `common-ground` → `common_ground`. The telemetry key for a source, derived from its name. */
function shapeKey(source: string): string {
  return source.replace(/-/g, '_');
}

/** How many recent completed turns feed a summon's cycle context (S-LOOP). Bounded, like the window. */
const RECENT_TURNS_IN_CONTEXT = 8;

export interface AssemblyPart {
  source: PartSource;
  /**
   * WHOSE private context this is. Non-null ONLY for 'own-store'.
   *
   * Shared sources are null rather than "everyone" — a part that names no principal is a part the
   * assertion below has nothing to compare, and common ground is common by definition (it is the
   * room's own append-only log, readable by every member of the room).
   */
  principal_id: string | null;
  messages: AgentMessage[];
}

export interface Assembly {
  /** The member being summoned, and the principal it acts for — both derived from the stamp. */
  readonly member_id: string;
  readonly principal_id: string;
  readonly system: { text: string; hash: string };
  readonly parts: readonly AssemblyPart[];
}

/**
 * Thrown when the window would contain context from a principal other than the one being summoned.
 *
 * A distinct class because the difference between "this turn failed" and "this turn was about to
 * cross a principal boundary" is the difference between an incident and a bug.
 */
export class AssemblyInvariantError extends Error {
  constructor(
    readonly detail: string,
    readonly expected: string,
    readonly found: string[],
  ) {
    super(`§7.1 assembly invariant violated: ${detail} (member acts for ${expected})`);
    this.name = 'AssemblyInvariantError';
  }
}

/** Authors for the non-conversational parts. Not member ids, and not addressable. */
const OWN_STORE_AUTHOR = 'context/your-own-notes';
const TASK_AUTHOR = 'context/task-state';
/** The room's briefing (S1.7). A context author, not a member — so it frames, and cannot be addressed. */
const ROOM_BRIEFING_AUTHOR = 'context/room-briefing';

/**
 * THE ASSERTION. Every private part belongs to the principal being summoned, and there is exactly
 * one such principal.
 *
 * Three failures, separately named, because "assembly failed" would not tell an operator which:
 *  - a part names a DIFFERENT principal — a foreign store reached the window
 *  - parts name MORE THAN ONE principal — two stores were merged, which is the same leak twice
 *  - a part claims an UNDECLARED source — an input was added without a decision about it
 */
export function assertOwnPrincipalOnly(assembly: Assembly): void {
  const principals = new Set<string>();
  for (const part of assembly.parts) {
    // THE REFUSAL NAMES WHAT WAS EXPECTED. An undeclared part is not a mystery failure deep in
    // assembly: it says which source arrived and which ones the table declares, so the operator
    // reading a paused loop's turn row can tell a forgotten declaration from a provider outage.
    const declared = DECLARED.get(part.source);
    if (!declared) {
      throw new AssemblyInvariantError(
        `part declares the undeclared source "${String(part.source)}" — the window's parts are ` +
          `declared once, and this is not one of them (${DECLARED_SOURCES})`,
        assembly.principal_id,
        [],
      );
    }
    if (declared.ownership === 'private') {
      if (part.principal_id === null) {
        throw new AssemblyInvariantError(
          'a private part names no principal, so it cannot be shown to belong to this one',
          assembly.principal_id,
          [],
        );
      }
      principals.add(part.principal_id);
    } else if (part.principal_id !== null) {
      // A shared source that names a principal is a private source mislabelled.
      throw new AssemblyInvariantError(
        `the shared part "${part.source}" names principal ${part.principal_id}`,
        assembly.principal_id,
        [part.principal_id],
      );
    }
  }
  const foreign = [...principals].filter((p) => p !== assembly.principal_id);
  if (foreign.length > 0) {
    throw new AssemblyInvariantError(
      `${foreign.length} foreign principal store(s) in the window`,
      assembly.principal_id,
      foreign,
    );
  }
  if (principals.size > 1) {
    throw new AssemblyInvariantError(
      'more than one principal store in the window',
      assembly.principal_id,
      [...principals],
    );
  }
}

/**
 * Flatten an assembly into what the adapter is handed. THE ONLY SUCH PATH, and it asserts first.
 *
 * The order is the DECLARATION ORDER — the owner's framing first so it frames everything that follows,
 * the shared record next so private context reads as an addition to it, and the task last so the thing
 * being worked on is nearest the response. A part cannot be missing from the order, because there is
 * no order to be missing from: this walks the same table that says the part exists.
 */
export function windowFor(assembly: Assembly): {
  systemPrompt: string;
  messages: AgentMessage[];
} {
  assertOwnPrincipalOnly(assembly);
  const messages: AgentMessage[] = [];
  for (const declared of ASSEMBLY_PARTS) {
    for (const part of assembly.parts.filter((p) => p.source === declared.source)) {
      messages.push(...part.messages);
    }
  }
  return { systemPrompt: assembly.system.text, messages };
}

/**
 * What went into a window, for telemetry and for a test to assert the corpus was not empty. Keyed off
 * the declaration, so a new part is counted the day it exists rather than the day someone remembers.
 */
export function assemblyShape(assembly: Assembly): Record<string, number> {
  const shape: Record<string, number> = {};
  for (const declared of ASSEMBLY_PARTS) {
    shape[shapeKey(declared.source)] = assembly.parts
      .filter((p) => p.source === declared.source)
      .reduce((n, p) => n + p.messages.length, 0);
  }
  return shape;
}

/**
 * The window's composition as one telemetry field — `brief:1+common:12+turns:3+own:0+task:1`.
 *
 * DERIVED FROM THE DECLARATION, because the hand-written version was already wrong: it was written
 * before the briefing existed and never grew a `brief:` term, so every logged turn since S1.7 reported
 * a composition that silently omitted a whole region of what the model was sent.
 */
export function shapeSummary(shape: Record<string, number>): string {
  return ASSEMBLY_PARTS.map((d) => `${d.label}:${shape[shapeKey(d.source)] ?? 0}`).join('+');
}

export interface AssembleInput {
  /** The summoned member and the principal it acts for. Both from `stampFor`, never from the wire. */
  memberId: string;
  principalId: string;
  roomId: string;
  /** The task this turn is working, when there is one. */
  task: TaskRow | null;
  system: { text: string; hash: string };
  /** How much common ground to reach for. PM7's cap, passed in so the caller owns it. */
  commonGroundLimit: number;
  /**
   * Include the recent agent turns as cycle context (S-LOOP). Set ONLY for an order-rooted (loop) turn,
   * so a normal turn's assembly is unchanged — no extra query, no change to what an ordinary agent
   * reads. The caller (runAgentTurn) sets it from the turn's chain: an order-rooted turn is a loop turn.
   */
  includeRoomTurns?: boolean;
}

/**
 * Build the window for one turn.
 *
 * ── THERE IS NO PARAMETER FOR WHOSE STORE TO READ ──
 *
 * `principalId` is the principal of the member being summoned — from `stampFor`, i.e. from the
 * members table, never from the wire. It opens ONE store, and a caller cannot ask for someone
 * else's context because there is nowhere to put the request.
 *
 * The part's ownership label does NOT come from `principalId`. It comes from `store.principal`, the
 * principal the transaction was actually scoped to, so the assertion downstream compares two
 * independently-derived values instead of one value against itself. See the comment at the store
 * read; that arrangement is what a mutation test forced.
 *
 * The store read goes through `withPrincipalStore`, so the database refuses a foreign row even if
 * this function is wrong. Two mechanisms; see principal-store.ts for why one is not enough on this
 * deployment.
 */
export async function assembleContext(pool: Pool, input: AssembleInput): Promise<Assembly> {
  const parts: AssemblyPart[] = [];

  // 0. THE ROOM BRIEFING (S1.7) — owner-authored framing, its OWN region AHEAD of the summary and the
  //    recent window. Common ground (shared, principal_id null): every member of the room inherits it,
  //    it is nobody's private context, and it is NOT a `message` event, so it cannot activate a summon.
  //    PINNED: read from the ACTIVE RECORD, not the windowed message tail, so no amount of recent-window
  //    pressure can evict it — a briefing the room has is a briefing every summon sees. Absent → no part,
  //    so a room with no briefing assembles exactly as it did before this slice.
  const briefing = await activeBriefing(pool, input.roomId);
  if (briefing) {
    parts.push({
      source: 'briefing',
      principal_id: null,
      messages: [{ author: ROOM_BRIEFING_AUTHOR, body: briefing.content }],
    });
  }

  // 1. COMMON GROUND — the room's own log, shared by construction: every member can read it, so it
  //    is the one part that is nobody's private context. As of S1.6 it is a ROLLING SUMMARY of the
  //    older messages (when the room is long enough to have one) followed by the RECENT WINDOW.
  //    Before, common ground was the last N messages and everything older was simply gone — a long
  //    room lost its start. The summary is common ground too: a compression of the room's own log,
  //    attributed, holding nobody's private context, so it is one more common-ground part rather
  //    than a new source (the §7.1 invariant's allowed set is unchanged).
  //
  //    Assembly only READS the summary — one indexed row. It never generates one: that is maintained
  //    AHEAD of the summon on the message path (summary.ts), so nothing here makes a model call and
  //    the summon's first token is unaffected (§7, ADR-008).
  const summary = await latestRoomSummary(pool, input.roomId);
  if (summary) {
    parts.push({
      source: 'common-ground',
      principal_id: null,
      messages: [{ author: ROOM_SUMMARY_AUTHOR, body: summary.text }],
    });
  }
  // The recent window is the messages AFTER the summary's coverage (all of them when there is no
  // summary, since the floor is 0). Coverage and window meet exactly — a message is summarised or
  // recent, never both and never neither. Capped at the window plus one batch of slack: the backstop
  // that keeps the tail bounded if maintenance is briefly behind.
  const floor = summary ? summary.covers_through_seq : 0;
  const roomMessages = await messagesAfterSeq(
    pool,
    input.roomId,
    floor,
    input.commonGroundLimit + SUMMARY_TRIGGER_BATCH,
  );
  parts.push({ source: 'common-ground', principal_id: null, messages: roomMessages });

  // 1b. RECENT AGENT TURNS — the loop's cycle context (S-LOOP), and ONLY for a loop turn. The window
  //     above is the human conversation; PM7 keeps the members' own turns out of it, which is right for
  //     chat but leaves an unattended cycle's reviewer blind to the draft it is reviewing. This adds the
  //     last few completed turns as COMMON GROUND — shared, read-only, NOT a message event, so the
  //     activation boundary is untouched. Gated on `includeRoomTurns` (an order-rooted turn) so a normal
  //     human-mediated turn is unchanged — no extra query on its first-token path (ADR-008), and no
  //     change to what an ordinary agent reads. It changes what a LOOP member reads, never what summons.
  if (input.includeRoomTurns) {
    const roomTurns = await recentCompletedTurns(pool, input.roomId, RECENT_TURNS_IN_CONTEXT);
    if (roomTurns.length > 0) {
      parts.push({ source: 'room-turns', principal_id: null, messages: roomTurns });
    }
  }

  // 2. THE MEMBER'S OWN STORE — and only through the scoped transaction.
  // THE LABEL COMES FROM THE STORE, NOT FROM THE INPUT — and that is not a stylistic choice.
  //
  // Labelling the part `input.principalId` would make the assertion tautological: the same value
  // would be both what the part claims and what it is checked against, so a read that opened the
  // WRONG store would produce a part correctly labelled "mine" and sail through. Found by mutating
  // this exact line to read a literal foreign principal — the text assertions in the isolation test
  // caught it, the invariant did not, which is the wrong way round for the mechanism that runs in
  // production.
  //
  // `store.principal` is the principal the TRANSACTION was scoped to. Comparing that against the
  // stamp gives the assertion two independently-derived values, which is the only arrangement in
  // which agreement means anything.
  const own = await withPrincipalStore(pool, input.principalId, async (store) => ({
    boundTo: store.principal,
    items: await store.items(),
  }));
  if (own.items.length > 0) {
    parts.push({
      source: 'own-store',
      principal_id: own.boundTo,
      messages: own.items.map((item) => ({
        author: OWN_STORE_AUTHOR,
        // A SUMMARY IS PREFERRED WHERE ONE EXISTS (§7.3, minimisation): the shorter form is the
        // less context in the window, and it is the same row under the same policy either way.
        body: `${item.title} — ${item.summary ?? item.body}`,
      })),
    });
  }

  // 3. TASK STATE. Its artifacts are not here because THERE ARE NO ARTIFACTS: nothing in this
  //    system produces one yet, and a field carrying `[]` on every turn would read as a capability.
  if (input.task) {
    const t = input.task;
    parts.push({
      source: 'task',
      principal_id: null,
      messages: [
        {
          author: TASK_AUTHOR,
          body:
            `task ${t.id} is ${t.state}; intent "${t.intent}"` +
            (t.action ? `; action ${t.action}` : '') +
            `; opened by ${t.created_by}`,
        },
      ],
    });
  }

  return {
    member_id: input.memberId,
    principal_id: input.principalId,
    system: input.system,
    parts,
  };
}
