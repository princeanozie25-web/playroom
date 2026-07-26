import OpenAI from 'openai';
import type {
  AgentAdapter,
  AgentMessage,
  AgentStreamOptions,
  AgentTurnChunk,
} from '@playroom/shared';
import type { AdapterConfig } from '../registry.js';

// The second provider, behind the same interface. This file and the Anthropic adapter are
// the only places their respective SDKs are imported (§6); nothing outside this package
// sees either SDK or either provider's name.
//
// It satisfies AgentAdapter without the interface changing, which is the S0.4 exit
// criterion made structural. It passes the conformance suite written in S04-1 — before
// this file existed — unchanged.

// A missing key is a clean, typed error, named so runAgentTurn records a useful
// error_class rather than "Error". Same contract as the first adapter, different variable.
export class MissingOpenAIKeyError extends Error {
  constructor(adapterId: string) {
    super(`OPENAI_API_KEY is not set (adapter "${adapterId}")`);
    this.name = 'MissingOpenAIKeyError';
  }
}

// The slice of the provider client this adapter uses. Narrowing to it is what lets the
// conformance suite inject a stub without `any` — see transport.ts for why the boundary
// is the client rather than HTTP.
type ProviderStream = AsyncIterable<{
  choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}>;
type ProviderClient = {
  chat: { completions: { create: (params: never) => Promise<ProviderStream> } };
  // The token-free endpoint `warm()` uses. Optional for the same reason as the other
  // adapter: the conformance stub exercises the translation loop, not the handshake.
  models?: { list: () => Promise<unknown> };
};

export class OpenAIAdapter implements AgentAdapter {
  readonly id: string;
  private readonly model: string;
  private readonly client: ProviderClient;

  // `stub` is supplied ONLY by the conformance suite. Production passes nothing;
  // createAdapter has no parameter for it.
  constructor(cfg: AdapterConfig, stub?: ProviderClient) {
    if (!process.env.OPENAI_API_KEY) throw new MissingOpenAIKeyError(cfg.id);
    this.client = stub ?? (new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) as ProviderClient);
    this.id = cfg.id;
    this.model = cfg.model;
  }

  /**
   * Same mechanism as the other adapter, for the same reason: a model-catalogue read on
   * the client this adapter's turns use, no completion, no tokens. Both providers expose
   * one, which is why the interface can carry `warm()` without either adapter needing a
   * special case — and if a future provider does not, it leaves the method off.
   */
  async warm(): Promise<void> {
    await this.client.models?.list();
  }

  async *stream(
    messages: AgentMessage[],
    opts?: AgentStreamOptions,
  ): AsyncIterable<AgentTurnChunk> {
    // Same flattening as the other adapter: one transcript, the shared system prompt.
    // Keeping the two adapters' context handling identical is what makes "same prompt
    // routes through either member" a real claim rather than a coincidence.
    const transcript = messages.map((m) => `${m.author}: ${m.body}`).join('\n');

    const stream = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: opts?.maxOutputTokens ?? 1024,
      stream: true,
      // Ask for usage on the final chunk. Without this the provider streams no token
      // counts at all, cost_usd would be null, and the in-thread spend line — the §18
      // "spend is visible" claim the demo shows — would be empty for this member only.
      stream_options: { include_usage: true },
      messages: [
        ...(opts?.systemPrompt ? [{ role: 'system', content: opts.systemPrompt }] : []),
        { role: 'user', content: transcript || '(no messages)' },
      ],
    } as never);

    let tokensIn = 0;
    let tokensOut = 0;
    let stopReason = 'stop';

    for await (const part of stream) {
      const choice = part.choices?.[0];
      const text = choice?.delta?.content;
      if (text) yield { kind: 'text_delta', text };
      if (choice?.finish_reason) stopReason = choice.finish_reason;
      // Usage arrives on a final chunk that carries no choices.
      if (part.usage) {
        tokensIn = part.usage.prompt_tokens ?? 0;
        tokensOut = part.usage.completion_tokens ?? 0;
      }
    }

    yield { kind: 'done', tokens_in: tokensIn, tokens_out: tokensOut, stop_reason: stopReason };
  }
}
