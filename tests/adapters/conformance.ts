import { describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentTurnChunk } from '@playroom/shared';

// THE ADAPTER CONFORMANCE SUITE (Bible §20: "one conformance suite every adapter must
// pass"). One set of assertions, many implementations.
//
// Written against the adapter that already existed, BEFORE a second one was built. A
// suite shaped to fit the thing it is meant to test proves nothing, so the order
// mattered: these assertions describe the AgentTurn contract, not either provider.
//
// Each adapter supplies FIXTURES — its own provider's wire format — and the suite
// supplies the ASSERTIONS. That split is the point. A stubbed transport means CI needs
// no provider key and spends nothing, while still exercising the adapter's real request
// construction and real stream parsing.

export interface ConformanceCase {
  /** Adapter under test, wired to a stub transport that returns a normal streamed reply. */
  makeAdapter(): AgentAdapter;
  /** Same adapter, but the transport answers with an HTTP error status. */
  makeFailing(status: number): AgentAdapter;
  /** Construct with the provider's key absent. Must throw a typed, named error. */
  constructWithoutKey(): void;
  /** The name of the error class thrown when the key is missing. */
  missingKeyErrorName: string;
  /** Text the stub streams back, split across multiple wire deltas. */
  expectedText: string;
  expectedTokensIn: number;
  expectedTokensOut: number;
}

async function collect(adapter: AgentAdapter, ...args: Parameters<AgentAdapter['stream']>) {
  const chunks: AgentTurnChunk[] = [];
  for await (const c of adapter.stream(...args)) chunks.push(c);
  return chunks;
}

export function runAdapterConformance(name: string, makeCase: () => ConformanceCase): void {
  describe(`adapter conformance — ${name}`, () => {
    it('yields provider-neutral AgentTurnChunks and nothing else', async () => {
      const c = makeCase();
      const chunks = await collect(c.makeAdapter(), [{ author: 'prince', body: 'hello' }]);
      // Every chunk is one of the three declared kinds. A provider-specific shape
      // leaking through here would mean the room can see the provider.
      for (const chunk of chunks) {
        expect(['text_delta', 'done', 'error']).toContain(chunk.kind);
      }
    });

    it('STREAMS: text arrives as multiple deltas, not one blob', async () => {
      const c = makeCase();
      const chunks = await collect(c.makeAdapter(), [{ author: 'prince', body: 'hello' }]);
      const deltas = chunks.filter((x) => x.kind === 'text_delta');
      // The whole S0.3 clip is the token-by-token fill. One delta containing everything
      // satisfies "it replied" and fails the thing the demo is actually showing.
      expect(deltas.length).toBeGreaterThan(1);
      expect(deltas.map((d) => (d.kind === 'text_delta' ? d.text : '')).join('')).toBe(
        c.expectedText,
      );
    });

    it('terminates with exactly one terminal chunk, and it is last', async () => {
      const c = makeCase();
      const chunks = await collect(c.makeAdapter(), [{ author: 'prince', body: 'hello' }]);
      const terminals = chunks.filter((x) => x.kind === 'done' || x.kind === 'error');
      expect(terminals).toHaveLength(1);
      expect(chunks[chunks.length - 1]).toBe(terminals[0]);
    });

    it('populates token telemetry on done — cost cannot be computed without it', async () => {
      const c = makeCase();
      const chunks = await collect(c.makeAdapter(), [{ author: 'prince', body: 'hello' }]);
      const done = chunks.find((x) => x.kind === 'done');
      expect(done).toBeDefined();
      if (done?.kind !== 'done') throw new Error('expected a done chunk');
      expect(done.tokens_in).toBe(c.expectedTokensIn);
      expect(done.tokens_out).toBe(c.expectedTokensOut);
      expect(done.stop_reason).toBeTruthy();
      // Zero tokens would silently price the turn at nothing — the §17/§18 spend line
      // depends on these being real, so assert they are non-zero rather than present.
      expect(done.tokens_in).toBeGreaterThan(0);
      expect(done.tokens_out).toBeGreaterThan(0);
    });

    it('honours the shared system prompt and max output tokens without inspecting them', async () => {
      const c = makeCase();
      // Passing options must not change the contract shape. Both adapters read the same
      // prompt file; the suite only asserts that supplying it does not break the stream.
      const chunks = await collect(c.makeAdapter(), [{ author: 'prince', body: 'hello' }], {
        systemPrompt: 'be brief',
        maxOutputTokens: 64,
      });
      expect(chunks.some((x) => x.kind === 'text_delta')).toBe(true);
      expect(chunks[chunks.length - 1]?.kind).toBe('done');
    });

    it('a missing key throws a TYPED, NAMED error at construction — not at stream time', async () => {
      const c = makeCase();
      // Named, because runAgentTurn records `error_class` from it and a generic Error
      // gives the room "Error" as its explanation.
      expect(() => c.constructWithoutKey()).toThrowError(
        expect.objectContaining({ name: c.missingKeyErrorName }),
      );
    });

    for (const status of [400, 401, 429, 500, 503]) {
      it(`a provider ${status} surfaces as a typed failure, not an unhandled rejection`, async () => {
        const c = makeCase();
        // The contract accepts either an `error` chunk or a thrown error — runAgentTurn
        // handles both and writes completed{success:false}. What is NOT accepted is a
        // rejection nobody awaits, or a stream that ends with `done` as though it worked.
        let terminal: AgentTurnChunk | undefined;
        let thrown: unknown;
        try {
          const chunks = await collect(c.makeFailing(status), [{ author: 'p', body: 'x' }]);
          terminal = chunks[chunks.length - 1];
        } catch (err) {
          thrown = err;
        }
        if (thrown === undefined) {
          expect(terminal?.kind).toBe('error');
        } else {
          expect(thrown).toBeInstanceOf(Error);
          expect((thrown as Error).name).toBeTruthy();
        }
        // Either way it must NOT have reported success.
        expect(terminal?.kind).not.toBe('done');
      });
    }

    it('never leaves an unhandled rejection behind on the failure path', async () => {
      const c = makeCase();
      const seen: unknown[] = [];
      const onUnhandled = (e: unknown): void => void seen.push(e);
      process.on('unhandledRejection', onUnhandled);
      try {
        await collect(c.makeFailing(500), [{ author: 'p', body: 'x' }]).catch(() => undefined);
        // Give the microtask queue a turn to surface anything dangling.
        await new Promise((r) => setTimeout(r, 50));
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
      expect(seen).toHaveLength(0);
    });

    it('reports its own id, which is a member id and never a provider name', async () => {
      const c = makeCase();
      const adapter = c.makeAdapter();
      expect(adapter.id).toBeTruthy();
      expect(adapter.id).not.toMatch(/anthropic|openai/i);
    });
  });
}
