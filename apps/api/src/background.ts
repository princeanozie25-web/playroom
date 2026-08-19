/**
 * Process-local ownership for work deliberately kept off a request's latency path.
 *
 * A detached promise is still using process resources. The previous command paths discarded those
 * promises, so Fastify could end its PostgreSQL pool while summary maintenance was between queries.
 * This owner closes admission first, then drains the work it already owns before the pool closes.
 */
export class BackgroundWork {
  private accepting = true;
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly report: (label: string, error: unknown) => void) {}

  /** Start and own a task. Returns false once shutdown has begun, without starting the task. */
  run(label: string, task: () => Promise<unknown>): boolean {
    if (!this.accepting) return false;

    try {
      this.own(label, task());
    } catch (error) {
      this.report(label, error);
    }

    return true;
  }

  /** Own a promise that an event source has already started. */
  own(label: string, task: Promise<unknown>): void {
    const owned = Promise.resolve(task).then(
      () => undefined,
      (error) => this.report(label, error),
    );

    this.pending.add(owned);
    void owned.finally(() => this.pending.delete(owned));
  }

  /** Refuse new background work. Existing work remains owned and can be drained. */
  stop(): void {
    this.accepting = false;
  }

  get size(): number {
    return this.pending.size;
  }

  /**
   * Wait for all work currently owned, including work that an owned task schedules while draining.
   * The server calls stop() first, so the set can only shrink during shutdown.
   */
  async drain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.pending.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      const settled = Promise.allSettled([...this.pending]).then(() => true);
      const timedOut = new Promise<false>((resolve) => {
        const timer = setTimeout(() => resolve(false), remaining);
        timer.unref();
      });
      if (!(await Promise.race([settled, timedOut]))) return false;
    }
    return true;
  }
}
