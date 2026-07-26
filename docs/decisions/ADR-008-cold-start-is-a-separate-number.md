# ADR-008 — Cold start is a separately measured, separately published number

**Status:** Proposed · **Refs:** Bible §11 (budgets), §17 (telemetry), §19 (drift) · **Supersedes nothing; extends ADR-005** · **Date:** 2026-07-26

## Context

Two findings sat at opposite ends of one wire:

- **A4-F9** — a suspended Neon compute costs a wake on the first query.
- **S04-N1** — a cold provider connection costs a TLS handshake on the first turn.

Postgres is **on** the first-token path by persist-before-fan-out (ADR-003), so the premise
going in was that on the first summon after a quiet night the two do not alternate — they
**compound**, to ~2.5s against ADR-005's P50 of 900ms and P95 of 1.8s: inside §11's 3s
ceiling, so nothing broken, and over a budget that is written down, on exactly the request a
pilot makes at nine in the morning.

**The measurements do not support that premise, and both of its terms were wrong.** The
provider half is ~40–120ms at P50, not +1 to +1.5s. And the database wake is charged to the
room fetch or the socket connect — both of which query Postgres before a member can send
anything — so it does not land on the summon at all. The compound figure this slice was
scoped around is not a thing that happens. The warm-up is still worth having, for reasons the
measurements do support: the provider tail, and the wake landing on a page load instead of
being paid by nobody. Recorded this way round because a slice that quietly delivers a fix for
a problem it disproved has published a number nobody checked.

ADR-005 left this as an operational note: _"before filming or any live demo, warm the
database with one throwaway turn."_ A note is not a mechanism and it is not a number.

**The decision this ADR exists to prevent** is publishing a comfortable warm figure while a
real user waits seconds. That is the same failure as a drift query reading zero over an
empty log (RA-004): an instrument that is green because it is looking away. So the warm-up
is built **and** both numbers are measured.

## Method

Everything below is measured against live providers and the live database on 2026-07-26.

- **Warm path.** `scripts/latency-room.ts warm 50` — n=50 **per enabled member** (100 turns
  total), through the real room path: live server, real WebSocket, command layer, event log.
  `ttfd` is measured client-side from the send frame leaving to the first delta of **that
  turn** arriving, so it includes persist-before-fan-out. Turns run one at a time and each
  is driven to `agent.turn.completed` before the next is sent. Warm-up run and awaited first.
- **Control.** `scripts/latency-control.ts 50 <member>` — n=50 per member, bare SDK, no room
  path, same model and system prompt. Generalised in this slice to take a member id; it
  previously measured only the first member while being called "the control".
- **Cold.** One turn on a fresh process after the database had idled past autosuspend. n=1
  per run by necessity — a second sample would be a warm one.
- **Idle window: 12 minutes 30 seconds, with the whole stack down and nothing else touching
  the database.** A4's probe put the threshold under 5 minutes (4m20s → +67ms; 7m38s →
  +600ms), so this is unambiguously past it. Stated because "cold" without a window is not
  a measurement.
- **The database wake is timed separately**, as `SELECT 1` on a fresh pool before anything
  else touches Postgres. This is not tidiness: creating the room — or merely connecting the
  socket — issues a query that **absorbs** the wake, after which the turn sees a warm
  database and reports a comfortably small number. The measurement would have destroyed the
  thing it was measuring.

Two harness bugs were found and fixed before any number here was trusted; both produced
plausible numbers rather than errors, which is why they are recorded rather than quietly
corrected. (1) Resolving on "the first delta seen" measured **41ms** for the second member —
the socket replayed the first member's deltas and the stopwatch stopped on somebody else's
token. (2) Waiting only for the first delta sent the next summon while the previous turn was
still streaming, which §22b correctly refuses; it surfaced as a timeout fifteen turns in.

## Measurements

### Warm path, n=50 per member (ms, client-observed ttfd)

| member          |   n | min |     p50 |  p90 |      p95 |  max |
| --------------- | --: | --: | ------: | ---: | -------: | ---: |
| **claude-main** |  50 | 553 | **764** | 1446 | **1742** | 1826 |
| **sol**         |  50 | 471 | **530** |  654 |  **698** | 3224 |
| both            | 100 | 471 | **641** | 1188 | **1505** | 3224 |

