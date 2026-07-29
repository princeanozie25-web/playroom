import type { Pool } from 'pg';
import type { AgentAdapter } from '@playroom/shared';
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
    }
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
  // The loop runner (S-LOOP): a completed turn drives the next cycle. Dispatched fire-and-forget from
  // the post-completion seam under a `system` actor — it is the room running its own standing orders,
  // not a member acting. `orderId` is the completed turn's order (from its chain), for the error-pause.
  | {
      kind: 'runOrders';
      roomId: string;
      member: string;
      completedSeq: number;
      success: boolean;
      orderId?: string;
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
}

export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandError';
  }
}
