import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentTurnChunk } from '@playroom/shared';
import { listAdapters } from '@playroom/adapters';
import { warmUp } from '../src/warmup.js';
import { testPool } from './support.js';

// THE WARM-UP PRIMITIVE (S0.5c).
//
// Asserted on the MECHANISM, not on a latency figure: a test that checked "the second call
// is faster" would be a benchmark pretending to be a test, and would fail on a slow runner
// while telling nobody anything. The numbers live in ADR-008, measured against real
// providers by a script that never runs in CI.
//
// What matters here is that the primitive reaches every target, reports honestly when it
// does not, and cannot take the process down — because it runs at boot, and a warm-up that
// throws at boot converts a slow first turn into no server at all.

const pool = testPool();

afterAll(async () => {
  await pool.end();
});

function adapter(id: string, warm?: () => Promise<void>): AgentAdapter {
  return {
    id,
    async *stream(): AsyncGenerator<AgentTurnChunk> {
      throw new Error('warm-up must not stream — that would spend tokens');
    },
    ...(warm ? { warm } : {}),
  };
}

describe('warmUp', () => {
  it('warms the database and every enabled adapter, through the pool it was given', async () => {
    const warmed: string[] = [];
    const result = await warmUp({
      pool,
      adapterFactory: (id) =>
        adapter(id, async () => {
          warmed.push(id);
        }),
    });

    // Every enabled adapter, derived from the roster — not a hardcoded list, so enabling a
    // third member in adapters.yaml warms it without touching this file (§6).
    const enabled = listAdapters().map((a) => a.id);
    expect(warmed.sort()).toEqual([...enabled].sort());

    const targets = result.targets.map((t) => t.target).sort();
    expect(targets).toEqual(['database', ...enabled].sort());
    expect(result.targets.every((t) => t.ok)).toBe(true);
    expect(result.total_ms).toBeGreaterThanOrEqual(0);
  });

  it('really does query the database — the pool is used, not just listed as a target', async () => {
    const query = vi.spyOn(pool, 'query');
    await warmUp({ pool, adapterFactory: (id) => adapter(id, async () => {}) });
    expect(query).toHaveBeenCalled();
    query.mockRestore();
  });

  it('reports a failed adapter as FAILED and still warms the others', async () => {
    // The failure a broken key produces. It must be visible: a warm-up that reports
    // success while one provider is unreachable moves the cold cost back onto the member
    // while the operator believes it is handled.
    const enabled = listAdapters().map((a) => a.id);
    const broken = enabled[0];
    const result = await warmUp({
      pool,
      adapterFactory: (id) =>
        adapter(id, async () => {
          if (id === broken) throw new Error('MissingApiKeyError: no key');
        }),
    });

    const failed = result.targets.filter((t) => !t.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0].target).toBe(broken);
    expect(failed[0].error).toContain('no key');
    // The rest still warmed — one dead provider must not leave the others cold.
    expect(result.targets.filter((t) => t.ok).length).toBe(result.targets.length - 1);
  });

  it('reports an adapter that CANNOT be constructed, rather than throwing at boot', async () => {
    const result = await warmUp({
      pool,
      adapterFactory: () => {
        throw new Error('MissingApiKeyError: never constructed');
      },
    });
    expect(result.targets.find((t) => t.target === 'database')?.ok).toBe(true);
    expect(result.targets.filter((t) => !t.ok).length).toBe(listAdapters().length);
  });

  it('distinguishes SKIPPED from OK — an unwarmable roster is not a successful warm-up', async () => {
    // `warm()` is optional on the interface. An adapter that offers none is not a failure,
    // and it is not a success either: `skipped` is a separate field so a roster of
    // unwarmable adapters cannot read as "warm-up complete".
    const result = await warmUp({ pool, adapterFactory: (id) => adapter(id) });
    const adapters = result.targets.filter((t) => t.target !== 'database');
    expect(adapters.length).toBeGreaterThan(0);
    expect(adapters.every((t) => t.ok && t.skipped === true)).toBe(true);
    expect(result.targets.find((t) => t.target === 'database')?.skipped).toBeUndefined();
  });

  it('never rejects — it runs at boot, where throwing means no server', async () => {
    await expect(
      warmUp({
        pool,
        adapterFactory: () => {
          throw new Error('boom');
        },
        log: {
          info: () => {},
          warn: () => {
            throw new Error('even a throwing logger must not take the process down');
          },
        },
      }),
    ).resolves.toBeDefined();
  });
});
