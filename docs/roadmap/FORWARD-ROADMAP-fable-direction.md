# Playroom — Forward Roadmap (the Fable direction, mapped to what exists)

_18 Aug 2026. Prince ratified the Fable report's **vision and forward half** as the north star, with the
code keeping its own vocabulary (ADR-009/010/011 stand — `Door`/`Fabric`/`Worker` mean what they mean in
the tree). This turns the report's nine ABSENT contracts + four PARTIALs into a sequenced build plan,
grounded in `docs/audits/2026-08-fable-contract-map.md` and the current code. Status columns updated 19 Aug as
slices shipped — see the shipped table below and the per-track states._

## Two rails held as acceptance tests (from the report's own premortem)

1. **No infra for its own sake.** Every milestone below must move either the **Drift end-to-end demo** or
   the **one-click-worker** experience. If a milestone can't, it waits. (Premortem row 1.)
2. **Playroom owns its semantics.** The canonical event model and provider neutrality stay ours; AWS
   (Cedar/Dogwood/Rex/AgentCore) and OTEL/LangSmith are adopted as _concepts or adapters behind a seam_,
   never as an AWS-shaped product. (Invariants #9, #11; premortem rows 3–4.)

**The only gates are technical dependencies** — no revenue gate (dropped 18 Aug).

## Shipped in the 19 Aug autonomous run (all on main, CI green, each adversarially reviewed)

| Slice         | Commit    | What landed                                                                                         |
| ------------- | --------- | --------------------------------------------------------------------------------------------------- |
| **A1**        | `31b4c87` | Signed the mandates (Ed25519). Invariant #3 is cryptographic; the authority root exists.            |
| **B1**        | `2a28642` | Remote MCP server — a Claude subscription drives a room over Streamable HTTP (8 tools).             |
| **B3**        | `60436d9` | `list_pending_tags` — a connected member discovers when it was @-mentioned.                         |
| **A3**        | `24b7bc6` | Tamper-evident audit chain (`audit_chain`) + `get_receipt` (`1efaaa8`) — the moat's crypto bar.     |
| **B2**        | `99cb097` | OAuth 2.1 per-subscription login (auth-code + PKCE, revocable tokens) — the MCP front door.         |
| **Room Door** | `3a6dfd4` | Scoped admission (ADR-009): a room enrols only its creator; an owner-only `admit` lets others in.   |
| **C1**        | `4c9621a` | Execution Gate (ADR-012): host `fs/git/shell` ops pass a resource-scoped policy check. Decide-only. |
| **C2**        | `b3cebae` | Local Node (ADR-013): a revocable lease binds host execution — revoke stops the node's next op.     |
| **x-read**    | `f6b33ad` | Provider-neutral X/Twitter READ seam (`@playroom/x-read`) — the grokbot-parity structure.           |

Invariant #7 — the one the repo openly did not hold — is now **closed in the sanctioned path** (C1 + C2).
**Track A** is complete but for A2 (delegation narrowing); **Track B** is complete; **Track C** needs only C3
(the temporal facts object). The remaining work is the downstream tracks (D Harbor, E verified experience,
sequenced last) plus the fabric-completion gates (screening + egress DLP) that precede a non-Prince user.

## The dependency spine — why this order

```
A. AUTHORITY ROOT        →  B. SUBSCRIPTION WEDGE (the visible win)
sign mandates,              MCP server over the command layer
delegation, receipts        (safe once authority is signed)
      |
      v
C. SAFE EXECUTION        →  D. HARBOR (placement plane)
Execution Gate + Local      resumption, placement, worker presence
Node (closes the one           (safe cross-machine continuity)
FALSE invariant, #7)
      |
      v
E. VERIFIED EXPERIENCE (the compounding moat — LAST)
verified Work History → Artifact → Experience Record → Network/Directory

  ── running ALONGSIDE A–C: the fabric-completion track ──
  screening (L1/L2) · egress DLP · a room Door — the conditions that make
  opening Playroom to a NON-PRINCE user safe.
```

Nothing here is a rename. `Worker` = `member`+`adapter` (product word, ADR-011); the report's `Fabric`
(visibility) is the repo's **§7.1 context-isolation / assembly layer**, distinct from `@playroom/fabric`
the authority engine (ADR-010); `Door` (room admission) is the "room door" — scoped admission, now shipped (ADR-009).

---

## Track A — the authority root (unblocks everything external)

| #      | Slice                                         | Delivers                                                                                                                                                                                                          | Builds on                                     | State                                                                                                    |
| ------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **A1** | **Sign the mandates (S2.1)**                  | Invariant #3 made cryptographic — authority attributable to a principal by a key, not a git file                                                                                                                  | `evaluate.ts`, `mandate.ts` (both reserve it) | **SHIPPED** `31b4c87`. Ed25519 + §0 enforcement; the signing key is a custodial bootstrap key.           |
| **A2** | **Delegation Chain: monotonic narrowing**     | Complete the PARTIAL — authority that narrows across worker→worker hops with scope/expiry/evidence per hop (today a hop is re-evaluated against the emitter's own mandate, `SUMMON_DEPTH_CAP=1`, never inherited) | A1; `SummonChain` (`commands/context.ts`)     | Not started                                                                                              |
| **A3** | **Receipts + hash chain + daily root (S2.3)** | Tamper-evident audit (invariant #8 general form) — the moat's missing cryptographic bar and the prerequisite for verified Work History + Experience Records                                                       | append-only `events` (exists, not chained)    | **SHIPPED** `24b7bc6` + `get_receipt` `1efaaa8`. Per-entry fabric signature + root email are follow-ups. |

Acceptance: a non-Prince credential can hold signed, bounded, attributable authority — the precondition for every door below.

---

## Track B — the subscription wedge (the visible product win)

| #      | Slice                        | Delivers                                                                                                                                                                                                                                                                             | Builds on                                                                 | State                                                                                                      |
| ------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **B1** | **Remote MCP server (S4.2)** | "Make the infrastructure disappear" — drive a room from a Claude subscription. New `packages/hosts/` seam wrapping `executeCommand` as MCP tools (`list_rooms`, `read_room`, `post_message`, `respond_to_decision`, `get_receipt`); "adapter over commands, zero new business logic" | the SCC action door (proves every op) + A1 (safe with a non-Prince token) | **SHIPPED** `2a28642`. 8 governed tools; identity derived.                                                 |
| **B2** | **OAuth per-user (S4.1)**    | Turns a custodial `prm_` seat token into a subscription identity (auth-code + PKCE, principal binding, revocation)                                                                                                                                                                   | `credentials.ts` (`/redeem` today)                                        | **SHIPPED** `99cb097`. Consent pages server-rendered in apps/api; family-lineage revoke + reuse detection. |
| **B3** | **Pending-tag queue (S4.3)** | Connected members aren't summonable by tag — surface tags as pollable pending items (`list_pending_tags`); the notify half already ships (S-PUSH)                                                                                                                                    | S-PUSH                                                                    | **SHIPPED** `60436d9`.                                                                                     |

Acceptance test: **Prince drives a room from his Claude subscription, closes the laptop, approves on his phone.** (The one-click-worker rail.)

---

## Track C — safe execution (close the one FALSE invariant, #7)

Today `claude-code`'s work is **bridged, not gated** — its participation is governed, its host side effects run outside the fabric (`migrations/024`, disclosed in the red-team ledger). This track makes it gated.

| #      | Slice                             | Delivers                                                                                                                                                                                                                                                                                                                                                                                      | Builds on                                                     | State                                                                                                                                                                                                     |
| ------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1** | **Execution Gate (Rex-inspired)** | Host file/git/shell ops pass a resource-scoped policy check before running — a remote worker does not get a raw shell just because a machine connected. Invariant #7 FALSE → **mediated-by-contract** (unbypassably TRUE once C2 enforces). **DECIDE-ONLY** per ADR-012: the gate rules ALLOW/CO_SIGN/BLOCK and executes NOTHING (RT-005 preserved).                                          | A1 + the Action Gateway (`executeCommand`+`evaluate`, exists) | **SHIPPED** (ADR-012) — `evaluate` matches `resource` against mandate `host_scope`/`host_protected`; `fs.*`/`git.*` confined, `shell.*` allowlist + co-sign the rest. Prod `claude-code` re-sign pending. |
| **C2** | **Local Node**                    | The trusted bridge to a user's machine — lease/heartbeat, capability scoping, revocation, reconnect. **SHIPPED** (ADR-013): a revocable, heartbeat-bounded, capability-scoped LEASE + a lease-bound node-op door; a host op runs only under a live lease, so revoking it stops the node's next op (the acceptance test). #7 → unbypassable in the sanctioned path; executor stays off-fabric. | C1                                                            | **SHIPPED** (ADR-013)                                                                                                                                                                                     |
| **C3** | **Dogwood-style temporal policy** | The evaluator gains a caller-computed **facts object** ("tests passed at seq N", "no unresolved regression") so authority can depend on history — kept pure, cost visible to the caller. The runner already does history-aware refusal (`runOrders.ts`); this joins it to the evaluator                                                                                                       | A3 (event projection)                                         | Designed in the audit's Phase 3 Q1                                                                                                                                                                        |

Acceptance test: **Drift cannot open a PR until tests pass; a revoked lease stops local work mid-flight.** (The Drift rail.)

---

## Track D — Harbor (the placement plane)

The report's warning, held: **Harbor is not a months-long runtime project.** Express it as the existing durable-state services + a placement interface; evaluate AgentCore as _one driver behind an adapter_, never the core (invariant #6 re-asked the moment placement exists).

| #      | Slice                        | Delivers                                                                                                                                                                                  | Builds on                               | State                      |
| ------ | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------- |
| **D1** | **Durable task RESUMPTION**  | Complete the PARTIAL — a `held` task gets picked back up (today `TaskState` records where work stopped and nothing resumes it). Also closes **AF-N1** (a resumed loop that fires nothing) | `tasks`/`orders` (durable state exists) | Not started (finding open) |
| **D2** | **Placement interface**      | One Worker identity, execution local/cloud/private as a _decision, not a UX burden_. `selectRoute` today is reachability, not placement — the word doesn't appear in source               | C2 (local), B (cloud), adapters         | Not started                |
| **D3** | **Presence as worker state** | `working/blocked/awaiting-approval/sleeping/local/cloud`, durable — today Presence is a socket class (`HOOK.conn`), not a worker's state (invariant #12's `disconnected` gap)             | `TaskState`, order status               | Partial                    |

Acceptance test: **a worker's laptop dies mid-task; it continues in cloud under the same identity, mandate and history.**

---

## Track E — verified experience (the compounding moat — LAST)

The report is explicit (§18.12): **only after verification semantics are trustworthy.** Depends on A3.

| #      | Slice                                     | Delivers                                                                                                                                                                                                | Builds on                      | State   |
| ------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------- |
| **E1** | **Verified Work History**                 | Add the **"verified" verdict** (an evaluation over a completed unit of work) + spans + a _per-worker_ history — today `GET /history` is plain-language but not per-worker and carries no verified state | A3, `events` (Work Trace)      | Partial |
| **E2** | **Artifact**                              | A durable output object (diffs, files) — today a turn produces text in an event, nothing else is stored                                                                                                 | E1                             | Absent  |
| **E3** | **Experience Record**                     | A privacy-safe reusable abstraction of a verified outcome (problem signature, procedure, evidence — **no raw CoT, secrets, or private Room context**, invariant #10)                                    | E1 + the §7.1 visibility layer | Absent  |
| **E4** | **Experience Network + Worker Directory** | Share / retrieve / rank verified records + discovery — evidence-backed, not vanity metrics                                                                                                              | E3                             | Absent  |

---

## The fabric-completion track (runs alongside A–C; gates opening to a non-Prince user)

- **Inbound screening L1 (provenance wrap) + L2 (rules + classifier)** — `services/screening/` is a one-line stub. Before untrusted external content flows to a model.
- **Egress DLP + canary seeding** — absent. **Before the first non-Prince credential exists** (the red-team ledger's explicit trigger); two credential leaks were already found in prod by accident.
- ~~**A room Door (ADR-009)**~~ — **SHIPPED** `3a6dfd4`. Scoped Room admission (creation enrols only the creator; an owner-only `admit` lets others in). The precondition for **cross-owner collaboration** — my worker + your worker in a Room without merging private context. Server-side; a web admit control + a `member.admitted` event are the remaining UI follow-ups (Codex's lane).

---

## Deliberately NOT built yet (the report's discipline)

- **Worker marketplace / broad social feed** — until verified-work quality exists (premortem rows 7–8).
- **AgentCore/Loom as the core** — only as adapters behind Harbor (premortem row 3).
- **A mobile raw shell** — the governed work surface inherits Worker identity + Mandate + policy + audit; never an internet-exposed shell.

---

## Where it stands, and what's next (updated 19 Aug, after C2)

**Done:** the whole visible product loop. Track A (A1 signed mandates, A3 receipts/chain) bar A2; Track B
complete (B1 MCP, B2 OAuth, B3 pending tags); Track C's safe-execution core (C1 gate, C2 lease) with invariant
#7 closed in the sanctioned path; the Room Door; and the x-read grokbot seam. Nine slices, all reviewed.

**The remaining work, ordered by leverage:**

1. **C3 — temporal facts object.** Small; completes Track C and makes the Drift rail's _"cannot open a PR until
   tests pass"_ real. The evaluator gains a caller-computed facts object; builds on A3 (done).
2. **The fabric-completion gates** — inbound screening (L1/L2) + egress DLP + canary. These are the real
   precondition for letting anyone but Prince use Playroom (the red-team ledger's explicit trigger).
3. **The grokbot governance slice** — wire the x-read seam into a governed cycle (mention → room → gated reply
   - receipt). Where the moat over grokbot attaches.
4. **A2** (delegation narrowing), then the downstream tracks the report sequences last: **Track D** (Harbor —
   resumption, placement, presence-as-state) and **Track E** (verified Work History → Artifact → Experience
   Record → Network).

**Activation (Prince's step):** re-sign `claude-code.json` with a host policy to turn C1/C2 live in prod
(needs the custodial key; the exact block is in `mandates/README.md`). Related:
[[playroom-c1-execution-gate]], [[playroom-c2-local-node]], [[playroom-roadmap-status-and-mcp]].
