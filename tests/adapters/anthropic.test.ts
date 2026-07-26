import { AnthropicAdapter, MissingApiKeyError, type AdapterConfig } from '@playroom/adapters';
import { runAdapterConformance, type ConformanceCase } from './conformance.js';

// Fixtures for the first adapter. The shared assertions live in conformance.ts; this file
// supplies only this provider's event shapes — which is the split that lets a second
// implementation reuse the suite unchanged.

const TEXT_PARTS = ['Playroom ', 'is a governed ', 'room.'];
const TOKENS_IN = 42;
const TOKENS_OUT = 7;
const STOP = 'end_turn';

const CFG: AdapterConfig = {
  id: 'conformance-member',
  provider: 'anthropic',
  model: 'test-model',
  enabled: true,
  max_output_tokens: 256,
  cost_per_1k_in: 0.001,
  cost_per_1k_out: 0.005,
};

// This provider's streamed events, in its own shape. The adapter's translation loop
// consumes exactly these, so the loop under test is the real one.
function providerEvents(): unknown[] {
  return [
    { type: 'message_start' },
    { type: 'content_block_start', index: 0 },
    ...TEXT_PARTS.map((text) => ({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ];
}

// A provider HTTP failure, as the SDK surfaces one: a named class carrying a status.
class StubApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`provider responded ${status}`);
    this.name = 'APIError';
    this.status = status;
  }
}

/** A stubbed provider client: async-iterable events plus a final message. */
function stubClient(opts: { failWith?: Error } = {}) {
  const events = providerEvents();
  const makeStream = () => ({
    async *[Symbol.asyncIterator]() {
      if (opts.failWith) throw opts.failWith;
      for (const e of events) yield e;
    },
    async finalMessage() {
      if (opts.failWith) throw opts.failWith;
      return { usage: { input_tokens: TOKENS_IN, output_tokens: TOKENS_OUT }, stop_reason: STOP };
    },
  });
  return { messages: { stream: () => makeStream() } };
}

// The stub still needs a key present, because the real constructor path checks for one and
// the suite asserts that check separately. It is never sent anywhere.
function withKey<T>(fn: () => T): T {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key-not-a-real-credential';
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  }
}

// The stub is structurally compatible with the slice of the client the adapter uses, but
// not with the SDK's full generic surface; the cast is confined to these three lines.
type Stub = ConstructorParameters<typeof AnthropicAdapter>[1];

const CASE = (): ConformanceCase => ({
  makeAdapter: () => withKey(() => new AnthropicAdapter(CFG, stubClient() as unknown as Stub)),
  makeFailing: (status) =>
    withKey(
      () =>
        new AnthropicAdapter(
          CFG,
          stubClient({ failWith: new StubApiError(status) }) as unknown as Stub,
        ),
    ),
  constructWithoutKey: () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      new AnthropicAdapter(CFG);
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  },
  missingKeyErrorName: MissingApiKeyError.name,
  expectedText: TEXT_PARTS.join(''),
  expectedTokensIn: TOKENS_IN,
  expectedTokensOut: TOKENS_OUT,
});

runAdapterConformance('anthropic', CASE);
