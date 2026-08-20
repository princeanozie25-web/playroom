import { describe, expect, it } from 'vitest';
import { reconcile, type ChainLinkView } from './index.js';

// ═══ RECONCILE — do two machines agree on a room's history, and where do they diverge? (ADR-021) ══════
//
// Build chain views from short hash strings (the real entry_hash algorithm is A3's; reconcile only compares
// them). The link property is assumed: matching entry_hash at a position means identical history through it.

/** A chain view from a list of entry hashes; prev_hash links to the one before (genesis for the first). */
function chain(...hashes: string[]): ChainLinkView[] {
  return hashes.map((entry_hash, i) => ({
    seq: i,
    entry_hash,
    prev_hash: i === 0 ? 'sha256:genesis' : hashes[i - 1],
  }));
}

describe('reconcile — agreement and fast-forward', () => {
  it('identical chains are in_sync, with the shared root and nothing ahead', () => {
    const r = reconcile(chain('a', 'b', 'c'), chain('a', 'b', 'c'));
    expect(r.status).toBe('in_sync');
    expect(r.commonRoot).toBe('c');
    expect(r.localAhead).toBe(0);
    expect(r.remoteAhead).toBe(0);
    expect(r.forkIndex).toBeNull();
  });

  it('a shorter local that is a prefix of remote is remote_ahead (local can fast-forward)', () => {
    const r = reconcile(chain('a', 'b'), chain('a', 'b', 'c', 'd'));
    expect(r.status).toBe('remote_ahead');
    expect(r.commonRoot).toBe('b');
    expect(r.remoteAhead).toBe(2);
    expect(r.localAhead).toBe(0);
    expect(r.forkIndex).toBeNull();
  });

  it('a longer local whose prefix is remote is local_ahead (remote can fast-forward)', () => {
    const r = reconcile(chain('a', 'b', 'c'), chain('a'));
    expect(r.status).toBe('local_ahead');
    expect(r.commonRoot).toBe('a');
    expect(r.localAhead).toBe(2);
    expect(r.remoteAhead).toBe(0);
  });

  it('two empty chains agree (both at genesis)', () => {
    const r = reconcile([], []);
    expect(r.status).toBe('in_sync');
    expect(r.commonRoot).toBeNull();
  });

  it('an empty local against a non-empty remote is remote_ahead from genesis', () => {
    const r = reconcile([], chain('a', 'b'));
    expect(r.status).toBe('remote_ahead');
    expect(r.commonRoot).toBeNull();
    expect(r.remoteAhead).toBe(2);
  });
});

describe('reconcile — divergence', () => {
  it('a shared prefix that then diverges is FORKED, at the divergence index, with the common ancestor', () => {
    // Both agree on a, b; then local committed x, remote committed y — a real fork a fast-forward cannot fix.
    const r = reconcile(chain('a', 'b', 'x'), chain('a', 'b', 'y', 'z'));
    expect(r.status).toBe('forked');
    expect(r.commonRoot).toBe('b'); // the last point they agreed on
    expect(r.forkIndex).toBe(2); // position where they first differ
    expect(r.localAhead).toBe(1); // 'x'
    expect(r.remoteAhead).toBe(2); // 'y','z'
  });

  it('chains that share nothing (different genesis) are unrelated', () => {
    const r = reconcile(chain('a', 'b'), chain('p', 'q'));
    expect(r.status).toBe('unrelated');
    expect(r.commonRoot).toBeNull();
    expect(r.forkIndex).toBe(0);
  });

  it('a divergence at the very first entry is unrelated, not forked (no common ancestor)', () => {
    const r = reconcile(chain('a', 'b', 'c'), chain('z', 'b', 'c'));
    expect(r.status).toBe('unrelated');
    expect(r.commonRoot).toBeNull();
    expect(r.forkIndex).toBe(0);
  });

  it('is symmetric in the shape of its answer (local/remote swapped mirrors ahead/behind)', () => {
    const a = reconcile(chain('a', 'b'), chain('a', 'b', 'c'));
    const b = reconcile(chain('a', 'b', 'c'), chain('a', 'b'));
    expect(a.status).toBe('remote_ahead');
    expect(b.status).toBe('local_ahead');
    expect(a.commonRoot).toBe(b.commonRoot);
  });
});

describe('reconcile — purity', () => {
  it('same inputs, same verdict', () => {
    const l = chain('a', 'b', 'x');
    const rm = chain('a', 'b', 'y');
    expect(reconcile(l, rm)).toEqual(reconcile(l, rm));
  });
});
