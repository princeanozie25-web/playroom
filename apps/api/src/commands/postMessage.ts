import { performance } from 'node:perf_hooks';
import type { ServerEvent } from '@playroom/shared';
import { appendMessage } from '../events.js';
import { summonRuling } from '../agent.js';
import type { CommandContext, CommandDeps } from './context.js';

// Persist a message, fan it out, and dispatch a summon for each member it named — each
// as its own command through the same entry (ADR-004).
//
// THIS FUNCTION NO LONGER BUILDS A SUMMON. It decides WHO was named — `summonRuling` is
// the activation boundary, refusing generated text, non-room content, system output and
// agent-authored messages by name — and `summonCommand` decides whether a summon may
// exist and what it records. One construction site, so depth, root and the null branch
// are read in one place instead of maintained by convention at each caller.
export async function postMessageCommand(
  deps: CommandDeps,
  ctx: CommandContext,
  input: { roomId: string; clientMsgId: string; body: string },
): Promise<ServerEvent> {
  const t0 = performance.now(); // S0.3c span boundary: command entry
  // §8 ordering law: persist first, fan out only after COMMIT.
  const event = await appendMessage(
    deps.pool,
    input.roomId,
    ctx.actorId,
    input.clientMsgId,
    input.body,
  );
  const t1 = performance.now(); // S0.3c span boundary: triggering message committed
  deps.bus.publish(input.roomId, event);

  const ruling = summonRuling(event);

  // Serial, not Promise.all: two summons of two members are two independent turns, but
  // they share one connection pool and the second gains nothing from racing the first.
  for (const member of ruling.members) {
    await deps.execute(ctx, {
      kind: 'summon',
      roomId: input.roomId,
      member,
      causeSeq: event.seq,
      spans: { t0, t1 },
    });
  }

  return event;
}
