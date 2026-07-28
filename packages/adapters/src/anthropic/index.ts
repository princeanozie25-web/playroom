import Anthropic from '@anthropic-ai/sdk';
import type {
  AgentAdapter,
  AgentMessage,
  AgentStreamOptions,
  AgentTurnChunk,
} from '@playroom/shared';
import type { AdapterConfig } from '../registry.js';

// The slice of the provider client this adapter actually uses. Narrowing to it is what
// lets the conformance suite pass a stub without `any`: the adapter depends on the shape
// it calls, not on the whole SDK surface.
type ProviderStream = ReturnType<Anthropic['messages']['stream']>;
type ProviderClient = {
  messages: { stream: (params: never) => ProviderStream };
  // The token-free endpoint `warm()` uses. Optional on the narrowed type so the
  // conformance suite's stub — which exists to exercise the translation loop — does not
  // have to fake a model catalogue to satisfy a connection warm-up.
  models?: { list: () => Promise<unknown> };
};

// A missing key is a clean, typed error — never a crash (§20). The orchestrator
// turns this into an in-thread notice like any other adapter failure.
export class MissingApiKeyError extends Error {
  constructor(adapterId: string) {
    super(`ANTHROPIC_API_KEY is not set (adapter "${adapterId}")`);
    this.name = 'MissingApiKeyError';
  }
}

// The ONLY file that imports the provider SDK (§6). It translates the provider's
// stream into provider-neutral AgentTurnChunks; nothing outside this package sees
// the SDK or the provider name.
export class AnthropicAdapter implements AgentAdapter {
  readonly id: string;
  private readonly model: string;
  private readonly client: ProviderClient;

  // `stub` is supplied ONLY by the conformance suite, which needs this adapter's real
  // translation loop to run without a network call, a key or spend. See transport.ts for
  // why the boundary is the client rather than HTTP. Production passes nothing.
  constructor(cfg: AdapterConfig, stub?: ProviderClient) {
    if (!stub) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new MissingApiKeyError(cfg.id);
      this.client = new Anthropic({ apiKey });
    } else {
      // The key check still runs for the real path; a stubbed adapter is already past it.
      if (!process.env.ANTHROPIC_API_KEY) throw new MissingApiKeyError(cfg.id);
      this.client = stub;
    }
    this.id = cfg.id;
    this.model = cfg.model;
  }

  /**
   * Establish the connection this adapter's first turn would otherwise pay for.
   *
   * A model-catalogue read: a real authenticated request over the SAME client the turn
   * will use — so the TLS handshake, the HTTP/2 connection and the SDK's lazy internals
   * are all done — and NO completion, so no tokens are spent and nothing is billed. It
   * cannot be mistaken for a turn: it produces no text, no usage, and no event.
   *
   * The same client instance is the point. Warming a second client and assuming the
   * process shares one connection pool would be exactly the kind of assumption that
   * produced a five-sample P95.
   *
   * Errors are the CALLER's to swallow. A failed warm-up must never be fatal — a cold
   * first turn is slow, a crashed boot is down — but it must not be hidden here either,
   * or a permanently broken warm-up would look like a working one.
   */
  async warm(): Promise<void> {
    await this.client.models?.list();
  }

  async *stream(
    messages: AgentMessage[],
    opts?: AgentStreamOptions,
  ): AsyncIterable<AgentTurnChunk> {
    // Flatten the room context into one transcript; the system prompt sets the
    // agent's behaviour. No principal or role model yet (S1.x).
    const transcript = messages.map((m) => `${m.author}: ${m.body}`).join('\n');

    // Tools the model may call this turn, translated to this provider's shape (S1.8). Omitted
    // entirely when none are offered, so a text-only turn's request is byte-for-byte what it was.
    const tools = opts?.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: opts?.maxOutputTokens ?? 1024,
      ...(opts?.systemPrompt ? { system: opts.systemPrompt } : {}),
      ...(tools && tools.length ? { tools } : {}),
      messages: [{ role: 'user', content: transcript || '(no messages)' }],
    } as never);

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { kind: 'text_delta', text: event.delta.text };
      }
    }

    const final = await stream.finalMessage();

    // STRUCTURED ACTIONS the model emitted — `tool_use` blocks in the completed message (S1.8).
    // Surfaced as provider-neutral `action` chunks; the gateway attributes them to this member and
    // hands them to the fabric, which decides whether they are allowed. Read from the FINAL message
    // rather than reassembled from `input_json_delta` events on purpose: the SDK has already parsed
    // the arguments, and a second partial-JSON parser is a second thing to keep correct. Yielded
    // before `done`, so `done` remains the single terminal chunk and stays last.
    for (const block of final.content ?? []) {
      if (block?.type === 'tool_use') {
        yield {
          kind: 'action',
          action: block.name,
          arguments: (block.input ?? {}) as Record<string, unknown>,
          call_id: block.id,
        };
      }
    }

    yield {
      kind: 'done',
      tokens_in: final.usage.input_tokens,
      tokens_out: final.usage.output_tokens,
      stop_reason: final.stop_reason ?? 'end_turn',
    };
  }
}
