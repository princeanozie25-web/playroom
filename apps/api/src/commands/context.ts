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
    }
  | {
      kind: 'triggerAgentTurn';
      roomId: string;
      adapterId: string;
      summonId: string;
      taskId: string;
      spans?: TurnSpans;
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
