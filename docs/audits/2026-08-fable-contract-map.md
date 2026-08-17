# AUDIT-FABLE — the contract map

_The Fable report of 13 August 2026 proposes a terminology freeze. It was written without access to
this codebase, and its own §19 asks first which of those contracts already exist here under other
names. This answers that, from the code._

---

## PROGRESS

| Section                             | State                                                              |
| ----------------------------------- | ------------------------------------------------------------------ |
| Phase 0 — discovery                 | **DONE**                                                           |
| Phase 1 — the map (20 rows)         | **DONE** — 4 MATCH · 4 PARTIAL · 9 ABSENT · 3 COLLISION            |
| Phase 2 — the invariant ledger (12) | **DONE** — 6 asserted · 3 by construction · 1 claimed · 1 FALSE    |
| Phase 3 — the two questions         | **DONE** — both answered from code                                 |
| Findings / rulings                  | 2 findings carried forward · 3 rulings **RULED** (ADR-009/010/011) |

**Left to do:** nothing. Every exit criterion in the brief is met — twenty rows with file-level
evidence or ABSENT, twelve invariants bucketed with counts and denominator, both Phase 3 questions
answered from signatures, every collision on the ruling list and not the findings list, and no symbol
renamed anywhere in the repository.

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

| Report term            | Repo name                                                | Verdict                     | Evidence                                                                                                                                                                | Gap                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | -------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Worker**             | `member` + `adapter` + `route` + `principal` + `mandate` | **COLLISION** (by collapse) | `apps/api/src/members.ts` `MemberRecord`; `adapters.yaml`; `infra/migrations/009_routes.sql`; `mandates/*.json`                                                         | The repo separates five concepts the single term would merge — see RULING 3                                                                                                                                                                                                                                                                     |
| **Room**               | `room`                                                   | **PARTIAL**                 | `rooms` table (S0.3); `createRoom` in `apps/api/src/events.ts`                                                                                                          | Governed shared context: yes. Admission control: no — creation blanket-enrols every non-guest member, and the only scoped admission is a guest room code (`apps/api/src/room-codes.ts`)                                                                                                                                                         |
| **Door**               | `door` — the authenticated HTTP ingress                  | **COLLISION**               | `apps/api/src/server.ts:742` "action door: credential refused"; `apps/api/src/interrupts.ts:37` "the bare hand SCC2-N1 said the door could not raise"                   | The repo's door admits a caller to the **API**, not a member to a **Room**. See RULING 1                                                                                                                                                                                                                                                        |
| **Fabric**             | `@playroom/fabric` — the authority evaluator             | **COLLISION**               | `packages/fabric/src/evaluate.ts` `evaluate()`; `packages/fabric/src/mandate.ts`                                                                                        | The report scopes Fabric to context VISIBILITY beside authority; here it IS the authority engine and knows nothing about visibility. See RULING 2                                                                                                                                                                                               |
| **Presence**           | connection state                                         | **PARTIAL**                 | `apps/web/app/hooks.ts` `HOOK.conn` — `connected \| reconnecting \| refused`                                                                                            | A socket's state, not a worker's. No `working / blocked / awaiting-approval / sleeping`; the nearest durable equivalents are `TaskState` and an order's `status`, and neither is rendered as presence                                                                                                                                           |
| **Handoff**            | `handoff`                                                | **MATCH**                   | `apps/api/src/commands/handoff.ts` `handoffCommand`                                                                                                                     | —                                                                                                                                                                                                                                                                                                                                               |
| **Approval**           | co-signature                                             | **MATCH**                   | `apps/api/src/commands/signDecision.ts` `signDecisionCommand`; `Verdict.required_signer`                                                                                | The repo's is narrower by design (a decision a human signs), which is the report's meaning                                                                                                                                                                                                                                                      |
| **Mandate**            | `mandate`                                                | **MATCH**                   | `mandates/*.json`; `Mandate` schema in `packages/fabric/src/mandate.ts`; evaluated in `evaluate()`                                                                      | Human-legible "can always / ask first / never" is the report's UX for it; the repo has the contract, not that UI                                                                                                                                                                                                                                |
| **Harbor**             | —                                                        | **ABSENT**                  | ABSENT                                                                                                                                                                  | Nothing decides where work executes. See Phase 3 Q2                                                                                                                                                                                                                                                                                             |
| **Playroom**           | the repository itself                                    | **MATCH** (doc claim)       | `docs/architecture/playroom-architecture-bible-v1.1.md`; the monorepo root                                                                                              | The product name. Nothing in code needs to carry it                                                                                                                                                                                                                                                                                             |
| **Delegation Chain**   | `SummonChain` + the summon event's provenance fields     | **PARTIAL**                 | `apps/api/src/commands/context.ts` `SummonChain` (`rootActor`, `rootIsHuman`, `depth`, `orderId`); `apps/api/src/commands/summon.ts:349` `root_actor` / `requested_by`  | Provenance: yes, every hop records who asked and who is at the head. **Monotonic narrowing: no.** A hop is bounded by `SUMMON_DEPTH_CAP = 1` and re-evaluated against the EMITTING member's own mandate — narrower authority is not derived from the delegator's, it is looked up independently. No scope, no expiry, no evidence field per hop |
| **Local Node**         | —                                                        | **ABSENT**                  | ABSENT                                                                                                                                                                  | Nothing bridges to a user's machine. `claude-code`'s adapter does bridged work outside the fabric, which is the opposite: an unmediated boundary, disclosed rather than gated                                                                                                                                                                   |
| **Action Gateway**     | `executeCommand` + `evaluate`                            | **MATCH**                   | `apps/api/src/commands/index.ts` `executeCommand` ("any code that mutates rooms or events without passing through here is a defect"); `packages/fabric/src/evaluate.ts` | The single construction site is exactly the report's boundary. It governs REQUESTS, not host operations                                                                                                                                                                                                                                         |
| **Execution Gate**     | —                                                        | **ABSENT**                  | ABSENT                                                                                                                                                                  | There are no host operations to gate. The one place real side effects happen is `claude-code`'s bridged workspace, which no gate sits in front of                                                                                                                                                                                               |
| **Work Trace**         | the `events` table                                       | **PARTIAL**                 | `apps/api/src/events.ts`; ADR-003 (agent turns as events)                                                                                                               | An append-only per-room log with cause chains, tokens, cost and latency per turn. What is missing is the report's SPAN model: no nesting, no trace id spanning rooms, no OpenTelemetry                                                                                                                                                          |
| **Work History**       | `GET /rooms/:id/history` + the room UI                   | **PARTIAL**                 | `apps/api/src/server.ts:1092`; `apps/web/app/r/[id]/Room.tsx`                                                                                                           | The human-facing projection exists and reads in plain language. It is not per-worker and carries no verification verdict — there is no "verified" state to render                                                                                                                                                                               |
| **Artifact**           | —                                                        | **ABSENT**                  | ABSENT                                                                                                                                                                  | No durable output object. A turn produces text in an event; nothing else is stored                                                                                                                                                                                                                                                              |
| **Experience Record**  | —                                                        | **ABSENT**                  | ABSENT                                                                                                                                                                  | Nothing derives a reusable abstraction from a completed unit of work                                                                                                                                                                                                                                                                            |
| **Experience Network** | —                                                        | **ABSENT**                  | ABSENT                                                                                                                                                                  | Nothing shares, retrieves or ranks such records                                                                                                                                                                                                                                                                                                 |
| **Worker Directory**   | —                                                        | **ABSENT**                  | ABSENT                                                                                                                                                                  | Members are rows seeded by migration; there is no discovery surface, public or private                                                                                                                                                                                                                                                          |

