import type { ServerEvent } from '@playroom/shared';
import type { RoomRow } from '../events.js';
import {
  type Command,
  type CommandContext,
  type CommandDeps,
  type TurnSpans,
  CommandError,
} from './context.js';
import { createRoomCommand } from './createRoom.js';
import { postMessageCommand } from './postMessage.js';
import { summonCommand } from './summon.js';
import { triggerAgentTurnCommand } from './triggerAgentTurn.js';
import { handoffCommand, type HandoffResult } from './handoff.js';
import { requestActionCommand, type RequestActionResult } from './requestAction.js';
import { maintainSummaryCommand } from './maintainSummary.js';

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
  command: {
    kind: 'summon';
    roomId: string;
    member: string;
    causeSeq: number;
    intent: string;
    spans?: TurnSpans;
  },
  deps: CommandDeps,
): Promise<void>;
export function executeCommand(
  ctx: CommandContext,
  command: {
    kind: 'triggerAgentTurn';
    roomId: string;
    adapterId: string;
    summonId: string;
    taskId: string;
    spans?: TurnSpans;
  },
  deps: CommandDeps,
): Promise<void>;
export function executeCommand(
  ctx: CommandContext,
  command: { kind: 'handoff'; roomId: string; taskId: string; toMember: string; action: string },
  deps: CommandDeps,
): Promise<HandoffResult>;
export function executeCommand(
  ctx: CommandContext,
  command: {
    kind: 'requestAction';
    roomId: string;
    clientMsgId: string;
    subject: string;
    action: string;
    resource: string;
  },
  deps: CommandDeps,
): Promise<RequestActionResult>;
export function executeCommand(
  ctx: CommandContext,
  command: { kind: 'maintainSummary'; roomId: string },
  deps: CommandDeps,
): Promise<ServerEvent | null>;
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
    case 'summon':
      return summonCommand(deps, ctx, command);
    case 'triggerAgentTurn':
      return triggerAgentTurnCommand(deps, ctx, command);
    case 'handoff':
      return handoffCommand(deps, ctx, command);
    case 'requestAction':
      return requestActionCommand(deps, ctx, command);
    case 'maintainSummary':
      return maintainSummaryCommand(deps, ctx, command);
  }
}
