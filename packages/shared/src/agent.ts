// §6 anti-lock-in seam: the provider-neutral agent contract. No provider name
// appears in this file, ever. Adapters translate a provider's stream into these
// chunks; the room and the rest of the API only ever see these shapes.

// One message in the context handed to an adapter. `author` is a free-text
// display name — there is no identity model yet (S1.1).
export type AgentMessage = { author: string; body: string };

// A streamed unit of an agent turn: many text deltas, then exactly one terminal
// chunk (`done` on success, `error` on failure).
export type AgentTurnChunk =
  | { kind: 'text_delta'; text: string }
  | { kind: 'done'; tokens_in: number; tokens_out: number; stop_reason: string }
  | { kind: 'error'; error_class: string; message: string };

export interface AgentStreamOptions {
  systemPrompt?: string;
  maxOutputTokens?: number;
}

// Every adapter implements this. `id` is the adapters.yaml id (a member id),
// never a provider name. `stream` yields chunks as they arrive from the provider.
export interface AgentAdapter {
  readonly id: string;
  stream(messages: AgentMessage[], opts?: AgentStreamOptions): AsyncIterable<AgentTurnChunk>;
}
