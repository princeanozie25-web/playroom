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
  choices?: Array<{
    delta?: {
      content?: string | null;
      // Tool calls stream incrementally: the id and function name arrive once, the arguments
      // accumulate as JSON fragments across deltas, keyed by `index` (S1.8).
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
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

    // Tools the model may call this turn, translated to this provider's function-calling shape
    // (S1.8). Omitted when none are offered, so a text-only turn's request is unchanged.
    const tools = opts?.tools?.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    const stream = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: opts?.maxOutputTokens ?? 1024,
      stream: true,
      // Ask for usage on the final chunk. Without this the provider streams no token
      // counts at all, cost_usd would be null, and the in-thread spend line — the §18
      // "spend is visible" claim the demo shows — would be empty for this member only.
      stream_options: { include_usage: true },
      ...(tools && tools.length ? { tools } : {}),
      messages: [
        ...(opts?.systemPrompt ? [{ role: 'system', content: opts.systemPrompt }] : []),
        { role: 'user', content: transcript || '(no messages)' },
      ],
    } as never);

    let tokensIn = 0;
    let tokensOut = 0;
    let stopReason = 'stop';
    // Tool calls accumulate across deltas, keyed by `index` — the id and name arrive once, the
    // arguments come as JSON fragments (S1.8). Assembled here, surfaced as `action` chunks after the
    // stream so `done` stays the single terminal chunk.
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();

    for await (const part of stream) {
      const choice = part.choices?.[0];
      const text = choice?.delta?.content;
      if (text) yield { kind: 'text_delta', text };
      for (const tc of choice?.delta?.tool_calls ?? []) {
        const entry = toolCalls.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name = tc.function.name;
        if (tc.function?.arguments) entry.args += tc.function.arguments;
        toolCalls.set(tc.index, entry);
      }
      if (choice?.finish_reason) stopReason = choice.finish_reason;
      // Usage arrives on a final chunk that carries no choices.
      if (part.usage) {
        tokensIn = part.usage.prompt_tokens ?? 0;
        tokensOut = part.usage.completion_tokens ?? 0;
      }
    }

    // STRUCTURED ACTIONS the model emitted. A malformed arguments fragment parses to `{}` rather than
    // throwing — a bad tool call becomes an action the fabric refuses on its arguments, not a crashed
    // turn. The gateway attributes and governs it (S1.8).
    for (const tc of toolCalls.values()) {
      let args: Record<string, unknown> = {};
      try {
        args = tc.args ? (JSON.parse(tc.args) as Record<string, unknown>) : {};
      } catch {
        args = {};
      }
      yield { kind: 'action', action: tc.name, arguments: args, call_id: tc.id };
    }

    yield { kind: 'done', tokens_in: tokensIn, tokens_out: tokensOut, stop_reason: stopReason };
  }
}
