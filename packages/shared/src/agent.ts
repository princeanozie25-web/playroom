// §6 anti-lock-in seam: the provider-neutral agent contract. No provider name
// appears in this file, ever. Adapters translate a provider's stream into these
// chunks; the room and the rest of the API only ever see these shapes.

// One message in the context handed to an adapter. `author` is a free-text
// display name — there is no identity model yet (S1.1).
export type AgentMessage = { author: string; body: string };

// A streamed unit of an agent turn: many text deltas and any structured actions the model
// emitted, then exactly one terminal chunk (`done` on success, `error` on failure).
export type AgentTurnChunk =
  | { kind: 'text_delta'; text: string }
  /**
   * A STRUCTURED ACTION the model asked to take — Bible §3.2, S1.8.
   *
   * Distinct from text: an agent can now request an action as a typed object rather than prose. This
   * slice's only consumer is a summon (`action: 'summon'`); `pr.merge` emission is S2.1's. The shape
   * is GENERAL on purpose — `action` + `arguments` carry a summon today and a `pr.merge` later
   * without a second variant.
   *
   * THE CHANNEL DOES NOT BYPASS THE FABRIC BECAUSE IT IS STRUCTURED. An action emitted here is
   * attributed to the emitting agent (the adapter running the turn — the gateway knows which), and
   * it is evaluated against THAT agent's mandate. A structured emission is subject to every control a
   * free-text activation is, and one more: it is only as authorised as the agent that emitted it. The
   * carrier being typed makes it easier to route, never exempt from evaluation.
   */
  | { kind: 'action'; action: string; arguments: Record<string, unknown>; call_id?: string }
  | { kind: 'done'; tokens_in: number; tokens_out: number; stop_reason: string }
  | { kind: 'error'; error_class: string; message: string };

/**
 * A tool the model may call — provider-neutral (S1.8). Adapters translate it into their own
 * tool/function-calling wire format; the model's use of it arrives back as an `action` chunk.
 *
 * OFFERED, NEVER FORCED. Passing a tool lets the model emit the action; it does not make it. And a
 * tool is offered to a member's turn only when that member's mandate authorises the action — an agent
 * whose mandate does not grant a summon is not handed the summon tool, so the injection cannot even
 * form. The summon constructor re-checks the mandate regardless: offering is the near guard, the
 * evaluation at the choke point is the load-bearing one.
 */
export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments the model must supply when it calls the tool. */
  parameters: Record<string, unknown>;
}

export interface AgentStreamOptions {
  systemPrompt?: string;
  maxOutputTokens?: number;
  /** Tools the model may call this turn. Absent or empty = a text-only turn (the default). */
  tools?: AgentTool[];
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
