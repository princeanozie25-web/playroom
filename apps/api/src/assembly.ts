import type { Pool } from 'pg';
import type { AgentMessage } from '@playroom/shared';
import { recentMessages } from './events.js';
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

/** The three message-bearing sources §7.1 allows. A fourth requires editing this union, on purpose. */
export type PartSource = 'common-ground' | 'own-store' | 'task';

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
  const allowed: PartSource[] = ['common-ground', 'own-store', 'task'];
  const principals = new Set<string>();
  for (const part of assembly.parts) {
    if (!allowed.includes(part.source)) {
      throw new AssemblyInvariantError(
        `part declares an unknown source "${String(part.source)}"`,
        assembly.principal_id,
        [],
      );
    }
    if (part.source === 'own-store') {
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
 * Order is deliberate: common ground, then the member's own notes, then the task's state — the
 * shared record first so private context reads as an addition to it, and the task last so the thing
 * being worked on is nearest the response.
 */
export function windowFor(assembly: Assembly): {
  systemPrompt: string;
  messages: AgentMessage[];
} {
  assertOwnPrincipalOnly(assembly);
  const order: PartSource[] = ['common-ground', 'own-store', 'task'];
  const messages: AgentMessage[] = [];
  for (const source of order) {
    for (const part of assembly.parts.filter((p) => p.source === source)) {
      messages.push(...part.messages);
    }
  }
  return { systemPrompt: assembly.system.text, messages };
}

/** What went into a window, for telemetry and for a test to assert the corpus was not empty. */
export function assemblyShape(assembly: Assembly): Record<string, number> {
  const count = (s: PartSource): number =>
    assembly.parts.filter((p) => p.source === s).reduce((n, p) => n + p.messages.length, 0);
  return {
    common_ground: count('common-ground'),
    own_store: count('own-store'),
    task: count('task'),
  };
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

  // 1. COMMON GROUND — the room's own log. Shared by construction: every member of the room can
  //    read it, so it is the one part that is nobody's private context.
  const roomMessages = await recentMessages(pool, input.roomId, input.commonGroundLimit);
  parts.push({ source: 'common-ground', principal_id: null, messages: roomMessages });

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