Against ADR-005's budget (P50 < 900ms, P95 < 1.8s): **met, per member and combined.**

- Over the 900ms P50 line: claude-main 16/50 (32%), sol 2/50 (4%), combined 18%.
- Over the 1.8s P95 line: 1/50 each, 2/100 combined.
- **claude-main's P95 has 58ms of headroom.** That is the number to watch, not the pass.

### Bare-SDK control, n=50 per member (ms)

| member      | min | p50 |  p90 |  p95 |  max |
| ----------- | --: | --: | ---: | ---: | ---: |
| claude-main | 446 | 644 | 1160 | 1957 | 4292 |
| sol         | 420 | 501 |  711 |  773 |  883 |

**Playroom's own overhead is the P50 gap: +120ms (claude-main), +29ms (sol).** That is
consistent with ADR-005's ~51ms and confirms its dominant-term finding — first-token
latency is the provider's time-to-first-token, and our path is below the noise floor of a
single provider call.

**The P95 comparison is not usable and is not used.** Both room P95s come out _below_ their
controls (1742 vs 1957; 698 vs 773), which would be nonsense as a claim about overhead. At
n=50 the P95 is the 48th of 50 samples, and the control's claude-main max of 4292ms is one
outlier moving it several hundred milliseconds. The honest statement is that the two
distributions' tails are indistinguishable at this n. ADR-005 read a ~400ms room-over-control
P95 gap as context cost; at n=50 per member that gap does not reproduce, and neither sign of
it should be treated as established.

### Idle-gap correlation

Pearson r between inter-turn gap and ttfd across the 100 warm turns: **r = −0.096** — none.
ADR-005 measured r = 0.03 on 50 turns. The warm-path variance is provider variance; it is
not the database, and it is not idle-related **once warm**. Which is precisely why cold has
to be its own measurement rather than a tail of this one.

### Cold, after a 12m30s idle (claude-main, n=1 per run — a second sample would be warm)

| run                         | db wake (isolated) | turn ttfd | warm-up |     sum |
| --------------------------- | -----------------: | --------: | ------: | ------: |
| **cold, no warm-up**        |          **754ms** | **749ms** |       — | 1,503ms |
| **cold, warm-up run first** |          **965ms** | **729ms** |   863ms | 1,694ms |

Warm-up breakdown on the second run: database 24ms, claude-main 283ms, sol 847ms
(concurrent, so 860ms total is the slowest target, not the sum).

**THE BINARY EXIT IS MET.** With the warm-up run, the first real summon landed at **729ms** —
inside the warm P95 of 1,742ms with 1,013ms to spare, and inside the warm **P50** of 764ms.
That is the only claim the film depends on.

**Three things about these numbers must be read precisely, because the obvious reading of
each is wrong.**

**1. The wake and the turn were never paid by the same request, and the sum is a constructed
upper bound rather than an observed figure.** The `SELECT 1` probe that isolates the wake also
_performs_ it, so the turn that follows always sees a woken database. This is not a flaw that
better sequencing fixes — it is what the code does too, and that is the second point.

**2. IN THE REAL PATH THE WAKE LANDS ON THE ROOM FETCH OR THE SOCKET CONNECT, NOT ON THE
SUMMON.** `GET /rooms/:id` queries Postgres, and the WebSocket route queries it again to
confirm the room exists before the socket is usable (the RT-001 fix). Both happen before a
member can send anything. So the ~750–965ms wake is charged to opening the room, and the
first summon then runs against a warm database — which is exactly what the 749ms cold-turn
figure shows. **The ~2.5s compound on a single first-token measurement, which is what this
slice was scoped around, does not occur.** The member still waits for the wake; it simply is
not the first-token budget that it breaches, and §11's first-token row was never the row at
risk.

**3. The provider half is small.** A cold process with no warm-up produced a 749ms turn
against a warm-path P50 of 764ms — indistinguishable. The connection cost that S04-N1 put at
+1 to +1.5s is, measured, ~40–120ms at P50 (see the mode probe in S05c-1). The warm-up's
value on the provider side is at the **tail**, not the median: the mode probe moved sol's P90
from 1,214ms to 593ms.

