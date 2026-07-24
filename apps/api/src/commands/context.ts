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
  | { kind: 'triggerAgentTurn'; roomId: string; adapterId: string; spans?: TurnSpans };

// Dependencies the command handlers need. `execute` lets a handler re-enter the
// single entry (e.g. postMessage triggering an agent turn) so the trigger decision
// still passes through executeCommand — without a circular import between modules.
export interface CommandDeps {
  pool: Pool;
  bus: RoomBus;
  adapterFactory: (id: string) => AgentAdapter;
  execute: (ctx: CommandContext, command: Command) => Promise<unknown>;
}

export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandError';
  }
}
