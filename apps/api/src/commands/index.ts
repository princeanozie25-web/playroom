import type { ServerEvent } from '@playroom/shared';
import type { RoomRow } from '../events.js';
import {
  type Command,
  type CommandContext,
  type CommandDeps,
  type SummonChain,
  type TurnSpans,
  CommandError,
} from './context.js';
import { createRoomCommand } from './createRoom.js';
import { postMessageCommand } from './postMessage.js';
import { summonCommand } from './summon.js';
import { triggerAgentTurnCommand } from './triggerAgentTurn.js';
import { handoffCommand, type HandoffResult } from './handoff.js';
import { requestActionCommand, type RequestActionResult } from './requestAction.js';
import { raiseHandCommand, type RaiseHandResult } from './raiseHand.js';
import { signDecisionCommand, type SignDecisionResult } from './signDecision.js';
import {
  createOrderCommand,
  controlOrderCommand,
  updateOrderCommand,
  type OrderResult,
} from './order.js';
import { setBriefingCommand, clearBriefingCommand, type BriefingResult } from './briefing.js';
import { admitCommand, type AdmitResult } from './admit.js';
import { removeDocumentCommand, uploadDocumentCommand, type DocumentResult } from './document.js';
import { orderCycleStartedCommand, runOrdersCommand } from './runOrders.js';
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
    chain?: SummonChain;
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
    chain?: SummonChain;
    orderTriggerSeq?: number;
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
  command: {
    kind: 'raiseHand';
    roomId: string;
    clientMsgId: string;
    urgency: 'BLOCKER' | 'FYI';
    reason: string;
  },
  deps: CommandDeps,
): Promise<RaiseHandResult>;
export function executeCommand(
  ctx: CommandContext,
  command: {
    kind: 'signDecision';
    roomId: string;
    clientMsgId: string;
    decisionId: string;
    resolution: 'APPROVED' | 'DENIED';
  },
  deps: CommandDeps,
): Promise<SignDecisionResult>;
export function executeCommand(
  ctx: CommandContext,
  command: {
    kind: 'createOrder';
    roomId: string;
    clientMsgId: string;
    triggerEventType: string;
    triggerMember: string;
    actionMember: string;
    maxCycles: number | null;
    maxUnattendedCycles: number;
    expiresAt: string | null;
    /** What the order is for (S-TASK). Optional here so a caller that omits it reaches the named
     *  refusal (`order_task_absent`) instead of failing to compile at a boundary the wire crosses. */
    task?: string;
  },
  deps: CommandDeps,
): Promise<OrderResult>;
export function executeCommand(
  ctx: CommandContext,
  command: {
    kind: 'controlOrder';
    roomId: string;
    clientMsgId: string;
    orderId: string;
    op: 'pause' | 'resume' | 'revoke';
  },
  deps: CommandDeps,
): Promise<OrderResult>;
export function executeCommand(
  ctx: CommandContext,
  command: {
    kind: 'updateOrder';
    roomId: string;
    clientMsgId: string;
    orderId: string;
    maxCycles: number | null;
    maxUnattendedCycles: number;
    expiresAt: string | null;
  },
  deps: CommandDeps,
): Promise<OrderResult>;
export function executeCommand(
  ctx: CommandContext,
  command: {
    kind: 'setBriefing';
    roomId: string;
    clientMsgId: string;
    content: string;
    purpose: string;
  },
  deps: CommandDeps,
): Promise<BriefingResult>;
export function executeCommand(
  ctx: CommandContext,
  command: { kind: 'clearBriefing'; roomId: string; clientMsgId: string },
  deps: CommandDeps,
): Promise<BriefingResult>;
export function executeCommand(
  ctx: CommandContext,
  command: { kind: 'admit'; roomId: string; member: string },
  deps: CommandDeps,
): Promise<AdmitResult>;
export function executeCommand(
  ctx: CommandContext,
  command: {
    kind: 'uploadDocument';
    roomId: string;
    clientMsgId: string;
    title: string;
    purpose: string;
    provenance: string;
    declaredType: string;
    content: string;
  },
  deps: CommandDeps,
): Promise<DocumentResult>;
export function executeCommand(
  ctx: CommandContext,
  command: { kind: 'removeDocument'; roomId: string; clientMsgId: string; documentId: string },
  deps: CommandDeps,
): Promise<DocumentResult>;
export function executeCommand(
  ctx: CommandContext,
  command: {
    kind: 'runOrders';
    roomId: string;
    member: string;
    completedSeq: number;
    success: boolean;
    orderId?: string;
    errorClass?: string | null;
  },
  deps: CommandDeps,
): Promise<void>;
export function executeCommand(
  ctx: CommandContext,
  command: { kind: 'orderCycleStarted'; roomId: string; orderId: string; triggerSeq: number },
  deps: CommandDeps,
): Promise<void>;
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
    case 'raiseHand':
      return raiseHandCommand(deps, ctx, command);
    case 'signDecision':
      return signDecisionCommand(deps, ctx, command);
    case 'createOrder':
      return createOrderCommand(deps, ctx, command);
    case 'updateOrder':
      return updateOrderCommand(deps, ctx, command);
    case 'controlOrder':
      return controlOrderCommand(deps, ctx, command);
    case 'uploadDocument':
      return uploadDocumentCommand(deps, ctx, command);
    case 'removeDocument':
      return removeDocumentCommand(deps, ctx, command);
    case 'setBriefing':
      return setBriefingCommand(deps, ctx, command);
    case 'clearBriefing':
      return clearBriefingCommand(deps, ctx, command);
    case 'admit':
      return admitCommand(deps, ctx, command);
    case 'runOrders':
      return runOrdersCommand(deps, ctx, command);
    case 'orderCycleStarted':
      return orderCycleStartedCommand(deps, ctx, command);
    case 'maintainSummary':
      return maintainSummaryCommand(deps, ctx, command);
  }
}
