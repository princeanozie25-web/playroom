import Anthropic from '@anthropic-ai/sdk';
import type {
  AgentAdapter,
  AgentMessage,
  AgentStreamOptions,
  AgentTurnChunk,
} from '@playroom/shared';
import type { AdapterConfig } from '../registry.js';

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
  private readonly client: Anthropic;

  constructor(cfg: AdapterConfig) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new MissingApiKeyError(cfg.id);
    this.id = cfg.id;
    this.model = cfg.model;
    this.client = new Anthropic({ apiKey });
  }

  async *stream(
    messages: AgentMessage[],
    opts?: AgentStreamOptions,
  ): AsyncIterable<AgentTurnChunk> {
    // Flatten the room context into one transcript; the system prompt sets the
    // agent's behaviour. No principal or role model yet (S1.x).
    const transcript = messages.map((m) => `${m.author}: ${m.body}`).join('\n');

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: opts?.maxOutputTokens ?? 1024,
      ...(opts?.systemPrompt ? { system: opts.systemPrompt } : {}),
      messages: [{ role: 'user', content: transcript || '(no messages)' }],
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { kind: 'text_delta', text: event.delta.text };
      }
    }

    const final = await stream.finalMessage();
    yield {
      kind: 'done',
      tokens_in: final.usage.input_tokens,
      tokens_out: final.usage.output_tokens,
      stop_reason: final.stop_reason ?? 'end_turn',
    };
  }
}
