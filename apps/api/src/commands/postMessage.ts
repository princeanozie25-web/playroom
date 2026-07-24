import type { ServerEvent } from '@playroom/shared';
import { appendMessage } from '../events.js';
import { summonedAdapterId } from '../agent.js';
import type { CommandContext, CommandDeps } from './context.js';

// Persist a message, fan it out, and — if it summons an agent — trigger the turn
// as its own command through the same entry (ADR-004: the trigger decision passes
// through executeCommand; the turn's internal delta/completed writes do not).
export async function postMessageCommand(
  deps: CommandDeps,
  ctx: CommandContext,
  input: { roomId: string; clientMsgId: string; body: string },
): Promise<ServerEvent> {
  // §8 ordering law: persist first, fan out only after COMMIT.
  const event = await appendMessage(
    deps.pool,
    input.roomId,
    ctx.actorId,
    input.clientMsgId,
    input.body,
  );
  deps.bus.publish(input.roomId, event);

  const summoned = summonedAdapterId(event);
  if (summoned) {
    void deps
      .execute(
        { actorId: summoned, mode: 'hosted' },
        { kind: 'triggerAgentTurn', roomId: input.roomId, adapterId: summoned },
      )
      .catch(() => {}); // runAgentTurn writes its own error event; this guards the fire-and-forget
  }

  return event;
}
