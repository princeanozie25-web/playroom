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
// The refusal sentence. BOUNDED, because the tokens are cut from a message body of
// unbounded length: a member could paste a 10kB string beginning with `@` and the room's
// own notice would carry it. Three tokens, 32 characters each, is enough to recognise
// what was misspelled without echoing an arbitrary payload back into the log.
function unknownMemberNotice(unknown: string[]): string {
  const shown = unknown.slice(0, 3).map((t) => (t.length > 32 ? `${t.slice(0, 32)}…` : t));
  const rest = unknown.length - shown.length;
  const list = rest > 0 ? `${shown.join(', ')} (+${rest} more)` : shown.join(', ');
  return unknown.length === 1
    ? `No member of this room is called ${list}.`
    : `No members of this room are called ${list}.`;
}

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

  // REFUSE OUT LOUD. A tag that names nobody must not vanish: silent non-response is
  // RT-001's shape, and this is the surface where it is most tempting, because "no member
  // called that" feels like nothing happened. It is not nothing — the member addressed
  // someone and got no answer, and without a sentence in the room they cannot tell that
  // from an agent being slow, an adapter being down, or the summon being refused.
  //
  // `client_msg_id` is derived from the causing event's seq, so the notice inherits
  // appendMessage's idempotency: a replayed frame resolves to the SAME notice row instead
  // of appending a second one. Same class of bug the replay fix closed, avoided by
  // construction rather than by another branch.
  if (ruling.unknown.length > 0) {
    const notice = await appendMessage(
      deps.pool,
      input.roomId,
      'system',
      `sys-unknown-${event.seq}`,
      unknownMemberNotice(ruling.unknown),
    );
    deps.bus.publish(input.roomId, notice);
  }

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
