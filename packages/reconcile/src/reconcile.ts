// ═══ KEEP THE SAME ROOM CONSISTENT ACROSS MACHINES (ADR-021) ══════════════════════════════════════════
//
// Two machines each hold a tamper-evident audit chain (A3) for the work they saw. "Consistent across
// machines" means: do their chains AGREE, and if not, WHERE do they diverge? This is the pure primitive that
// answers it — given each machine's ordered list of chain links, it returns whether they are in sync, whether
// one is simply ahead (a fast-forward), or whether they have FORKED (committed different history from a shared
// point) — and the exact seq of the divergence.
//
// It leans on the one property a hash chain gives for free: `entry_hash[i]` folds in `entry_hash[i-1]`, the
// body, and the meta — so two chains whose `entry_hash` matches at position i have IDENTICAL history through i.
// Reconciliation is therefore just finding the first position whose `entry_hash` differs. No trust, no server:
// same inputs, same verdict, on either machine.

/** One machine's view of a chain entry — the minimum to reconcile: its position and its linked hashes. */
export interface ChainLinkView {
  /** Position in the chain, ascending. Compared by ORDER, not by the raw value (two machines number their
   *  own chains), so callers pass the links already sorted ascending. */
  seq: number;
  entry_hash: string;
  prev_hash: string;
}

export type ReconcileStatus =
  /** Identical roots — the two machines agree completely. */
  | 'in_sync'
  /** Remote is a prefix of local — remote can fast-forward to local with no conflict. */
  | 'local_ahead'
  /** Local is a prefix of remote — local can fast-forward to remote with no conflict. */
  | 'remote_ahead'
  /** They share a prefix then diverge — different history from a common point. A real inconsistency that a
   *  fast-forward cannot resolve; a human/policy must choose which line is canonical. */
  | 'forked'
  /** No shared entry at all (different genesis / unrelated chains). */
  | 'unrelated';

export interface ReconcileResult {
  status: ReconcileStatus;
  /** The last shared `entry_hash` — the common ancestor both machines agree on — or null if they share none. */
  commonRoot: string | null;
  /** How many entries each holds beyond the common ancestor. */
  localAhead: number;
  remoteAhead: number;
  /** The ORDER-INDEX of the first divergence (0-based), set only when `status` is 'forked' (or 'unrelated',
   *  where it is 0). Null when one chain is a clean prefix of the other. */
  forkIndex: number | null;
}

/**
 * Reconcile two machines' chain views. Pure and deterministic. `local` and `remote` are each the machine's
 * chain links, ordered ascending. The comparison is by POSITION: matching `entry_hash` at position i proves
 * identical history through i (the hash-link property), so the common prefix is the run of equal `entry_hash`
 * from the start, and the first mismatch is the fork.
 */
export function reconcile(
  local: readonly ChainLinkView[],
  remote: readonly ChainLinkView[],
): ReconcileResult {
  const min = Math.min(local.length, remote.length);
  let common = 0;
  while (common < min && local[common].entry_hash === remote[common].entry_hash) common += 1;

  const commonRoot = common > 0 ? local[common - 1].entry_hash : null;
  const localAhead = local.length - common;
  const remoteAhead = remote.length - common;

  // They diverged before either ran out — a real fork (or, if nothing matched, unrelated chains).
  if (common < min) {
    return {
      status: common === 0 ? 'unrelated' : 'forked',
      commonRoot,
      localAhead,
      remoteAhead,
      forkIndex: common,
    };
  }

  // One is a (possibly empty) prefix of the other — a clean fast-forward, or identical.
  const status: ReconcileStatus =
    localAhead === 0 && remoteAhead === 0
      ? 'in_sync'
      : localAhead === 0
        ? 'remote_ahead'
        : 'local_ahead';
  return { status, commonRoot, localAhead, remoteAhead, forkIndex: null };
}
