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

  /**
   * Pay this adapter's one-time connection cost NOW, off the critical path.
   *
   * The first turn after a process starts carries a TLS handshake and client
   * initialisation that no later turn pays (S04-N1, ~+1 to +1.5s). It lands on exactly
   * the request a pilot makes first thing in the morning, and it is measured as a
   * separate number rather than averaged into the warm distribution — see ADR-008.
   *
   * MUST NOT consume tokens, and must not be describable as a turn: nothing it does may
   * reach the room, the event log, or a spend line. It is a connection, not a message.
   * An adapter that cannot warm without spending should leave this unimplemented rather
   * than bill a principal for a handshake.
   *
   * OPTIONAL, deliberately. A warm-up is an optimisation and not an invariant, and a
   * required method here would make every stub and every future adapter implement a
   * no-op to satisfy a contract that guarantees nothing. Callers use `adapter.warm?.()`
   * and treat absence as "no warming available", never as an error.
   *
   * Idempotent and safe to call repeatedly — the capture harness calls it immediately
   * before recording, on a process that already warmed at boot.
   */
  warm?(): Promise<void>;
}
