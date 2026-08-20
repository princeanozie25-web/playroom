import { describe, expect, it } from 'vitest';
import type { AgentTurnChunk } from '@playroom/shared';
import { MockAdapter, mockAdapterFactory } from './index.js';

// ═══ THE DETERMINISTIC ADAPTER — same shape as the real ones, no SDK (ADR-022) ════════════════════════
//
// A MockAdapter is a full AgentAdapter: it streams text deltas, then any actions, then exactly one terminal
// chunk — the contract every real adapter holds. These prove it, so a governed room can drive it identically.

async function drain(it: AsyncIterable<AgentTurnChunk>): Promise<AgentTurnChunk[]> {
  const out: AgentTurnChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe('MockAdapter', () => {
  it('streams text deltas then exactly one terminal `done`', async () => {
    const chunks = await drain(
      new MockAdapter('claude-main', { text: 'hello there friend' }).stream([]),
    );
    const terminals = chunks.filter((c) => c.kind === 'done' || c.kind === 'error');
    expect(terminals).toHaveLength(1);
    expect(terminals[0].kind).toBe('done');
    const text = chunks
      .filter((c): c is Extract<AgentTurnChunk, { kind: 'text_delta' }> => c.kind === 'text_delta')
      .map((c) => c.text)
      .join('');
    expect(text).toBe('hello there friend');
  });

  it('carries the adapter id (a member id, never a provider name)', () => {
    expect(new MockAdapter('sol').id).toBe('sol');
  });

  it('emits scripted structured actions before the terminal chunk (S1.8)', async () => {
    const chunks = await drain(
      new MockAdapter('claude-main', {
        text: 'summoning',
        actions: [{ action: 'summon', arguments: { member: 'sol' } }],
      }).stream([]),
    );
    const action = chunks.find((c) => c.kind === 'action');
    expect(action).toMatchObject({
      kind: 'action',
      action: 'summon',
      arguments: { member: 'sol' },
    });
    // The terminal chunk is still the LAST, and still single.
    expect(chunks[chunks.length - 1].kind).toBe('done');
  });

  it('can script a failing turn (a single `error` terminal, no `done`)', async () => {
    const chunks = await drain(
      new MockAdapter('sol', { error: { error_class: 'Overloaded', message: 'busy' } }).stream([]),
    );
    expect(chunks).toEqual([{ kind: 'error', error_class: 'Overloaded', message: 'busy' }]);
  });

  it('an empty script still produces a valid turn (acknowledgement + done)', async () => {
    const chunks = await drain(new MockAdapter('ada').stream([{ author: 'prince', body: 'hi' }]));
    expect(chunks[chunks.length - 1].kind).toBe('done');
  });
});

describe('mockAdapterFactory — a whole multi-model room, deterministically', () => {
  it('gives each member id its own scripted adapter (a Claude one and a ChatGPT one, side by side)', async () => {
    const factory = mockAdapterFactory({
      'claude-main': { text: 'Claude here — I reviewed the diff.' },
      sol: { text: 'ChatGPT here — LGTM.' },
    });
    const claude = await drain(factory('claude-main').stream([]));
    const gpt = await drain(factory('sol').stream([]));
    expect(claude.some((c) => c.kind === 'text_delta' && c.text.includes('Claude'))).toBe(true);
    expect(gpt.some((c) => c.kind === 'text_delta' && c.text.includes('ChatGPT'))).toBe(true);
    expect(factory('claude-main').id).toBe('claude-main');
    expect(factory('sol').id).toBe('sol');
  });

  it('an unscripted id still gets a working adapter', async () => {
    const factory = mockAdapterFactory();
    const chunks = await drain(factory('bo').stream([]));
    expect(chunks[chunks.length - 1].kind).toBe('done');
  });
});
