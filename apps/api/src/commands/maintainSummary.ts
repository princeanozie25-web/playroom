import type { ServerEvent } from '@playroom/shared';
import { maintainRoomSummary } from '../summary.js';
import type { CommandContext, CommandDeps } from './context.js';

/**
 * Maintain the room's rolling summary — the command wrapper around `maintainRoomSummary`.
 *
 * A command so that this room mutation flows through the single entry like every other (ADR-004:
 * the trust fabric attaches at executeCommand). `postMessage` dispatches it fire-and-forget after a
 * message commits, so the summary is folded in the BACKGROUND and is ready ahead of the next
 * summon — never on the summon's first-token path (§7, ADR-008).
 *
 * The context is not read: this is a system act, not a member's, and `maintainRoomSummary` writes a
 * `room.summary` event authored by `system`. It returns the new event or null (nothing to fold, the
 * ceiling was reached, or it lost the idempotency race) — the caller ignores it, because it fired
 * and forgot.
 */
export function maintainSummaryCommand(
  deps: CommandDeps,
  _ctx: CommandContext,
  input: { roomId: string },
): Promise<ServerEvent | null> {
  return maintainRoomSummary(deps, input.roomId);
}
