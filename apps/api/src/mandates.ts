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
 */
let cache: Map<string, LoadedMandate> | undefined;

export function mandateFor(member: string): LoadedMandate | undefined {
  const loaded = (cache ??= loadMandates());
  return loaded.get(member);
}
