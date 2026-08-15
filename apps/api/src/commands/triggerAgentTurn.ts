import { runAgentTurn } from '../agent.js';
import type { CommandContext, CommandDeps, SummonChain, TurnSpans } from './context.js';

// The summon trigger, as a command. The turn's own started/delta/completed writes
// stay internal to runAgentTurn (ADR-004: the trigger decision is what passes
// through the entry, not each delta).
export function triggerAgentTurnCommand(
  deps: CommandDeps,
  _ctx: CommandContext,
  input: {
    roomId: string;
    adapterId: string;
    summonId: string;
    taskId: string;
    spans?: TurnSpans;
    chain?: SummonChain;
    orderTriggerSeq?: number;
  },
): Promise<void> {
  return runAgentTurn({
    pool: deps.pool,
    bus: deps.bus,
    roomId: input.roomId,
    adapterId: input.adapterId,
    adapterFactory: deps.adapterFactory,
    // The command entry, so the turn can dispatch an EMITTED summon back through the single
    // constructor (S1.8). And the chain the turn carries, so that summon extends it.
    execute: deps.execute,
    chain: input.chain,
    // The cycle this turn IS, when it is one (S-CYCLE) — carried beside the chain rather than in it,
    // because the chain is inherited by emitted summons and a cycle is counted once.
    orderTriggerSeq: input.orderTriggerSeq,
    spans: input.spans,
    summon: { summon_id: input.summonId },
    task: { task_id: input.taskId },
  });
}