**Twenty of twenty.** Counted: 4 MATCH (Playroom is a documentation claim, the other three are code),
4 PARTIAL, 9 ABSENT, 3 COLLISION.

**Nine ABSENT of twenty is the headline, not a gap list.** Harbor, Local Node, Execution Gate,
Artifact, Experience Record, Experience Network and Worker Directory are the report's forward half —
placement, host mediation, and the compounding network. None of it exists here, and none of it is
half-built under another name, which is the cleanest possible answer to §19's first question.

---

## PHASE 2 — the invariant ledger (§17, twelve)

A test that asserts an outcome did not occur does not count. It must assert **which rule fired**.

| #   | Invariant (abbreviated)                                                          | Bucket                                               | Evidence                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Worker identity survives model changes                                           | **TRUE BY CONSTRUCTION**                             | `members.adapter_id` is a column, not the identity. `migrations/007` makes `id` the primary key and the adapter a reference validated at the seam (`apps/api/src/members.ts:143`). Changing which model a member runs is an UPDATE to one column; nothing else moves. `claude-audit` shares claude-main's model and is a different member, which is the same property from the other side |
| 2   | Room membership must not imply access to all private context                     | **ASSERTED BY TEST**                                 | `apps/api/test/assembly-parts.test.ts:82` — `expect(privateParts.map((d) => d.source)).toEqual(['own-store'])`. It names the rule (exactly one part is principal-scoped), not merely that a leak did not happen                                                                                                                                                                           |
| 3   | Authority external to the model, attributable to a principal                     | **ASSERTED BY TEST**                                 | `apps/api/test/action-channel.test.ts` — an out-of-scope emission is BLOCK by `OUT_OF_SCOPE`, "and provably NOT because the tool was unexposed". The verdict carries `effective_mandate_hash`, which is the attribution                                                                                                                                                                   |
| 4   | Delegated authority must not silently expand                                     | **ASSERTED BY TEST**, narrower than the report means | `apps/api/test/summon-boundary.test.ts`; `SUMMON_DEPTH_CAP = 1` (`commands/summon.ts:53`) and re-evaluation against the emitting member's own mandate. It cannot expand because it is not inherited at all — see the Delegation Chain row. The report's monotonic-narrowing invariant is not what is asserted here                                                                        |
| 5   | High-impact actions support explicit approval gates                              | **ASSERTED BY TEST**                                 | `apps/api/test/decision-execution.test.ts` — a protected summon writes a DECISION and NO summon; the approval fires exactly the held summon, once                                                                                                                                                                                                                                         |
| 6   | Execution placement must not change semantic identity                            | **TRUE BY CONSTRUCTION, vacuously**                  | There is no placement (Phase 3 Q2). An invariant nothing can violate is held, but it is held by absence and would need re-asking the moment Harbor exists                                                                                                                                                                                                                                 |
| 7   | Local access mediated through a trusted node rather than an unrestricted shell   | **FALSE TODAY**                                      | `infra/migrations/024_claude_code_member.sql`, in the repo's own words: `claude-code` "invokes a coding agent whose side effects are real, in a scratch workspace, OUTSIDE the fabric… its PARTICIPATION is governed; its WORK is bridged, not governed". Disclosed in the red-team ledger, not mediated. This is the one invariant the repo openly does not hold                         |
| 8   | Every consequential action produces an auditable event                           | **ASSERTED BY TEST**, for one class                  | `tests/evidence.test.ts:209` pins `appendAgentEvent` to a single caller. ADR-003 makes turns events. What is NOT asserted is the general claim across all consequential actions — a governed ALLOW writes no decision event by design, and that is a deliberate hole in the sentence rather than in the code                                                                              |
| 9   | Observability vendors must not own Playroom semantics                            | **TRUE BY CONSTRUCTION**                             | No vendor is integrated. No OpenTelemetry, no LangSmith, no exporter anywhere in `apps/` or `packages/`. Held by absence                                                                                                                                                                                                                                                                  |
| 10  | Public Experience Records derived from verified outcomes, not raw reasoning      | **CLAIMED, UNASSERTED**                              | Nothing exists to hold or violate it (three ABSENT rows). Recorded as claimed rather than true-by-construction because it is a rule about a thing that does not exist yet                                                                                                                                                                                                                 |
| 11  | Provider neutrality real at the Worker contract                                  | **ASSERTED BY TEST**                                 | `adapters.yaml` is the only file naming a provider, and `tests/evidence.test.ts:244` (§21.2) forbids a hardcoded member id or summon token in the room or the api. `sol` runs on a second provider precisely so the claim has a witness                                                                                                                                                   |
| 12  | Failure, blocked, disconnected and awaiting-human are first-class durable states | **ASSERTED BY TEST**, partially                      | `TaskState` is a column: `held` and `input-required` are rows, not log lines, and `apps/api/test/agent-error.test.ts` asserts `completed{success:false}` with an `error_class` and no hang. DISCONNECTED is the exception — the connection state is a UI class (`HOOK.conn`), not durable, so a member's presence does not survive a restart                                              |

