import { runAgentTurn } from '../agent.js';
import type { CommandContext, CommandDeps, TurnSpans } from './context.js';

// The @claude trigger, as a command. The turn's own started/delta/completed writes
// stay internal to runAgentTurn (ADR-004: the trigger decision is what passes
// through the entry, not each delta).
export function triggerAgentTurnCommand(
  deps: CommandDeps,
  _ctx: CommandContext,
  input: { roomId: string; adapterId: string; spans?: TurnSpans },
): Promise<void> {
  return runAgentTurn({
    pool: deps.pool,
    bus: deps.bus,
    roomId: input.roomId,
    adapterId: input.adapterId,
    adapterFactory: deps.adapterFactory,
    spans: input.spans,
  });
}
