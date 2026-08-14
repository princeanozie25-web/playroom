import {
  ERROR_BRIEFING_ABSENT,
  ERROR_BRIEFING_MALFORMED,
  ERROR_BRIEFING_NOT_HUMAN,
  ERROR_BRIEFING_NOT_OWNER,
  ERROR_BRIEFING_NO_ROOM_OWNER,
  ERROR_BRIEFING_TOO_LARGE,
} from '@playroom/shared';
import { getRoom } from '../events.js';
import { memberRecord } from '../members.js';
import { BRIEFING_MAX_CHARS, clearBriefing, setBriefing } from '../briefings.js';
import type { CommandContext, CommandDeps } from './context.js';

// ============================================================================
// THE ROOM BRIEFING — set, replaced, cleared (S1.7).
//
// A briefing is owner-authored framing pinned to the room. This file's whole job is to make sure only
// the room's OWNER, and only a HUMAN, can set or clear it — and that it CONFERS NO AUTHORITY.
//
// ── AN AGENT MAY NEVER SET, REPLACE OR CLEAR A BRIEFING ─────────────────────────────────────────
//
// Written here so a later "convenience" argues with it first. A briefing configures framing; letting
// an agent set one — directly, or by being talked into it through its own context — is the fabric
// routing around itself. It is the same self-authorisation reasoning that keeps an agent from signing
// a co-signature (signDecision.ts) or minting a standing order (order.ts). The check is against the
// authenticated member's KIND, never a claim in the frame, and it is checked BEFORE ownership so an
// agent that somehow owned a room is still refused by kind, not admitted by identity.
// ============================================================================

export type BriefingResult =
  { ok: true; briefingId?: string } | { ok: false; refusal: { code: string; message: string } };

const refuse = (code: string, message: string): BriefingResult => ({
  ok: false,
  refusal: { code, message },
});

/**
 * The gate every briefing mutation passes: the actor is a HUMAN, and is the room's OWNER. Returns a
 * refusal (which one, out loud) or null when the actor may proceed. `kind` is checked first so the
 * agent-never rule fires for an agent-owner too; ownership is checked against `rooms.created_by`.
 */
async function authorizeOwner(
  deps: CommandDeps,
  ctx: CommandContext,
  roomId: string,
  verb: string,
): Promise<{ code: string; message: string } | null> {
  const actor = await memberRecord(deps.pool, ctx.actorId);
  if (!actor || actor.kind !== 'human') {
    deps.log.warn(
      { room_id: roomId, member: ctx.actorId, code: ERROR_BRIEFING_NOT_HUMAN },
      `briefing ${verb} refused: only a human may set a briefing`,
    );
    return { code: ERROR_BRIEFING_NOT_HUMAN, message: 'only a human may set a room briefing' };
  }
  const room = await getRoom(deps.pool, roomId);
  if (!room || room.created_by === null) {
    deps.log.warn(
      { room_id: roomId, member: ctx.actorId, code: ERROR_BRIEFING_NO_ROOM_OWNER },
      `briefing ${verb} refused: room has no recorded owner`,
    );
    return {
      code: ERROR_BRIEFING_NO_ROOM_OWNER,
      message: 'this room has no recorded owner, so no one can set its briefing',
    };
  }
  if (room.created_by !== ctx.actorId) {
    deps.log.warn(
      {
        room_id: roomId,
        member: ctx.actorId,
        owner: room.created_by,
        code: ERROR_BRIEFING_NOT_OWNER,
      },
      `briefing ${verb} refused: not the room owner`,
    );
    return { code: ERROR_BRIEFING_NOT_OWNER, message: 'only the room owner may set its briefing' };
  }
  return null;
}

export async function setBriefingCommand(
  deps: CommandDeps,
  ctx: CommandContext,
  input: { roomId: string; clientMsgId: string; content: string; purpose: string },
): Promise<BriefingResult> {
  const denied = await authorizeOwner(deps, ctx, input.roomId, 'set');
  if (denied) return refuse(denied.code, denied.message);

  // NON-BLANK CONTENT AND PURPOSE — the S1.5 shape requires both. Trimmed, so trailing whitespace is
  // neither counted toward the cap nor stored, and a whitespace-only briefing is refused, not stored empty.
  const content = input.content.trim();
  const purpose = input.purpose.trim();
  if (content === '' || purpose === '') {
    deps.log.warn(
      { room_id: input.roomId, member: ctx.actorId, code: ERROR_BRIEFING_MALFORMED },
      'briefing set refused: blank content or purpose',
    );
    return refuse(
      ERROR_BRIEFING_MALFORMED,
      'a briefing needs both non-empty content and a non-empty purpose',
    );
  }

  // THE SIZE CAP, REFUSED AT SET TIME — never truncated at assembly. A briefing the room believes it
  // has and the model never saw is the worst available failure, so it is refused here with an honest
  // reason: the answer is to shorten it, not that anything was malformed.
  if (content.length > BRIEFING_MAX_CHARS) {
    deps.log.warn(
      {
        room_id: input.roomId,
        member: ctx.actorId,
        chars: content.length,
        cap: BRIEFING_MAX_CHARS,
        code: ERROR_BRIEFING_TOO_LARGE,
      },
      'briefing set refused: over the size cap',
    );
    return refuse(
      ERROR_BRIEFING_TOO_LARGE,
      `a briefing may be at most ${BRIEFING_MAX_CHARS} characters; this one is ${content.length}`,
    );
  }

  const { briefing, event } = await setBriefing(deps.pool, {
    roomId: input.roomId,
    content,
    purpose,
    setBy: ctx.actorId,
  });
  deps.bus.publish(input.roomId, event);
  deps.log.info(
    { room_id: input.roomId, member: ctx.actorId, briefing_id: briefing.id, chars: content.length },
    'room briefing set',
  );
  return { ok: true, briefingId: briefing.id };
}

export async function clearBriefingCommand(
  deps: CommandDeps,
  ctx: CommandContext,
  input: { roomId: string; clientMsgId: string },
): Promise<BriefingResult> {
  const denied = await authorizeOwner(deps, ctx, input.roomId, 'clear');
  if (denied) return refuse(denied.code, denied.message);

  const cleared = await clearBriefing(deps.pool, { roomId: input.roomId, clearedBy: ctx.actorId });
  if (!cleared) {
    deps.log.warn(
      { room_id: input.roomId, member: ctx.actorId, code: ERROR_BRIEFING_ABSENT },
      'briefing clear refused: nothing to clear',
    );
    return refuse(ERROR_BRIEFING_ABSENT, 'this room has no briefing to clear');
  }
  deps.bus.publish(input.roomId, cleared.event);
  deps.log.info(
    { room_id: input.roomId, member: ctx.actorId, briefing_id: cleared.briefing.id },
    'room briefing cleared',
  );
  return { ok: true, briefingId: cleared.briefing.id };
}
