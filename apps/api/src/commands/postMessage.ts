import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ServerEvent } from '@playroom/shared';
import { appendMessage, appendSummon } from '../events.js';
import { summonedAdapterId } from '../agent.js';
import type { CommandContext, CommandDeps } from './context.js';

// Persist a message, fan it out, and — if it summons a member — record the summon and
// trigger the turn, each as its own command through the same entry (ADR-004).
//
// EVERY AGENT TURN TRACES TO A HUMAN SUMMON. The summon row is written HERE, before the
// turn is triggered, because it is the thing that makes the turn legitimate: a turn
// whose summon does not exist is an orphan, and `appendAgentEvent` will not compile
// without a reference to one.
//
// Human-rooted only in S0.5a. `summonedAdapterId` refuses agents and `system` outright,
// so anything reaching the summon below is a member-authored message — the root is the
// author, the depth is 0, and there is no chain to inherit. S0.5b adds agent-initiated
// summons, which inherit a chain and are capped.
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

  const summoned = summonedAdapterId(event);
  if (summoned) {
    // Idempotency comes free from the message: `appendMessage` is idempotent on
    // (room_id, client_msg_id), so a replayed send resolves to the ALREADY-COMMITTED
    // row and returns its original seq. A summon is therefore raised against the first
    // commit only — a duplicate frame cannot raise a second one.
    const summonId = `sum_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const summon = await appendSummon(deps.pool, input.roomId, {
      summon_id: summonId,
      member: summoned,
      requested_by: ctx.actorId,
      // Human-rooted: the author IS the root. Recorded, not derived — S1.1 is what
      // makes a member resolvable, and this log has to be checkable before then.
      root_actor: ctx.actorId,
      root_is_human: true,
      depth: 0,
      cause_seq: event.seq,
    });
    deps.bus.publish(input.roomId, summon);

    void deps
      .execute(
        { actorId: summoned, mode: 'hosted' },
        {
          kind: 'triggerAgentTurn',
          roomId: input.roomId,
          adapterId: summoned,
          summonId,
          spans: { t0, t1 },
        },
      )
      .catch(() => {}); // runAgentTurn writes its own error event; this guards the fire-and-forget
  }

  return event;
}
