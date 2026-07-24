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

// Rooms have no creator column yet; ctx.actorId is validated at the entry and will
// be fabric-stamped in S2.1. Behaviour is identical to the pre-refactor route.
export function createRoomCommand(
  deps: CommandDeps,
  _ctx: CommandContext,
  input: { id?: string; title?: string },
): Promise<RoomRow> {
  const title = input.title && input.title.trim() ? input.title.trim() : 'Untitled room';
  const id = input.id && input.id.trim() ? slugify(input.id) : genId();
  return createRoom(deps.pool, id, title);
}
