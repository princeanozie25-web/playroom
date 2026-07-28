import { OpenAIAdapter, MissingOpenAIKeyError, type AdapterConfig } from '@playroom/adapters';
import { runAdapterConformance, type ConformanceCase } from './conformance.js';

// Fixtures for the SECOND adapter, against the suite written before it existed.
// conformance.ts is imported unchanged — no assertion was added, removed or relaxed to
// accommodate this provider, which is the S0.4 exit criterion holding at the test layer.

const TEXT_PARTS = ['Playroom ', 'governs ', 'the room.'];
const TOKENS_IN = 31;
const TOKENS_OUT = 9;
const STOP = 'stop';

const CFG: AdapterConfig = {
  id: 'conformance-member-2',
  provider: 'openai',
  model: 'test-model',
  enabled: true,
  max_output_tokens: 256,
  cost_per_1k_in: 0.0004,
  cost_per_1k_out: 0.0016,
};

// This provider's chunk shape — deltas carry text, and usage arrives on a final chunk
// that has no choices at all. That asymmetry with the first provider is exactly the sort
// of thing the shared suite exists to normalise over.
// A structured action, in this provider's shape: a streamed tool call whose id and name arrive
// once and whose arguments accumulate across deltas as JSON fragments (S1.8). The adapter reassembles
// them, so the fixture streams them fragmented on purpose — a single-fragment fixture would not
// exercise the accumulation the real stream requires.
const ACTION = { id: 'call_summon_1', name: 'summon', input: { member: 'sol' } };

function providerChunks(opts: { action?: typeof ACTION } = {}): unknown[] {
  if (opts.action) {
    return [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: opts.action.id,
                  function: { name: opts.action.name, arguments: '' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"member":' } }] } }],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"sol"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: TOKENS_IN, completion_tokens: TOKENS_OUT } },
    ];
  }
  return [
    ...TEXT_PARTS.map((content) => ({ choices: [{ delta: { content } }] })),
    { choices: [{ delta: {}, finish_reason: STOP }] },
    { choices: [], usage: { prompt_tokens: TOKENS_IN, completion_tokens: TOKENS_OUT } },
  ];
}

class StubApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`provider responded ${status}`);
    this.name = 'APIError';
    this.status = status;
  }
}

function stubClient(opts: { failWith?: Error; action?: typeof ACTION } = {}) {
  const chunks = providerChunks({ action: opts.action });
  return {
    chat: {
      completions: {
        create: async () => {
          // This provider rejects the create() call itself on an HTTP error, before any
          // chunk arrives — unlike the first provider, which throws mid-iteration. The
          // suite covers both because it asserts the OUTCOME, not the timing.
          if (opts.failWith) throw opts.failWith;
          return {
            async *[Symbol.asyncIterator]() {
              for (const c of chunks) yield c;
            },
          };
        },
      },
    },
  };
}

function withKey<T>(fn: () => T): T {
  const prev = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key-not-a-real-credential';
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev;
  }
}

type Stub = ConstructorParameters<typeof OpenAIAdapter>[1];

const CASE = (): ConformanceCase => ({
  makeAdapter: () => withKey(() => new OpenAIAdapter(CFG, stubClient() as unknown as Stub)),
  makeFailing: (status) =>
    withKey(
      () =>
        new OpenAIAdapter(
          CFG,
          stubClient({ failWith: new StubApiError(status) }) as unknown as Stub,
        ),
    ),
  makeActionAdapter: () =>
    withKey(() => new OpenAIAdapter(CFG, stubClient({ action: ACTION }) as unknown as Stub)),
  expectedAction: { action: ACTION.name, arguments: ACTION.input },
  constructWithoutKey: () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      new OpenAIAdapter(CFG);
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
    }
  },
  missingKeyErrorName: MissingOpenAIKeyError.name,
  expectedText: TEXT_PARTS.join(''),
  expectedTokensIn: TOKENS_IN,
  expectedTokensOut: TOKENS_OUT,
});

runAdapterConformance('openai', CASE);
