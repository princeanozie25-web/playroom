import { performance } from 'node:perf_hooks';
import type { ServerEvent } from '@playroom/shared';
import { appendMessage } from '../events.js';
import { summonRuling } from '../agent.js';
import { loadRoomTokens } from '../members.js';
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
function bounded(tokens: string[]): string {
  const shown = tokens.slice(0, 3).map((t) => (t.length > 32 ? `${t.slice(0, 32)}…` : t));
  const rest = tokens.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} (+${rest} more)` : shown.join(', ');
}

/**
 * The room's refusal, or null if it owes none.
 *
 * TWO REFUSALS, TWO SENTENCES, because they are different mistakes with different fixes. A
 * misspelling is corrected by typing again; naming a real member who was never enrolled here
 * is corrected by adding them to the room. Collapsing both into "no member is called that"
 * would send someone hunting for a typo that is not there — fail-closed must distinguish
 * REFUSED from MISCONFIGURED, and this is the mild version of that rule.
 *
 * Both lists are BOUNDED: the tokens are cut from a message body of unbounded length, and the
 * room's own notice must not carry an arbitrary payload back into the log.
 */
function refusalSentence(unknown: string[], elsewhere: string[]): string | null {
  const parts: string[] = [];
  if (elsewhere.length > 0) {
    parts.push(
      elsewhere.length === 1
        ? `${bounded(elsewhere)} is not in this room.`
        : `${bounded(elsewhere)} are not in this room.`,
    );
  }
  if (unknown.length > 0) {
    parts.push(
      unknown.length === 1
        ? `No member of this room is called ${bounded(unknown)}.`
        : `No members of this room are called ${bounded(unknown)}.`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : null;
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

  // THE ROOM'S OWN TOKENS, resolved now rather than at boot. Membership is data as of
  // S1.1b, so a process-wide snapshot would answer yesterday's question (S11a-N2). One
  // indexed read per send, against a path whose measured cost is provider latency.
  await loadRoomTokens(deps.pool, input.roomId);
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
  const sentence = refusalSentence(ruling.unknown, ruling.elsewhere);
  if (sentence) {
    const notice = await appendMessage(
      deps.pool,
      input.roomId,
      'system',
      `sys-unknown-${event.seq}`,
      sentence,
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
      // THE SENTENCE THAT ASKED, carried so the task it creates can say what it is for.
      // Read from the committed event rather than from `input`, so what the task records is
      // what the room actually stored — a replayed frame resolves to the existing row, and
      // its body is the one already in the log.
      intent: event.event_type === 'message' ? event.payload.body : input.body,
      spans: { t0, t1 },
    });
  }

  // MAINTAIN THE ROLLING SUMMARY, AHEAD OF THE NEXT SUMMON (S1.6). This message just grew the room;
  // folding its older messages into the summary is a background model call, and it must sit on
  // neither this send's path nor the next summon's first token (§7, ADR-008). Fire-and-forget, with
  // its OWN `system` context — the room maintaining itself, not an act attributed to the sender.
  // Cheap and idempotent when the tail is still short, which is every message in a young room.
  void deps
    .execute(
      { actorId: 'system', mode: 'system' },
      { kind: 'maintainSummary', roomId: input.roomId },
    )
    .catch(() => {
      /* maintainRoomSummary logs its own failure; this only guards the fire-and-forget */
    });

  return event;
}
