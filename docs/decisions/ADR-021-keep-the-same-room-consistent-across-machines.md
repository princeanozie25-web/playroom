# ADR-021 — Keep the same room consistent across machines

**Status:** accepted
**Date:** 2026-08-20
**Slice:** multi-host reconciliation — the pure primitive + a local exporter (builds on A3, the audit chain)

## Context

A3 gave each machine a tamper-evident audit chain: every commitment folds into an append-only chain, each
entry hash-linked to the last, the head anchored externally. That makes ONE machine's history verifiable. The
landing line "keep the same room consistent across machines" asks the next question: when TWO machines each
hold a chain for the work they saw, **do they agree — and if not, where did they diverge?** Nothing answered
it. Today's deployment is single-node, so this is groundwork; but it is the primitive every multi-host story
needs, and it composes cleanly with the chain A3 already built and the receipts ADR-016 verifies.

## Decision

Ship the pure reconciliation primitive plus the local exporter it runs on.

- **`@playroom/reconcile`** — a pure, zero-dependency package. `reconcile(local, remote)` takes each machine's
  ordered list of chain LINK VIEWS (`{seq, entry_hash, prev_hash}`) and returns a verdict:
  - `in_sync` — identical; the machines agree completely.
  - `local_ahead` / `remote_ahead` — one is a clean prefix of the other; the shorter can **fast-forward** with
    no conflict.
  - `forked` — they share a prefix then commit different history; a fast-forward cannot fix it, and the result
    names the **common ancestor** and the **exact index of the divergence**.
  - `unrelated` — no shared entry at all (different genesis).

  It leans on the one thing a hash chain gives for free: `entry_hash[i]` folds in `entry_hash[i-1]`, the body,
  and the meta, so two chains whose `entry_hash` matches at position i have **identical history through i**.
  Reconciliation is therefore just finding the first position whose `entry_hash` differs — no trust, no server,
  same verdict on either machine.

- **`chainView` / `reconcileWith`** (`apps/api/src/audit.ts`) — `chainView` exports this machine's chain as
  those link views (ordered ascending); `reconcileWith(pool, remote)` compares ours to a remote host's export.
  It ships only the hashes A3 already anchored — no payloads, and not even the `{room_id, actor_id, event}`
  metadata the receipt inclusion path carries — so it discloses strictly less than a receipt.

## Consequences

- **Divergence is detectable and located, not just suspected.** Two machines can prove they agree, or learn the
  precise entry where they parted — the prerequisite for any convergence policy.
- **A fast-forward is distinguished from a fork.** "You are simply behind" and "we committed different history"
  are different problems; conflating them is how a naive sync silently overwrites. `reconcile` separates them
  and only ever calls the irreconcilable case `forked`.
- **It composes with what exists.** The link views are exactly the columns A3 stores; the exporter is a plain
  `SELECT`, and the comparison is the same hash equality the chain and the receipt verifier already rely on.

## Honest limits

- **It detects and locates a fork; it does not RESOLVE one.** A `forked` result names the common ancestor and
  the divergence, but choosing which line is canonical is a policy/human decision (the losing line's
  commitments have to be re-driven), deliberately out of scope here. This slice is the diagnosis, not the cure.
- **No inter-host wire yet.** `chainView` is a local exporter and `reconcileWith` takes an in-memory remote view;
  exchanging views between running hosts (an endpoint, auth, a pull cadence) is a follow-up. Keeping it to the
  pure primitive avoids standing up a sync protocol before there is a second host to sync with.
- **It compares CHAINS, not SETS.** Two machines that anchored the same commitments in a different ORDER have
  different `entry_hash`es and read as `forked` — correctly, because a hash chain's identity is its order; a
  reorder is a different history, not the same one shuffled.
- **Single-node today.** There is no second host in the live deployment, so this is latent groundwork. It is
  built now because it is the load-bearing primitive multi-host needs and it is cheap, pure, and testable in
  isolation — not because a second host exists yet.
