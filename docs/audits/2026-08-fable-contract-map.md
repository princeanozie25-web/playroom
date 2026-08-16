# AUDIT-FABLE — the contract map

_The Fable report of 13 August 2026 proposes a terminology freeze. It was written without access to
this codebase, and its own §19 asks first which of those contracts already exist here under other
names. This answers that, from the code._

---

## PROGRESS

| Section                             | State                                                       |
| ----------------------------------- | ----------------------------------------------------------- |
| Phase 0 — discovery                 | **DONE**                                                    |
| Phase 1 — the map (20 rows)         | **9 of 20** — the three suspected collisions resolved first |
| Phase 2 — the invariant ledger (12) | not started                                                 |
| Phase 3 — the two questions         | **DONE** — both answered from code                          |
| Findings / rulings                  | 2 findings, 3 rulings, open                                 |

**Left to do:** eleven map rows (Mandate, Delegation Chain, Harbor, Local Node, Action Gateway,
Execution Gate, Work Trace, Work History, Artifact, Approval, Experience Record, Experience Network,
Worker Directory, Playroom), then the twelve-invariant ledger.

---

## PHASE 0 — the state this audit ran against

|                     |                                                                                  |
| ------------------- | -------------------------------------------------------------------------------- |
| Head at start       | `24af44c` (SC-3), tree clean, CI green                                           |
| Report committed as | `886ddea` — `docs/reports/2026-08-13-fable-consolidated-report.md`, unedited     |
| Denominators        | 339 tracked files · 209 `.ts`/`.tsx` · 89 test files · 71 under `apps/api/test`  |
| Suite               | 89 of 89 green (AF-N2: one intermittent failure left, one was a real regression) |

**§15 has TWENTY rows, not eighteen.** The brief's enumeration omits `Playroom` and
`Experience Network`, and both are rows in the table. Counted firsthand from the committed file. §17
has twelve invariants, as the brief says. This map therefore carries twenty rows.

### The repo's own vocabulary, before comparing anything

Identity and authority, as **types, tables or files** — not as prose:

| Concept                                           | Where it is real                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `principal`                                       | table (migration 007); `members.principal_id` NOT NULL REFERENCES it                                          |
| `member`                                          | table (007) + `MemberRecord` (`apps/api/src/members.ts`); `kind` is `human` or `agent`                        |
| `adapter`                                         | `adapters.yaml` + `AdapterConfig` (`packages/adapters/src/registry.ts`) — the only file that names a provider |
| `route`                                           | table (009) + `selectRoute` (`apps/api/src/routes.ts`) — how a member is reached                              |
| `mandate`                                         | `mandates/*.json` + `Mandate` zod schema (`packages/fabric/src/mandate.ts`)                                   |
| `scope`, `protected_actions`, `co_sign`, `limits` | fields of that schema                                                                                         |
| `decision`                                        | table + `Verdict` (`packages/fabric/src/evaluate.ts`)                                                         |
| `summon`                                          | event type + `fireSummon` (`apps/api/src/commands/summon.ts`)                                                 |
| `task`                                            | table + `TaskState` (`apps/api/src/tasks.ts`): `submitted \| working \| input-required \| held \| done`       |
| `standing order`                                  | table (021) + `OrderRow` (`apps/api/src/orders.ts`)                                                           |
| `interrupt`                                       | table + `raiseInterrupt` (`apps/api/src/interrupts.ts`)                                                       |
| `promotion` / `briefing`                          | `room_briefings` (026) + `apps/api/src/briefings.ts`                                                          |
| `credential`                                      | `member_credentials` + `authenticate` (`apps/api/src/credentials.ts`)                                         |
| `claim`                                           | **not a type.** Prose only — "a claim on attention" describes an interrupt                                    |
| `host`                                            | **not a type.** No such concept in code                                                                       |

---

## PHASE 1 — the map

Evidence is a file path and symbol, or the word ABSENT. A row citing a document rather than code is
labelled **(doc claim)**.

