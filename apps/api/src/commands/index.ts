import type { ServerEvent } from '@playroom/shared';
import type { RoomRow } from '../events.js';
import { type Command, type CommandContext, type CommandDeps, CommandError } from './context.js';
import { createRoomCommand } from './createRoom.js';
import { postMessageCommand } from './postMessage.js';
import { triggerAgentTurnCommand } from './triggerAgentTurn.js';

export * from './context.js';

// ============================================================================
// TRUST FABRIC ATTACHES HERE (S2.1). Every room mutation — from every membership
// mode (ADR-004) — flows through executeCommand. Any code that mutates rooms or
// events without passing through here is a defect, not a style issue.
// ============================================================================
export function executeCommand(
  ctx: CommandContext,
  command: { kind: 'createRoom'; id?: string; title?: string },
  deps: CommandDeps,
): Promise<RoomRow>;
export function executeCommand(
  ctx: CommandContext,
  command: { kind: 'postMessage'; roomId: string; clientMsgId: string; body: string },
  deps: CommandDeps,
): Promise<ServerEvent>;
export function executeCommand(
  ctx: CommandContext,
  command: { kind: 'triggerAgentTurn'; roomId: string; adapterId: string },
  deps: CommandDeps,
): Promise<void>;
export function executeCommand(
  ctx: CommandContext,
  command: Command,
  deps: CommandDeps,
): Promise<unknown>;
export function executeCommand(
  ctx: CommandContext,
  command: Command,
  deps: CommandDeps,
): Promise<unknown> {
  // Rejected before any Postgres access: an unidentified actor mutates nothing.
  if (!ctx.actorId || !ctx.actorId.trim()) {
    return Promise.reject(new CommandError('actorId is required'));
  }
  switch (command.kind) {
    case 'createRoom':
      return createRoomCommand(deps, ctx, command);
    case 'postMessage':
      return postMessageCommand(deps, ctx, command);
    case 'triggerAgentTurn':
      return triggerAgentTurnCommand(deps, ctx, command);
  }
}
