import { describe, it, expect } from 'vitest';
import { costUsd, getAdapterConfig } from './registry.js';

describe('adapter registry', () => {
  it('loads claude-main from adapters.yaml', () => {
    const cfg = getAdapterConfig('claude-main');
    expect(cfg.enabled).toBe(true);
    expect(cfg.max_output_tokens).toBeGreaterThan(0);
    expect(cfg.cost_per_1k_in).toBeGreaterThanOrEqual(0);
    expect(cfg.cost_per_1k_out).toBeGreaterThanOrEqual(0);
  });

  it('throws on an unknown id', () => {
    expect(() => getAdapterConfig('does-not-exist')).toThrow(/unknown adapter/);
  });

  it('computes cost from the per-1k prices', () => {
    const cfg = getAdapterConfig('claude-main');
    expect(costUsd(cfg, 1000, 1000)).toBeCloseTo(cfg.cost_per_1k_in + cfg.cost_per_1k_out, 6);
  });
});
