// @playroom/hosts — the MCP host seam (Bible §13; forward-roadmap B1).
//
// "Make the infrastructure disappear": this package exposes a room as MCP tools so a Claude
// subscription can drive it. It is an ADAPTER OVER COMMANDS with zero business logic of its own —
// every tool calls a RoomMcpPort method, and apps/api implements that port by authenticating a
// credential and dispatching through executeCommand (the same trust fabric every other surface uses).
//
// A package never imports an app: the command layer is injected as a port, not reached for.
export { buildRoomMcpServer } from './server.js';
export {
  RoomMcpError,
  type RoomMcpPort,
  type RoomSummary,
  type RoomView,
  type RoomEvent,
  type PendingTag,
  type ActionVerdict,
  type PostMessageResult,
  type RespondResult,
  type RaiseHandView,
} from './port.js';
