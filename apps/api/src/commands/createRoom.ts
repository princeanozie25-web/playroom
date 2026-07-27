import { createRoom, type RoomRow } from '../events.js';
import type { CommandContext, CommandDeps } from './context.js';

function slugify(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || genId();
}

function genId(): string {
  return `room-${crypto.randomUUID().slice(0, 8)}`;
}

// THE CREATOR IS THE AUTHENTICATED MEMBER (S1.3c). `ctx.actorId` was `anonymous` until this
// slice, because `POST /rooms` took no credential — RT-002, accepted "until S1.1" and then
// carried five slices past it. It is a real member now, and it is enrolled in the room in the
// same transaction that creates it: a room with no members cannot be opened by anyone, including
// the person who just made it.
//
// Rooms still have no `created_by` COLUMN. The creator is recorded by their membership row rather
// than by an attribute, which is enough for the reachability property this slice needs and is not
// enough for "who owns this room" — that question arrives with invites and has nowhere to live
// until it does.
export function createRoomCommand(
  deps: CommandDeps,
  ctx: CommandContext,
  input: { id?: string; title?: string },
): Promise<RoomRow> {
  const title = input.title && input.title.trim() ? input.title.trim() : 'Untitled room';
  const id = input.id && input.id.trim() ? slugify(input.id) : genId();
  return createRoom(deps.pool, id, title, ctx.actorId);
}
