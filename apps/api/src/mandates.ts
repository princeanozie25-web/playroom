import { loadMandates, type LoadedMandate } from '@playroom/fabric';

/**
 * THE PROCESS-WIDE MANDATE CACHE, in one place.
 *
 * Mandates are code (Bible §9.5): they change by deploy, not at runtime, so loading them once is
 * correct rather than a shortcut. Reloading per evaluation would put file I/O inside the §11
 * <10 ms budget for no gain.
 *
 * Extracted because there were three readers with three habits. `requestAction` had this cache;
 * `stamp.ts` called `loadMandates()` on EVERY TURN, re-reading the mandate directory from disk to
 * stamp one member (a defect I introduced in S1.2 — invisible, since it is dwarfed by provider
 * latency, and wrong for the same reason a per-request `readFileSync` is always wrong); and the
 * handoff needed a fourth. One cache, one line to invalidate if mandates ever become data.
 *
 * S2.2 closed the LAST reader that bypassed this: `listMembers` (members.ts) called `loadMandates()`
 * on EVERY roster read — an S18 finding, a fresh directory read on every summon, decision evaluation
 * and `GET /rooms/:id/members`. It now shares this cache through `allMandates()`, so the mandate
 * directory is read from disk ONCE. `server.ts`'s awaited `onReady` hook calls `listMembers` before
 * the first request, so the cache is warm at boot. A mandate change therefore requires a RESTART —
 * there is deliberately no file-watcher and no hot-reload, because making a live authority change a
 * governed act is S2.1's work, not a side effect of saving a file.
 */
let cache: Map<string, LoadedMandate> | undefined;

/** Every member's mandate, keyed by member id. Loaded once from disk and cached; see above. */
export function allMandates(): Map<string, LoadedMandate> {
  return (cache ??= loadMandates());
}

export function mandateFor(member: string): LoadedMandate | undefined {
  return allMandates().get(member);
}

/**
 * TEST-ONLY: drop the cache so the next read reloads from disk.
 *
 * Production NEVER calls this — a mandate change requires a restart (see above). It exists for the one
 * test that simulates a changed mandate directory at runtime: `mandate-records.test.ts` swaps
 * `PLAYROOM_MANDATES_DIR` to inject an orphaned or mismatched mandate and asserts the load-time
 * refusal. That swap IS the "the config changed" event which, in production, is a restart — so the
 * test resets the cache to model that restart explicitly, rather than relying on a per-call disk read
 * that no longer happens.
 */
export function resetMandateCache(): void {
  cache = undefined;
}
