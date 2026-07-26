import type { Pool } from 'pg';
import type { AgentAdapter } from '@playroom/shared';
import { listAdapters } from '@playroom/adapters';

/**
 * PAY THE COLD COSTS BEFORE A MEMBER DOES.
 *
 * Two findings at opposite ends of one wire, and on the first summon of the morning they
 * COMPOUND, because Postgres sits on the first-token path by persist-before-fan-out:
 *
 *   A4-F9   a suspended Neon compute costs ~+657ms to wake
 *   S04-N1  a cold provider connection costs ~+1 to +1.5s
 *
 * Together, plausibly ~2.5s against a P50 of 900ms and a P95 of 1.8s (ADR-005). Inside
 * §11's 3s ceiling, so nothing is broken — and over a budget that is written down, on
 * exactly the request a pilot makes at nine in the morning.
 *
 * THIS MUST NOT BECOME A WAY OF NOT KNOWING THE COLD NUMBER. A comfortable warm figure
 * published while a real user waits 2.5s is the same failure as a drift query reading
 * zero over an empty log: an instrument that is green because it is looking away. Both
 * numbers are measured and both are written down — ADR-008 carries the cold distribution
 * next to the warm one, and this primitive is why the warm one is the common case rather
 * than the only one anybody ever looked at.
 *
 * A PRIMITIVE, NOT A SCHEDULE. Nothing here runs on a timer. A keep-alive across pilot
 * hours is a real need and it is S2.9's — and when it arrives it is a timer calling this
 * function, not a second mechanism. Recorded as a deferred finding with its trigger
 * (S05c-N1) rather than built speculatively.
 */

export interface WarmTarget {
  /** `database`, or an adapter id. Never a provider name (§6). */
  target: string;
  ms: number;
  ok: boolean;
  /** Present only on failure. A warm-up that fails silently looks like one that works. */
  error?: string;
  /** True when the target offers no warm-up — distinct from one that failed. */
  skipped?: boolean;
}

export interface WarmResult {
  total_ms: number;
  targets: WarmTarget[];
}

export interface WarmDeps {
  pool: Pool;
  adapterFactory: (id: string) => AgentAdapter;
  log?: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
}

async function timed(target: string, fn: () => Promise<void>): Promise<WarmTarget> {
  const t = Date.now();
  try {
    await fn();
    return { target, ms: Date.now() - t, ok: true };
  } catch (err) {
    // NEVER FATAL. A cold first turn is slow; a crashed boot is down. But the failure is
    // returned and logged rather than swallowed, because a permanently broken warm-up
    // that reports success is worse than no warm-up at all — it moves the cold cost back
    // onto the member while the operator believes it is handled.
    return {
      target,
      ms: Date.now() - t,
      ok: false,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }
}

/**
 * Warm the database and every enabled adapter, concurrently.
 *
 * Concurrent because the targets are independent and the whole point is to finish before
 * a member arrives; serial would make the slowest provider gate the database.
 *
 * Adapter construction is inside the timed block on purpose: `createAdapter` throws for a
 * missing key, and that is exactly the kind of thing this should surface at boot rather
 * than on the first summon.
 */
export async function warmUp(deps: WarmDeps): Promise<WarmResult> {
  const t0 = Date.now();

  const jobs: Array<Promise<WarmTarget>> = [
    // Wakes a suspended Neon compute AND establishes a pooled connection with its TLS
    // handshake done. The cheapest possible query — the point is the round trip.
    timed('database', async () => {
      await deps.pool.query('SELECT 1');
    }),
  ];

  for (const cfg of listAdapters()) {
    jobs.push(
      (async (): Promise<WarmTarget> => {
        const t = Date.now();
        let adapter: AgentAdapter;
        try {
          adapter = deps.adapterFactory(cfg.id);
        } catch (err) {
          return {
            target: cfg.id,
            ms: Date.now() - t,
            ok: false,
            error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          };
        }
        // SKIPPED IS NOT FAILED. Warming is optional on the interface, and a test's stub
        // adapter has nothing to warm — but a roster of unwarmable adapters must not read
        // as a successful warm-up, so the two are separate fields rather than one flag.
        if (!adapter.warm) return { target: cfg.id, ms: Date.now() - t, ok: true, skipped: true };
        return timed(cfg.id, async () => {
          await adapter.warm?.();
        });
      })(),
    );
  }

  const targets = await Promise.all(jobs);
  const result: WarmResult = { total_ms: Date.now() - t0, targets };

  // THE LOG CALL IS GUARDED TOO. `warmUp` is started from an onReady hook and not
  // awaited, so a rejection here is an unhandled rejection — which is the crashed boot
  // this function's whole error handling exists to prevent. Not a hypothetical: a pino
  // method extracted from its instance has already thrown at call time in this repo once.
  // Caught by the "never rejects" test, which asserted the claim rather than trusting it.
  const failed = targets.filter((t) => !t.ok);
  try {
    if (failed.length > 0) {
      deps.log?.warn(
        { total_ms: result.total_ms, failed: failed.map((f) => ({ ...f })) },
        'warm-up incomplete — the first turn will pay the cold cost',
      );
    } else {
      deps.log?.info(
        { total_ms: result.total_ms, targets: targets.map((t) => ({ ...t })) },
        'warm-up complete',
      );
    }
  } catch {
    /* a warm-up that cannot report is still a warm-up; it must not be a crash */
  }
  return result;
}
