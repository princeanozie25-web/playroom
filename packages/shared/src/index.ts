export const PLAYROOM_VERSION = '0.0.1';

// The room WebSocket wire contract (zod schemas + inferred types).
export * from './protocol.js';

// The §6 provider-neutral agent contract (streamed turn chunks + adapter shape).
export * from './agent.js';
