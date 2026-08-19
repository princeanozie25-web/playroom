import {
  ERROR_ADMIT_NOT_HUMAN,
  ERROR_ADMIT_NOT_OWNER,
  ERROR_ADMIT_NO_ROOM_OWNER,
  ERROR_ADMIT_NO_SUCH_MEMBER,
} from '@playroom/shared';
import { admitMember, getRoom } from '../events.js';
import { isRoomMember, memberRecord } from '../members.js';
import type { CommandContext, CommandDeps } from './context.js';

// ============================================================================
// THE ROOM DOOR — admit a member to a room (ADR-009).
//
// Creation now enrols only the creator (events.ts). This command is how everyone else gets in: the room
// OWNER, and only a human, names a member and lets them in. Who is in a room is an authority boundary —
// membership is what makes a member addressable (@tag), what the roster read returns, and what every
// room read is scoped by — so this file's whole job is to make sure only the owner widens it.
//
// ── AN AGENT MAY NEVER ADMIT ────────────────────────────────────────────────────────────────────
//
// Written here so a later "convenience" argues with it first. Letting an agent admit a member — directly,
// or by being talked into it through its own context — is the fabric routing around itself, the same
// self-authorisation reasoning that keeps an agent from setting a briefing (briefing.ts), signing a
// co-signature (signDecision.ts) or minting a standing order (order.ts). The check is against the
// authenticated member's KIND, never a claim in the request, and it is checked BEFORE ownership so an
// agent that somehow owned a room is still refused by kind, not admitted by identity.
// ============================================================================

export type AdmitResult =
  { ok: true; alreadyMember: boolean } | { ok: false; refusal: { code: string; message: string } };

const refuse = (code: string, message: string): AdmitResult => ({
  ok: false,
  refusal: { code, message },
});

export async function admitCommand(
  deps: CommandDeps,
  ctx: CommandContext,
  input: { roomId: string; member: string },
): Promise<AdmitResult> {
  // KIND FIRST, so the agent-never rule fires even for an agent that owns the room.
  const actor = await memberRecord(deps.pool, ctx.actorId);
  if (!actor || actor.kind !== 'human') {
    deps.log.warn(
      { room_id: input.roomId, member: ctx.actorId, code: ERROR_ADMIT_NOT_HUMAN },
      'admit refused: only a human may admit a member',
    );
    return refuse(ERROR_ADMIT_NOT_HUMAN, 'only a human may admit a member to a room');
  }

  // OWNERSHIP, against `rooms.created_by`. A room with a NULL owner (predates migration 026) can admit
  // nobody — fail-closed and honest, the same stance the briefing takes.
  const room = await getRoom(deps.pool, input.roomId);
  if (!room || room.created_by === null) {
    deps.log.warn(
      { room_id: input.roomId, member: ctx.actorId, code: ERROR_ADMIT_NO_ROOM_OWNER },
      'admit refused: room has no recorded owner',
    );
    return refuse(
      ERROR_ADMIT_NO_ROOM_OWNER,
      'this room has no recorded owner, so no one can admit to it',
    );
  }
  if (room.created_by !== ctx.actorId) {
    deps.log.warn(
      {
        room_id: input.roomId,
        member: ctx.actorId,
        owner: room.created_by,
        code: ERROR_ADMIT_NOT_OWNER,
      },
      'admit refused: not the room owner',
    );
    return refuse(ERROR_ADMIT_NOT_OWNER, 'only the room owner may admit a member');
  }

  // THE ADMITTEE MUST EXIST. A named refusal instead of the foreign-key violation the write would raise —
  // and it means the caller cannot use admit to probe which member ids are real by the shape of the error,
  // since a non-existent member and an existing one are both answered plainly.
  const target = await memberRecord(deps.pool, input.member);
  if (!target) {
    deps.log.warn(
      {
        room_id: input.roomId,
        member: ctx.actorId,
        target: input.member,
        code: ERROR_ADMIT_NO_SUCH_MEMBER,
      },
      'admit refused: no such member',
    );
    return refuse(ERROR_ADMIT_NO_SUCH_MEMBER, 'no member by that id exists');
  }

  // IDEMPOTENT. Re-admitting an already-present member is not an error — the door being asked to open for
  // someone already inside just tells the caller they were already in, and writes nothing.
  const already = await isRoomMember(deps.pool, input.roomId, input.member);
  if (already) {
    deps.log.info(
      { room_id: input.roomId, member: ctx.actorId, target: input.member },
      'admit no-op: member already in room',
    );
    return { ok: true, alreadyMember: true };
  }

  await admitMember(deps.pool, input.roomId, input.member);
  deps.log.info(
    { room_id: input.roomId, member: ctx.actorId, target: input.member },
    'member admitted to room',
  );
  return { ok: true, alreadyMember: false };
}
