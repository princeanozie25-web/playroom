import type { Pool } from 'pg';
import type { AgentAdapter } from '@playroom/shared';
import type { WriteBackend } from '@playroom/write';
import type { RoomBus } from '../bus.js';

// ADR-004: which membership mode originated a command. 'connected' and 'bridged'
// are RESERVED for P4 (OAuth/MCP connectors + GitHub/email bridges) — typed now,
// unused until then. See docs/decisions/ADR-004-membership-modes.md.
export interface CommandContext {
  actorId: string;
  principalId?: string; // reserved: OAuth/bridge principal binding (P4)
  mode: 'human' | 'hosted' | 'system' | 'connected' | 'bridged';
}

// Two latency-span boundaries captured before the turn starts (S0.3c). Optional,
// observation-only — carried into the turn so t_command/t_assemble land in `timings`.
export interface TurnSpans {
  t0: number; // executeCommand entry (performance.now())
  t1: number; // triggering message row committed
}

/**
 * The provenance chain a turn carries and an agent-emitted summon extends (S1.8): the human at the
 * head of the chain, and the depth of the summon that authorised this turn. A turn passes its own
 * chain when it emits a summon; the constructor increments the depth and the cap sees one more hop.
 */
export interface SummonChain {
  rootActor: string;
  rootIsHuman: boolean;
  depth: number;
  /**
   * The standing order this chain belongs to (S-LOOP), if any. An order fires a cycle's first summon
   * with this set; it is threaded down so a summon that turn emits inherits it, and the whole cycle
   * reads as order-rooted in the drift ledger. Absent for a human-tag or free agent-emitted chain.
   */
  orderId?: string;
}

// A room-mutating command. Reads (getRoom, replay) do not pass through the entry.
export type Command =
  | { kind: 'createRoom'; id?: string; title?: string }
  | { kind: 'postMessage'; roomId: string; clientMsgId: string; body: string }
  // Ask a member to take a turn. The ONLY way a summon comes into existence — see
  // commands/summon.ts, which owns depth and the root it records. `member` is an adapter
  // id the boundary already resolved, never a raw `@token`, and there is no depth field
  // because the constructor can only produce a human root.
  | {
      kind: 'summon';
      roomId: string;
      member: string;
      causeSeq: number;
      intent: string;
      spans?: TurnSpans;
      // Present ONLY when an agent emitted this summon (S1.8). Its presence is what admits an agent
      // root; the constructor checks the emitting agent's mandate and the depth cap when it is set.
      chain?: SummonChain;
    }
  | {
      kind: 'triggerAgentTurn';
      roomId: string;
      adapterId: string;
      summonId: string;
      taskId: string;
      spans?: TurnSpans;
      // The chain this turn carries, so if it emits a summon the constructor knows the root and depth.
      chain?: SummonChain;
      // The completion that triggered this turn's CYCLE — present only for a standing order's own
      // first turn (S-CYCLE), which is the one that counts. Outside the chain because a chain is
      // inherited by emitted summons and a cycle is counted once.
      orderTriggerSeq?: number;
    }
  // A standing order's cycle has a turn (S-CYCLE). Dispatched under `system` from the seam that just
  // wrote `agent.turn.started` — the durable proof that the cycle is doing something — and it is the
  // ONLY writer of the cycle counters. Before it existed, a cycle was counted when it was allowed to
  // begin, so a summon that never became a turn still moved the numbers the loop's bounds read
  // (SD-N1). Awaited by its caller, unlike the post-completion runner: an uncounted cycle is one the
  // cap will not bound, so a failure here must stop the turn rather than be swallowed.
  | { kind: 'orderCycleStarted'; roomId: string; orderId: string; triggerSeq: number }
  // Hand a task to another member (S1.3). Returns a refusal rather than throwing: four
  // preconditions, four reasons, and the caller turns them into typed frames.
  | { kind: 'handoff'; roomId: string; taskId: string; toMember: string; action: string }
  // A governed action request. Traverses the mandate evaluator; nothing executes.
  | {
      kind: 'requestAction';
      roomId: string;
      clientMsgId: string;
      subject: string;
      action: string;
      resource: string;
      // C3: facts assembled from history, so a host grant's `requires` can be met. Optional; absent = none.
      facts?: readonly string[];
    }
  // Raise a bare hand (SCC-3): a connected member surfaces a standalone BLOCKER/FYI — a claim on a
  // human's attention that is NOT a decision. Mints no decision event; charged to the raiser's daily
  // interrupt budget. `actorId` is the credential's member; `urgency` is never DECISION (that is the
  // co-sign path's, and the door rejects it before here).
  | {
      kind: 'raiseHand';
      roomId: string;
      clientMsgId: string;
      urgency: 'BLOCKER' | 'FYI';
      reason: string;
    }
  // Complete a co-signature (S2.2): a human approves or denies a pending decision. `actorId` is the
  // SIGNER, authenticated by the socket — an agent can never reach a landing resolution through here.
  | {
      kind: 'signDecision';
      roomId: string;
      clientMsgId: string;
      decisionId: string;
      resolution: 'APPROVED' | 'DENIED';
    }
  // Create a standing order (S-LOOP): a human authorises recurring work. `actorId` is the creator,
  // authenticated by the socket — an agent can never create one.
  | {
      kind: 'createOrder';
      roomId: string;
      clientMsgId: string;
      triggerEventType: string;
      triggerMember: string;
      actionMember: string;
      maxCycles: number | null;
      maxUnattendedCycles: number;
      expiresAt: string | null;
      /** What the order is for (S-TASK) — refused by name when absent, so it is optional here. */
      task?: string;
    }
  // Pause, resume or revoke a standing order (S-LOOP). Any human pauses; only the creator resumes or
  // revokes; an agent does none. `actorId` is the authenticated member.
  | {
      kind: 'controlOrder';
      roomId: string;
      clientMsgId: string;
      orderId: string;
      op: 'pause' | 'resume' | 'revoke';
    }
  // Editing an order's TERMS (S-UI3): the dial, the cycle cap, the expiry. The wiring is immutable and
  // absent here — rewiring is revoke-and-recreate. Creator-only, agents refused, evented before/after.
  | {
      kind: 'updateOrder';
      roomId: string;
      clientMsgId: string;
      orderId: string;
      maxCycles: number | null;
      maxUnattendedCycles: number;
      expiresAt: string | null;
    }
  // Set or replace the room's briefing (S1.7): owner-authored framing pinned to the room. Owner-only
  // and human-only (checked against the authenticated member, never the frame); confers no authority.
  | {
      kind: 'setBriefing';
      roomId: string;
      clientMsgId: string;
      content: string;
      purpose: string;
    }
  // Give a room a document (S-UPLOAD). Human-only, text-only, capped per document and per room —
  // an upload is a promotion, so the record precedes the copy and the content is inert.
  | {
      kind: 'uploadDocument';
      roomId: string;
      clientMsgId: string;
      title: string;
      purpose: string;
      provenance: string;
      declaredType: string;
      content: string;
    }
  // Take one back. Explicit and evented: absent and removed are different states.
  | { kind: 'removeDocument'; roomId: string; clientMsgId: string; documentId: string }
  // Clear the room's briefing (S1.7). Explicit — a room with no active briefing has nothing to clear.
  | { kind: 'clearBriefing'; roomId: string; clientMsgId: string }
  // Admit a member to a room (ADR-009, the room door). Creation enrols only the creator now; this is how
  // everyone else gets in. Owner-only and human-only (an agent may never widen the room), idempotent, and
  // it confers no authority beyond membership — the member becomes addressable and visible, nothing more.
  | { kind: 'admit'; roomId: string; member: string }
  // The loop runner (S-LOOP): a completed turn drives the next cycle. Dispatched fire-and-forget from
  // the post-completion seam under a `system` actor — it is the room running its own standing orders,
  // not a member acting. `orderId` is the completed turn's order (from its chain), for the error-pause;
  // `errorClass` is that failure's class, so the pause the owner reads names what actually stopped it.
  | {
      kind: 'runOrders';
      roomId: string;
      member: string;
      completedSeq: number;
      success: boolean;
      orderId?: string;
      errorClass?: string | null;
    }
  // Fold the room's older messages into its rolling summary, if the tail has grown past the window
  // (S1.6). Dispatched fire-and-forget from postMessage so the summary is maintained AHEAD of the
  // next summon, never on the summon's own first-token path. Idempotent and cheap when there is
  // nothing to fold. Runs under a `system` actor — it is the room maintaining itself.
  | { kind: 'maintainSummary'; roomId: string };