| Report term  | Repo name                                                | Verdict                     | Evidence                                                                                                                                              | Gap                                                                                                                                                                                                   |
| ------------ | -------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Worker**   | `member` + `adapter` + `route` + `principal` + `mandate` | **COLLISION** (by collapse) | `apps/api/src/members.ts` `MemberRecord`; `adapters.yaml`; `infra/migrations/009_routes.sql`; `mandates/*.json`                                       | The repo separates five concepts the single term would merge — see RULING 3                                                                                                                           |
| **Room**     | `room`                                                   | **PARTIAL**                 | `rooms` table (S0.3); `createRoom` in `apps/api/src/events.ts`                                                                                        | Governed shared context: yes. Admission control: no — creation blanket-enrols every non-guest member, and the only scoped admission is a guest room code (`apps/api/src/room-codes.ts`)               |
| **Door**     | `door` — the authenticated HTTP ingress                  | **COLLISION**               | `apps/api/src/server.ts:742` "action door: credential refused"; `apps/api/src/interrupts.ts:37` "the bare hand SCC2-N1 said the door could not raise" | The repo's door admits a caller to the **API**, not a member to a **Room**. See RULING 1                                                                                                              |
| **Fabric**   | `@playroom/fabric` — the authority evaluator             | **COLLISION**               | `packages/fabric/src/evaluate.ts` `evaluate()`; `packages/fabric/src/mandate.ts`                                                                      | The report scopes Fabric to context VISIBILITY beside authority; here it IS the authority engine and knows nothing about visibility. See RULING 2                                                     |
| **Presence** | connection state                                         | **PARTIAL**                 | `apps/web/app/hooks.ts` `HOOK.conn` — `connected \| reconnecting \| refused`                                                                          | A socket's state, not a worker's. No `working / blocked / awaiting-approval / sleeping`; the nearest durable equivalents are `TaskState` and an order's `status`, and neither is rendered as presence |
| **Handoff**  | `handoff`                                                | **MATCH**                   | `apps/api/src/commands/handoff.ts` `handoffCommand`                                                                                                   | —                                                                                                                                                                                                     |
| **Approval** | co-signature                                             | **MATCH**                   | `apps/api/src/commands/signDecision.ts` `signDecisionCommand`; `Verdict.required_signer`                                                              | The repo's is narrower by design (a decision a human signs), which is the report's meaning                                                                                                            |
| **Mandate**  | `mandate`                                                | **MATCH**                   | `mandates/*.json`; `Mandate` schema in `packages/fabric/src/mandate.ts`; evaluated in `evaluate()`                                                    | Human-legible "can always / ask first / never" is the report's UX for it; the repo has the contract, not that UI                                                                                      |
| **Harbor**   | —                                                        | **ABSENT**                  | ABSENT                                                                                                                                                | Nothing decides where work executes. See Phase 3 Q2                                                                                                                                                   |

_Rows still to write: Playroom, Delegation Chain, Local Node, Action Gateway, Execution Gate, Work
Trace, Work History, Artifact, Experience Record, Experience Network, Worker Directory._

---

## PHASE 3 — the two targeted questions

### 1. Can the evaluator express a condition over prior events? **No.**

From the signature, not from a document:

```ts
// packages/fabric/src/evaluate.ts
export function evaluate(
  action: ActionRequest,
  member: string,
  mandate: LoadedMandate | undefined,
  now: Date = new Date(),
  roomRoster?: readonly string[],
): Verdict;
```

It receives the request, the member id, the mandate document, a clock, and optionally the room's
roster. **It receives neither the event log nor any projection of it**, and it has no pool, no query
and no I/O — it is a pure function. There is no input in which "event X happened earlier in this room"
could be expressed, so a Dogwood-style temporal condition is not merely unwritten, it is
unexpressible without a new parameter.

**What it would need:** a projection, not the log. The log is unbounded and the evaluator sits inside
a <10ms budget (§11); handing it a pool would make every authority decision an I/O operation. The
minimum honest addition is a caller-computed facts object — "tests passed at seq N", "no unresolved
regression" — assembled by the caller and passed in, keeping `evaluate` pure and keeping the
projection's cost where the caller can see it.

**The nuance that matters:** history-aware refusal DOES exist in this repo — it is just not in the
fabric. `fireOrderCycle` refuses on the spend sum, on the interrupt budget, on an expiry and on
counts, all read from the event log before a cycle opens
(`apps/api/src/commands/runOrders.ts`). So the capability lives in the runner and not in the
evaluator, and the two have never been joined.

### 2. Does anything decide where work executes, or hold durable task state? **Split.**

**Placement: ABSENT.** Nothing in the repo chooses a runtime. `selectRoute`
(`apps/api/src/routes.ts`) picks the first non-unavailable route for a member and every route in the
database is `type: 'hosted'`; the function's own reason code for success is `only_available_route`.
That is reachability, not placement. The word "placement" does not appear in the source.