**Counts, denominator twelve:** ASSERTED BY TEST **6** · TRUE BY CONSTRUCTION **3** ·
CLAIMED, UNASSERTED **1** · FALSE TODAY **1**. Two of the six carry a stated caveat (4 and 12), and
one of the three is vacuous (6).

**The one that matters is #7.** It is false, it is false on purpose, and the repo says so in the
migration that created the member which makes it false. Everything else in this ledger is either held
or honestly unbuilt.

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
- `apps/api/test/budget-meter.test.ts` — the hello frame's `room_spent_usd` equals `roomSpend` for
  that room. **Still unexplained.** Seen once. It reads a room-scoped spend total while other files
  write spend in parallel, which is a different shape from the above and is not accounted for.
  _Trigger: its second sighting — at which point it gets read rather than retried, exactly as the
  first one should have been sooner._

**The lesson is the finding.** Four retries went by before anyone looked, and "it's flaky" was the
story each time. A suite that fails at random teaches people to re-run rather than to read, and one
of these two was a genuine defect the whole time.

**AF-N4 — an assertion whose truth depends on database state a fresh CI run would not have.**
Two instances, both mine, both in SU-2, both green locally and red in CI on the pushed head:

- `document-delivery.test.ts` asserted the assembled part set EQUALS
  `{briefing, common-ground, own-store}`. `own-store` appears only when the principal has stored
  context. My development database has rows; a fresh one does not.
- the same file asserted "the parts naming a principal EQUAL `['own-store']`", proving a claim about
  documents BY ELIMINATION. With an empty store that list is `[]`, so the assertion was false in CI
  and, worse, was passing locally for a reason unrelated to what it claimed.

