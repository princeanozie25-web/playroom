import { describe, expect, it } from 'vitest';
import { MockWriteBackend, createWriteBackend, WriteError } from './index.js';

// ═══ THE WRITE SEAM — governed, mock-safe, at-most-once (ADR-020) ═════════════════════════════════════
//
// The Mock backend is what every governed-write test runs against: it records what WOULD be sent and never
// touches a real service, so the co-sign → APPROVE → perform path is exercised with zero risk of a real post.

const req = (over: Partial<Parameters<MockWriteBackend['perform']>[0]> = {}) => ({
  medium: 'x.reply',
  target: 'https://x.com/someone/status/1',
  body: 'noted, thanks!',
  idempotencyKey: 'dec_1',
  ...over,
});

describe('MockWriteBackend', () => {
  it('performs a write, recording it and returning a synthetic ref (never a real post)', async () => {
    const be = new MockWriteBackend();
    const r = await be.perform(req());
    expect(r.ok).toBe(true);
    expect(r.backend).toBe('mock');
    expect(r.ref).toMatch(/^mock:\/\/x\.reply\//);
    expect(be.performed()).toHaveLength(1);
    expect(be.performed()[0].body).toBe('noted, thanks!');
  });

  it('is idempotent by key — the same decision performed twice writes once and returns the same ref', async () => {
    const be = new MockWriteBackend();
    const a = await be.perform(req({ idempotencyKey: 'dec_same' }));
    const b = await be.perform(req({ idempotencyKey: 'dec_same', body: 'a DIFFERENT body' }));
    expect(b.ref).toBe(a.ref); // the first write stands; a re-fire never double-posts
    expect(be.performed()).toHaveLength(1);
  });

  it('different decisions perform independently', async () => {
    const be = new MockWriteBackend();
    await be.perform(req({ idempotencyKey: 'dec_a' }));
    await be.perform(req({ idempotencyKey: 'dec_b' }));
    expect(be.performed()).toHaveLength(2);
  });

  it('the ref commits to the body — a different body yields a different ref (fresh key)', async () => {
    const be = new MockWriteBackend();
    const a = await be.perform(req({ idempotencyKey: 'k1', body: 'one' }));
    const b = await be.perform(req({ idempotencyKey: 'k2', body: 'two' }));
    expect(a.ref).not.toBe(b.ref);
  });
});

describe('createWriteBackend', () => {
  it('defaults to the mock — an unconfigured deployment performs nothing real', () => {
    expect(createWriteBackend({} as NodeJS.ProcessEnv).backend).toBe('mock');
    expect(createWriteBackend({ WRITE_BACKEND: 'mock' } as NodeJS.ProcessEnv).backend).toBe('mock');
  });

  it('throws loudly (at construction) for a real backend that is not built yet', () => {
    expect(() => createWriteBackend({ WRITE_BACKEND: 'x' } as NodeJS.ProcessEnv)).toThrow(
      WriteError,
    );
    try {
      createWriteBackend({ WRITE_BACKEND: 'github' } as NodeJS.ProcessEnv);
    } catch (e) {
      expect((e as WriteError).code).toBe('not_configured');
    }
  });
});
