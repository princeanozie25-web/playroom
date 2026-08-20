import { describe, expect, it } from 'vitest';
import { GENESIS, bodyHash, entryHash, type EntryMeta } from './hash.js';
import { verifyDetachedReceipt, type ChainLink, type DetachedReceipt } from './receipt.js';

// ═══ THE OPEN VERIFIER — same input, same verdict, on anyone's machine (ADR-016) ═══════════════════
//
// These build detached receipts with the SAME primitives the server uses, then prove verifyDetachedReceipt
// accepts a genuine one and rejects every way to tamper. No DB, no server — which is the whole point: the
// proof is the algorithm, not our word.

function meta(seq: number): EntryMeta {
  return { room_id: 'r', actor_id: 'prince', event: 'decision.resolved', source_seq: seq };
}

/** Build a chain of `n` commitments and return a detached receipt for entry `i` (0-based). */
function receiptFor(i: number, n: number): DetachedReceipt {
  const payloads = Array.from({ length: n }, (_, k) => ({
    decision_id: `dec_${k}`,
    resolution: 'APPROVED',
  }));
  const metas = Array.from({ length: n }, (_, k) => meta(40 + k));
  const links: ChainLink[] = [];
  let prev = GENESIS;
  for (let k = 0; k < n; k += 1) {
    const body = bodyHash(payloads[k]);
    const entry = entryHash(prev, body, metas[k]);
    links.push({ prev_hash: prev, body_hash: body, entry_hash: entry, meta: metas[k] });
    prev = entry;
  }
  const path = links.slice(i); // this entry (inclusive) to the head
  const self = links[i];
  return {
    decision_id: `dec_${i}`,
    resolution: 'APPROVED',
    source_payload: payloads[i],
    meta: metas[i],
    body_hash: self.body_hash,
    prev_hash: self.prev_hash,
    entry_hash: self.entry_hash,
    root: links[n - 1].entry_hash,
    path,
  };
}

describe('verifyDetachedReceipt — a genuine receipt verifies', () => {
  it('a single-entry chain (the receipt IS the root) verifies, and returns the committed outcome', () => {
    const v = verifyDetachedReceipt(receiptFor(0, 1));
    expect(v.ok).toBe(true);
    expect(v.checks).toEqual({ body: true, entry: true, chain: true, outcome: true });
    expect(v.outcome?.resolution).toBe('APPROVED'); // read from the hashed payload, not a caption
  });

  it('an entry deep in a longer chain verifies, walking the path to the root', () => {
    const v = verifyDetachedReceipt(receiptFor(1, 4)); // 2nd of 4, path = 3 links
    expect(v.ok).toBe(true);
    expect(v.root).toBe(receiptFor(1, 4).root);
  });
});

describe('verifyDetachedReceipt — every tamper is caught', () => {
  it('a flipped payload fails on the BODY', () => {
    const r = receiptFor(0, 3);
    const v = verifyDetachedReceipt({
      ...r,
      source_payload: { decision_id: 'dec_0', resolution: 'DENIED' },
    });
    expect(v.ok).toBe(false);
    expect(v.checks.body).toBe(false);
    expect(v.reason).toMatch(/body/i);
  });

  it('an edited entry_hash fails on the ENTRY', () => {
    const r = receiptFor(0, 3);
    const v = verifyDetachedReceipt({
      ...r,
      entry_hash: 'sha256:forged',
      path: [{ ...r.path[0], entry_hash: 'sha256:forged' }, ...r.path.slice(1)],
    });
    expect(v.ok).toBe(false);
    expect(v.checks.entry).toBe(false);
  });

  it('an edited meta (who committed) fails on the ENTRY — entry_hash no longer recomputes', () => {
    const r = receiptFor(0, 2);
    const v = verifyDetachedReceipt({ ...r, meta: { ...r.meta, actor_id: 'mallory' } });
    expect(v.ok).toBe(false);
    expect(v.checks.entry).toBe(false);
  });

  it('a broken link in the path fails on the CHAIN', () => {
    const r = receiptFor(0, 3);
    const path = [...r.path];
    path[1] = { ...path[1], prev_hash: 'sha256:forged' };
    const v = verifyDetachedReceipt({ ...r, path });
    expect(v.ok).toBe(false);
    expect(v.checks.body).toBe(true);
    expect(v.checks.entry).toBe(true);
    expect(v.checks.chain).toBe(false);
    expect(v.reason).toMatch(/link|inserted|removed/i);
  });

  it('a path that does not start at this receipt fails', () => {
    const r = receiptFor(1, 3);
    const v = verifyDetachedReceipt({ ...r, path: r.path.slice(1) }); // drop the receipt's own entry
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/start/i);
  });

  it('a path that does not reach the claimed root fails', () => {
    const r = receiptFor(0, 3);
    const v = verifyDetachedReceipt({ ...r, root: 'sha256:some-other-root' });
    expect(v.ok).toBe(false);
    expect(v.checks.chain).toBe(false);
    expect(v.reason).toMatch(/root/i);
  });

  it('a LYING CAPTION — honest hashes, but a flipped top-level outcome — fails on the OUTCOME', () => {
    // The whole promise: you verify the OUTCOME, not a caption. source_payload commits to APPROVED; the
    // server leaves every hash honest but flips the top-level resolution to DENIED. Must not read ok.
    const r = receiptFor(0, 2);
    const v = verifyDetachedReceipt({ ...r, resolution: 'DENIED' });
    expect(v.checks.body).toBe(true);
    expect(v.checks.entry).toBe(true);
    expect(v.checks.chain).toBe(true);
    expect(v.checks.outcome).toBe(false);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/outcome|top-level/i);
  });

  it('a malformed receipt (missing fields) is a clean false, never a crash', () => {
    const v = verifyDetachedReceipt({ decision_id: 'x' } as unknown as DetachedReceipt);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/malformed/i);
  });
});