**The class is the finding, not the two instances.** An exact-set assertion over query results is
only as true as the rows that happen to exist, and the machine that writes the test is the machine
least likely to notice. Both are rewritten to assert the claim directly — subset containment plus a
positive control that the window is not empty, and the documents parts checked for a null principal
on their own rather than by elimination.

_Trigger: the next test asserting an exact set over query results._ Also: run a suite against a fresh
database before calling it green, because CI catching this after a push is a slower loop than
catching it before — and the push that carried it turned main red.

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

---

## AUDIT CLOSED — 16 August 2026

**The order was stopped because the work was complete.** `ord_2c2c227801a242c9`, revoked at 3 of its
6 cycles with three left unrun, because closeout 2 reported every exit criterion met and a human read
this document.

**That is the first order in this system to stop because it was done**, and the distinction is worth
writing down precisely because the order could not know it. Every terminal an order can reach on its
own — LIMIT_REACHED, EXPIRED — counts something; none of them means finished. **ST-N1 stays open.**
The only thing that ended this one is a person deciding it had.

Final numbers for the room, denominators included:

|            |                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Orders     | 3 created, 3 revoked — the first for an impossible task, the second for a task its member could not perform, the third because the work was done |
| Cycles     | **9 counted, 9 worked** across the room's life — the S-CYCLE invariant held on live traffic                                                      |
| This order | 3 of 6 cycles                                                                                                                                    |
| Voice      | 3 of `claude-audit`'s 6 interrupts spent; 3 notifications, all delivered                                                                         |
| Cost       | $0.047560 over 12 turns                                                                                                                          |

**Access retired.** `cred_354a26e4289771d8` revoked and read back from the database, not from a
success message. Live credentials on production: **5 of 9 issued before, 4 of 9 after.** The same
token now gets HTTP 401 at the door. Its label carried its own exit condition, which is why it was
found rather than remembered.

---

## THE RULINGS — ALL THREE RULED, 16 AUGUST 2026

**All three are decided, and all three resolve to the repository keeping its vocabulary.** Each is
recorded as an ADR, because a ruling that lives only in an audit document gets re-litigated by
whoever reads the report next without this map beside them. Nothing in the map above changed: a
ruling about what to call things does not revise what the audit found.

| Ruling           | Decision                                                                                                                                                                                                       | ADR                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **1 — `Door`**   | **Keep both, distinguished by adjective.** "The API door" admits an external caller to the API; "a room door" would admit a member to a Room and does not exist yet. Same kind of boundary at different scopes | [ADR-009](../decisions/ADR-009-door-is-two-boundaries-at-two-scopes.md)     |
| **2 — `Fabric`** | **The repo's meaning stands; the report adopts it.** `@playroom/fabric` is the authority engine and is a package name in 20+ imports, against a report implemented nowhere                                     | [ADR-010](../decisions/ADR-010-fabric-is-the-authority-engine.md)           |
| **3 — `Worker`** | **A product-surface word only, mapping to `member` in code.** The mandate precedent inverted — and asserted mechanically, so it is enforced rather than remembered                                             | [ADR-011](../decisions/ADR-011-worker-is-a-product-word-not-a-code-word.md) |

Each ADR carries its own reconsideration trigger: room admission being built, the report being
implemented under its own vocabulary, and `worker` appearing in source — the last of which is a test.

**THE FABLE REPORT IS AN INPUT DOCUMENT WHOSE VOCABULARY THIS REPOSITORY DOES NOT ADOPT.** It was
read, mapped and answered; it does not govern. `docs/reports/2026-08-13-fable-consolidated-report.md`
is committed unedited for exactly that reason — so the reading stays checkable — and a reader who
meets `Door`, `Fabric` or `Worker` there should read the three ADRs before using any of them in a
brief, a comment or a schema.

The original statement of the collisions, with the options and their costs, is kept below unchanged.

| Ruling           | State               | What it blocks until ruled                                                                                                        |
| ---------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **1 — `Door`**   | **RULED** → ADR-009 | It blocked the terminology freeze: any document saying "door" was ambiguous between the API ingress and a room admission boundary |
| **2 — `Fabric`** | **RULED** → ADR-010 | It blocked adopting the report's diagram as written, since `@playroom/fabric` is an import path in 20+ files                      |
| **3 — `Worker`** | **RULED** → ADR-011 | It blocked product-surface vocabulary work: "Worker" in a spec silently collapsed member, principal, adapter, route and mandate   |

**No ADR is written by this slice**, and that is the correct outcome rather than an omission: an ADR
records a decision, and no decision has been made. When a ruling fixes a term's meaning permanently,
it needs one — a ruling that lives only here will be re-litigated by whoever reads the report next
without this map beside it. The options and their costs are stated above, unchanged and unacted-on.