**Two wake samples, 754ms and 965ms, on identical 12m30s windows.** A4-F9 measured ~657ms at
7m38s. Three samples across three sessions, spread 657–965ms, is enough to say the wake is
several hundred milliseconds and not enough to give it a percentile. It is reported as a
range, and `turn_rows`-style honesty applies: n=3 is not a distribution.

## Decision

1. **§11's rows are WARM-PATH budgets.** They are met on the warm path and that is what they
   assert. This is not a loosening: it is saying out loud what §11 already measured, since
   ADR-005's fifty turns were warm turns and its P95 revision was a warm number.
2. **Cold start is a separate number, published separately.** It is never averaged into the
   warm distribution, never smoothed by a percentile over mixed populations, and never
   omitted because a warm-up exists. A cold number that no longer appears is not a cold
   number that no longer happens.
3. **The warm-up is a primitive, not a schedule.** `warmUp()` warms the database and every
   enabled adapter; it runs at boot and is callable at `POST /internal/warmup` so the capture
   harness can warm **the process that will serve the recording** — connection state is
   per-process, so a script warming its own sockets would help nobody.
4. **Connection-only, and it costs nothing.** Measured against a `max_tokens=1` escalation;
   the escalation was indistinguishable and would have spent ~11 tokens per member per
   warm-up. `warm()` performs a model-catalogue read: a real authenticated request on the
   same client the turn will use, no completion, **zero tokens**. A warm-up that bills a
   principal for a handshake would be a worse thing than a slow first turn.
5. **S04-N1 is corrected, not carried forward.** It attributed ~+1 to +1.5s to "TLS handshake
   and client init". Client construction measures **1ms** — init is not the cost — and the
   connection cost is ~40–120ms at P50 and ~130–620ms at the tail. The provider half of the
   compound was overstated by roughly an order of magnitude. The database half is the larger
   term.

## What re-opens this

- **The assembly window changes** (summarisation, per-principal stores in S1.5, any change to
  the 30-message cap). ADR-005's scope condition, inherited: these numbers are at current
  context depth.
- **A second region, or any deployment where the database is not one hop away.** Every number
  here was measured against Neon in eu-west-2 from one machine.
- **claude-main's P95 crosses 1.8s** on any subsequent run. It sits 58ms under.
- **A managed or pooled Postgres without autosuspend.** The cold database term disappears and
  the compound argument changes shape.
- **Any warm-up mechanism that costs tokens.** That would make `POST /internal/warmup` a way
  to spend money unauthenticated, and the endpoint's acceptance rests on it not being one.
- **The first pilot, or the first deploy during a live turn** — S05c-N1: this is a primitive
  and nothing calls it on a timer, so a process that has been idle for hours is cold again.

## Findings raised

- **S05c-N1** — no keep-alive. The warm-up is paid at boot and never again, so a quiet
  afternoon leaves the connections cold. Deliberately not built: a timer calling this
  primitive is S2.9's work, and building the schedule before the pilot exists is guessing at
  an interval. **Trigger:** the first pilot, or the first deploy during a live turn.
- **S05c-N2** — **§11's fan-out row is measured by an instrument that cannot fail.** ADR-005
  reports `t_fanout` at P50 0ms, P90 0ms, P95 0ms. That is true and it is not the budget:
  §11's row is "message fan-out to room **members**", and the measured span ends when the
  server hands the frame to an in-process EventEmitter (ADR-002), before any socket write,
  any network hop, or any client. A P95 of zero is the same shape as a drift query reading
  zero over an empty log — green because the instrument is looking at something that cannot
  be slow. **Trigger:** ADR-002's swap to Redis pub/sub, or the first non-localhost client,
  whichever is first. At that point the span has to be redefined to end at client receipt.
- Rows of §11 that are **not yet measurable** because the thing does not exist: inbound
  screening (both rows), route selection, receipt sign and append, interrupt push, GitHub
  webhook, projection round trip, and audit append — §19's hash-chained `audit` table is not
  built, so the 10ms/20ms row has nothing to time. Recorded so their silence is not mistaken
  for a pass. Mandate evaluation **is** measured and asserted in CI: P50 0.0015ms, P95
  0.0021ms over n=2000, against a 10ms/30ms budget.
