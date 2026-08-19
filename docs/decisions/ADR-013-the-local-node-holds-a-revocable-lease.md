# ADR-013: The Local Node holds a revocable lease

## Context

ADR-012 split the two trust surfaces: the Execution Gate (C1) DECIDES a host op; it never executes
(RT-005). That left invariant #7 — "local access mediated through a trusted node rather than an
unrestricted shell" — at _mediated-by-contract_: the gate says ALLOW, but nothing in the fabric holds
a compliant node to only running what it was allowed, or stops it once it has started.

C2 is the node's side of that contract. The question it raised: **what makes a host op's execution
require the fabric's ongoing permission, such that withdrawing permission stops the node?**

## Decision

**A host op is authorised for execution only under a live LEASE, presented at a dedicated node-op
door.** The lease is revocable, heartbeat-bounded, and capability-scoped; revoking it refuses the
node's next op. Invariant #7 becomes **unbypassable in the sanctioned path**.

- **The lease** is a session row modelled on `member_credentials` / `oauth_tokens`: a hashed `pln_`
  token, bound to a member and the `prm_` credential that granted it, with a capability list, an
  absolute `expires_at`, a `heartbeat_deadline`, and `revoked_at`. It is LIVE only when unrevoked,
  unexpired, heartbeat-fresh, and its granting credential is still live — all checked in one lookup.
- **The node-op door** (`POST /rooms/:id/node-ops`) authenticates the LEASE token, checks the op is
  within the lease's capability scope, then runs the SAME `requestAction → evaluate` gateway C1 built,
  under `mode: 'bridged'`. On ALLOW the node runs the op itself, off the fabric. On revoke, `verifyLease`
  fails and the op is refused before the gate is even consulted — "a revoked lease stops local work
  mid-flight."
- **The lease gates the DOOR, not the evaluator.** `evaluate` stays pure and C1 is untouched: a bare
  host-op verdict obtained elsewhere is not execution (RT-005 — nothing runs without a node), so the
  only sanctioned execution interface is this lease-bound door.

Three sub-rulings:

- **Heartbeat liveness.** A node that stops pinging loses its authority when the deadline lapses — the
  bridge notices a dead node. A heartbeat that arrives before the absolute expiry _revives_ the lease
  (reconnect grace); only the ops during the gap were refused. A revoked lease can never revive.
- **Capability scope (least privilege per session).** A lease carries the host action types it may
  propose, defaulting to files + git — **`shell.*` must be asked for**. The gate remains the ceiling,
  so a capability only ever narrows the mandate, never widens it.
- **The node executor lives off-fabric.** The fabric is not where a shell runs (ADR-012). The node is a
  thin client that opens a lease, then loops: propose an op → on ALLOW run it → heartbeat; on
  `lease_invalid`, stop.

  ```
  const { lease_token } = POST /leases { capabilities: ['fs.','git.','shell.exec'] }
  loop:
    v = POST /rooms/:id/node-ops  (Bearer lease_token) { action, resource }
    if v.status == 401 (lease_invalid): STOP        // revoked, expired, or stale
    if v.decision == 'ALLOW':  run the op locally
    if v.decision == 'CO_SIGN': poll /rooms/:id/decisions/:id, run only if APPROVED
    if v.decision == 'BLOCK':  do not run; surface the reason
    every < heartbeat window: POST /leases/heartbeat (Bearer lease_token)
  ```

### The honest limit

The fabric cannot stop code already running on someone's machine, and it never claims to. The lease
governs the **trusted** node — the one that asks before it acts and honours a refusal. A rogue process
that ignores the door was never mediated by anything and is out of scope for #7, exactly as a stolen
laptop is out of scope for a door lock. "Unbypassable in the sanctioned path" is the precise claim.

### Options rejected, and their costs

**Gate `requestAction` itself on a live lease.** Would make every host-op verdict — including the
decide-only ones every other surface can ask for — require a lease, breaking C1's tests and conflating
the decision surface with the execution surface that ADR-012 deliberately separated. Rejected: the
lease is an execution precondition, and belongs at the execution door.

**A real in-fabric executor.** Rejected already by ADR-012 — the API process is the wrong place for a
shell. C2 authorises execution; it does not perform it.

**Expiry-only leases (no heartbeat).** Simpler, but a node that crashes or disconnects would keep its
authority until the absolute expiry — a bridge that cannot tell a live node from a dead one. The
heartbeat is what makes "a disconnected node does not keep acting" true.

## Consequences

**Easier.** The Drift rail's acceptance test is now real and tested: a revoked lease stops the next op.
Revocation is a single indexed `UPDATE`; the reserved `mode: 'bridged'` finally has a live meaning.

**Harder.** #7 is closed only for a compliant node — the honest limit above. And there is now a second
revocable-secret surface (leases) to reason about alongside credentials and OAuth tokens.

**Foreclosed.** Nothing. A finer capability model (path scope, per-op quotas) and an in-sandbox hosted
executor both remain available.

## Reconsideration trigger

**C3 (temporal facts) and a hosted executor.** When authority needs to depend on history ("no PR until
tests pass"), the facts object (C3) layers onto the gate the lease already binds. And if a hosted node
executor is ever built inside a sandbox, revisit whether the lease should carry finer capabilities than
an action-type list. Re-read this ADR before either.

## Status

Accepted — 19 Aug 2026.
