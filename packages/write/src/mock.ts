import { createHash } from 'node:crypto';
import type { WriteBackend, WriteReceipt, WriteRequest } from './types.js';

export const BACKEND_MOCK = 'mock';

/**
 * A write backend that performs NOTHING real — it records the request and returns a synthetic ref. This is
 * the CI/offline/demo backend, and the one every governed-write test runs against: it lets the whole path
 * (co-sign → APPROVE → perform → receipt) be exercised without touching X, GitHub or email, so a test can
 * never accidentally post. It is idempotent by `idempotencyKey`: the same decision performed twice returns the
 * same ref and records one write, modelling the "at most once" the real executor must also hold.
 */
export class MockWriteBackend implements WriteBackend {
  readonly backend = BACKEND_MOCK;
  readonly media = ['*'] as const;
  private readonly byKey = new Map<string, WriteReceipt>();
  private readonly log: WriteRequest[] = [];

  async perform(req: WriteRequest): Promise<WriteReceipt> {
    const existing = this.byKey.get(req.idempotencyKey);
    if (existing) return existing; // already performed — same ref, no second record (at-most-once)
    const digest = createHash('sha256').update(req.body).digest('hex').slice(0, 12);
    const receipt: WriteReceipt = {
      ok: true,
      backend: this.backend,
      ref: `mock://${req.medium}/${digest}`,
    };
    this.byKey.set(req.idempotencyKey, receipt);
    this.log.push(req);
    return receipt;
  }

  /** The writes performed this process — for tests and the demo to assert what would have been sent. */
  performed(): readonly WriteRequest[] {
    return this.log;
  }
}
