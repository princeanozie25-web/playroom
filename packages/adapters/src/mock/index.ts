import type {
  AgentAdapter,
  AgentMessage,
  AgentStreamOptions,
  AgentTurnChunk,
} from '@playroom/shared';

// ═══ THE DETERMINISTIC ADAPTER — a room runs a model offline, no SDK, no key (ADR-022) ════════════════
//
// The real adapters (anthropic, openai) each translate a live provider stream and need that provider's
// credential to run. This one implements the SAME provider-neutral AgentAdapter with a SCRIPTED stream and no
// SDK — the offline analogue, the way a multi-model governed room is exercised in CI, in the demo, and in any
// deployment without keys. It is what lets "ChatGPT and Claude work alongside each other in a room" be shown
// end-to-end without spending a token, exactly as the Mock backends do for reads and writes.

/** What the mock "model" emits this turn. All optional — an empty script yields a short acknowledgement. */
export interface MockScript {
  /** Text the model streams (as word-by-word deltas, so a caller sees real streaming). */
  text?: string;
  /** Structured actions the model asks to take (e.g. a summon) — surfaced as `action` chunks (S1.8). */
  actions?: Array<{ action: string; arguments: Record<string, unknown>; call_id?: string }>;
  tokensIn?: number;
  tokensOut?: number;
  stopReason?: string;
  /** Make the turn fail: emit a single `error` terminal chunk instead of `done`. */
  error?: { error_class: string; message: string };
}

export class MockAdapter implements AgentAdapter {
  readonly id: string;
  private readonly script: MockScript;

  constructor(id: string, script: MockScript = {}) {
    this.id = id;
    this.script = script;
  }

  async *stream(
    messages: AgentMessage[],
    _opts?: AgentStreamOptions,
  ): AsyncIterable<AgentTurnChunk> {
    if (this.script.error) {
      yield {
        kind: 'error',
        error_class: this.script.error.error_class,
        message: this.script.error.message,
      };
      return;
    }
    const text =
      this.script.text ?? `(${this.id}) read ${messages.length} message(s) and has nothing to add`;
    // Stream word by word so a consumer exercises the same delta loop the real adapters drive.
    const words = text.length ? text.split(' ') : [];
    for (let i = 0; i < words.length; i += 1) {
      yield { kind: 'text_delta', text: i === words.length - 1 ? words[i] : `${words[i]} ` };
    }
    for (const a of this.script.actions ?? []) {
      yield { kind: 'action', action: a.action, arguments: a.arguments, call_id: a.call_id };
    }
    yield {
      kind: 'done',
      tokens_in: this.script.tokensIn ?? Math.max(1, messages.length * 4),
      tokens_out: this.script.tokensOut ?? Math.max(1, words.length),
      stop_reason: this.script.stopReason ?? 'end_turn',
    };
  }
}

/**
 * An adapterFactory backed by mock adapters — the drop-in for `createAdapter` that a governed room uses to run
 * multiple members (a Claude one, a ChatGPT one) offline. Pass a script per member id; an unscripted id gets a
 * plain acknowledgement. This is exactly what the server/tests inject as `adapterFactory` to drive a whole
 * multi-model room deterministically.
 */
export function mockAdapterFactory(
  scripts: Record<string, MockScript> = {},
): (id: string) => AgentAdapter {
  return (id: string) => new MockAdapter(id, scripts[id] ?? {});
}
