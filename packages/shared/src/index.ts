export const PLAYROOM_VERSION = '0.0.1';

// §6 anti-lock-in seam: a provider-agnostic turn shape. No provider names here.
export type AgentTurn = { kind: 'text' | 'tool_call' | 'task_action'; payload: unknown };