// Dependencies the command handlers need. `execute` lets a handler re-enter the
// single entry (e.g. postMessage triggering an agent turn) so the trigger decision
// still passes through executeCommand — without a circular import between modules.
// The subset of the Fastify logger the command layer needs. Passed in rather than
// imported so a handler cannot log to a different destination than the server does —
// A4-F1 was an unobserved logger, and one logger is easier to observe than two.
export interface CommandLogger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

export interface CommandDeps {
  pool: Pool;
  bus: RoomBus;
  log: CommandLogger;
  adapterFactory: (id: string) => AgentAdapter;
  execute: (ctx: CommandContext, command: Command) => Promise<unknown>;
  /**
   * Own work intentionally kept off the foreground latency path. A server supplies this so shutdown
   * can drain it before closing Postgres. Direct command tests may omit it and keep the legacy local
   * fallback, but production request paths never discard a promise.
   */
  defer?: (label: string, task: () => Promise<unknown>) => boolean;
  /**
   * ADR-020: the OUTBOUND WRITE backend the write executor (fireWrite) performs through, on an APPROVED
   * `write.perform` decision. Optional — a deployment or a test without it records the write as
   * `not_configured` and performs nothing (never an accidental post). Server boot defaults it to the Mock.
   */
  writeBackend?: WriteBackend;
}

/** Schedule background work through its server owner, with a safe fallback for isolated commands. */
export function deferCommandWork(
  deps: CommandDeps,
  label: string,
  task: () => Promise<unknown>,
): void {
  if (deps.defer) {
    deps.defer(label, task);
    return;
  }
  void task().catch((error) => deps.log.error({ err: error }, `${label} failed`));
}

export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandError';
  }
}
