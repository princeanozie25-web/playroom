import { describe, expect, it } from 'vitest';
import { LiveCaptureRefused, assertLiveMandateHash, resolveLiveTarget } from './capture-live.js';

// ═══ UI3-4 — THE HONEST CORE OF A LIVE CAPTURE, ASSERTED ═══
//
// A capture that looks right but records a local surface, a stub, or a warm cache proves nothing and is
// worse than none, because it will be believed. These tests assert the two mechanisms that prevent that:
// the target cannot default to local, and the liveness hash comparison must FIRE with both values. The
// second is asserted the way the brief demands — not "the run didn't abort" (which passes when the check
// never ran) but "the comparison fired, and here are both hashes it compared".

const LIVE = {
  PLAYROOM_LIVE_API_URL: 'https://playroom-api.fly.dev',
  PLAYROOM_LIVE_WEB_URL: 'https://playroom-web.fly.dev',
} as unknown as NodeJS.ProcessEnv;

describe('resolveLiveTarget — explicit, https, never local', () => {
  it('returns both URLs when they are explicit https live targets', () => {
    expect(resolveLiveTarget(LIVE)).toEqual({
      api: 'https://playroom-api.fly.dev',
      web: 'https://playroom-web.fly.dev',
    });
  });

  it('refuses by a NAMED reason when the target is unset — no silent localhost default', () => {
    try {
      resolveLiveTarget({} as NodeJS.ProcessEnv);
      throw new Error('resolveLiveTarget must throw when the target is unset');
    } catch (err) {
      expect(err).toBeInstanceOf(LiveCaptureRefused);
      expect((err as LiveCaptureRefused).reason).toMatch(/must both be set|no default/i);
    }
  });

  it('refuses a localhost target — the exact thing that would film a dev server', () => {
    const local = {
      PLAYROOM_LIVE_API_URL: 'https://playroom-api.fly.dev',
      PLAYROOM_LIVE_WEB_URL: 'http://localhost:3000',
    } as unknown as NodeJS.ProcessEnv;
    expect(() => resolveLiveTarget(local)).toThrow(LiveCaptureRefused);
  });

  it('refuses a non-https target', () => {
    const insecure = {
      PLAYROOM_LIVE_API_URL: 'http://playroom-api.fly.dev',
      PLAYROOM_LIVE_WEB_URL: 'https://playroom-web.fly.dev',
    } as unknown as NodeJS.ProcessEnv;
    expect(() => resolveLiveTarget(insecure)).toThrow(LiveCaptureRefused);
  });
});

describe('assertLiveMandateHash — the comparison FIRES, or the run aborts', () => {
  const HASH = 'sha256:' + 'a'.repeat(64);
  const members = { members: [{ id: 'claude-main', mandate_hash: HASH }] };

  it('FIRES on a match and records BOTH values — proof it ran, not that nothing aborted', () => {
    const result = assertLiveMandateHash(HASH, members, 'claude-main');
    expect(result.fired).toBe(true);
    expect(result.onScreen).toBe(HASH);
    expect(result.live).toBe(HASH);
    expect(result.member).toBe('claude-main');
  });

  it('ABORTS by a named reason on a hash MISMATCH — the surface is not the live mandate', () => {
    const other = 'sha256:' + 'b'.repeat(64);
    try {
      assertLiveMandateHash(other, members, 'claude-main');
      throw new Error('a mismatch must abort');
    } catch (err) {
      expect(err).toBeInstanceOf(LiveCaptureRefused);
      expect((err as LiveCaptureRefused).reason).toMatch(/MISMATCH/);
    }
  });

  it('aborts when the live roster lacks the member, the hash, or any members at all', () => {
    expect(() => assertLiveMandateHash(HASH, members, 'nobody')).toThrow(/no member "nobody"/);
    expect(() => assertLiveMandateHash(HASH, { members: [] }, 'claude-main')).toThrow(/no members/);
    expect(() =>
      assertLiveMandateHash(
        HASH,
        { members: [{ id: 'claude-main', mandate_hash: null }] },
        'claude-main',
      ),
    ).toThrow(/no mandate_hash/);
    expect(() => assertLiveMandateHash('   ', members, 'claude-main')).toThrow(
      /no mandate_hash was read/,
    );
  });
});