**Durable task state: PRESENT.** `tasks` is a table, and `TaskState` is
`submitted | working | input-required | held | done` (`apps/api/src/tasks.ts`). It survives a restart
because it is a row, and `held` carries the error class that stopped it. What is absent is
_resumption_: nothing picks a `held` task back up — the state records where work stopped and implies
nothing about continuing, which the source says in those words.

---

## FINDINGS (repo problems — each with the trigger that makes someone act)

**AF-N1 — a paused self-triggering order cannot be restarted from the phone.** `controlOrder`'s
resume writes `status = 'ACTIVE'` and fires nothing (`apps/api/src/commands/order.ts`). In a
self-triggering loop the last completion has already happened, so after an attendance pause the order
sits ACTIVE waiting for a trigger that never comes. Resuming looks like it worked and does nothing.
_Trigger: the first time someone resumes a loop from the notification and finds nothing happened._

**AF-N2 — one intermittent failure remains, and one was a real regression that is now fixed.** Five
commits on 15–16 Aug needed a bare retry. Two different files were caught, and they turned out to be
two different things:

- `apps/api/test/order-firing.test.ts` — **NOT flaky. A real S-CYCLE regression, fixed here.** When
  it failed twice consecutively it stopped looking random and got read instead of retried. The cycle
  count now lands when a turn STARTS, so `cycleCount >= 1` is true while the member is still
  answering; the test fired its next trigger into that window, the runner correctly DEFERRED it, and
  the count never reached 2. The test was asserting on the wrong signal. It now waits for the
  completed turn — which is also what a trigger IS — and passes three consecutive runs.
- `apps/api/test/budget-meter.test.ts > the hello frame's room_spent_usd equals roomSpend for that
room` — **still unexplained.** Seen once. It reads a room-scoped spend total while other files
  write spend in parallel, which is a different shape from the above and is not accounted for.
  _Trigger: its second sighting — at which point it gets read rather than retried, exactly as the
  first one should have been sooner._

**The lesson is the finding.** Four retries went by before anyone looked, and "it's flaky" was the
story each time. A suite that fails at random teaches people to re-run rather than to read, and one
of these two was a genuine defect the whole time.

---

## RULINGS (Prince only — stated, not resolved, and not acted on)

**RULING 1 — `Door`.** The repo already uses the word for the authenticated ingress an external
caller reaches (`server.ts`, `interrupts.ts`), which admits a caller to the API. The report means an
admission boundary into a Room, requesting scoped membership. Same word, two boundaries.

- Keep both, distinguished by adjective ("the API door" / "a room door"): costs nothing today, and
  guarantees the ambiguity is argued about later in code review rather than now.
- Rename the repo's usage: it is prose and comments only — no symbol is named `door` — so the edit is
  cheap. It rewrites S2.1b's and SCC-3's own vocabulary in commits that explain themselves with it.
- Rename the report's: the report is an input document, not code.

**RULING 2 — `Fabric`.** In this repo Fabric is the authority engine: `packages/fabric` exports
`evaluate` and `Mandate` and nothing about visibility. The report places Fabric _beside_ authority as
the information-flow layer. This is the sharpest of the three, because the repo's Fabric is a
**package name** — a symbol, an import path, in 20+ files.

- Keep the repo's meaning and change the report's: the report is not yet implemented anywhere.
- Adopt the report's meaning: renames a package and every import of it, and ADR-006 already ruled a
  rename of this size prohibitive once (permit→mandate).
- Split: `@playroom/fabric` keeps authority, a future visibility layer takes another name. The cost is
  that the report's diagram no longer matches the tree.

**RULING 3 — `Worker`.** Not a word collision: `worker` appears nowhere in the source (one hit, and it
means a browser service worker). It is a **collapse**. The report's single Worker would merge five
things this repo deliberately keeps apart — `member` (identity), `principal` (whose authority),
`adapter` (which provider and model), `route` (how it is reached), `mandate` (what it may do). The
separation is load-bearing: S-CYCLE minted `claude-audit` as a new member on the SAME adapter as
`claude-main` precisely so it would have its own interrupt budget, which is a distinction "Worker"
cannot express.

- Freeze `Worker` as a product-surface word only, mapping to `member` in code.
- Freeze it as a contract, and accept that five repo concepts now need a stated relationship to it.
- Do not freeze it; keep `member` everywhere.
