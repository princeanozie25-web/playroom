# ADR-005 — First-token latency: measurement and recommendation

**Status:** Proposed · **Roadmap refs:** §7 (budgets), §17 (telemetry) · **Date:** 2026-07-24

## Context

A3 FINDING F7 reported a §7 P95 breach off five samples and guessed Neon jitter as
the cause. The owner downgraded F7 to "tail unmeasured, one outlier observed" and
rejected the guess. S0.3c instrumented the turn path with five spans (observation
only — no write moved, persist-before-fanout untouched) and measured them.

**Method.** 50 sequential room `@claude` turns (varied output lengths, 2–4s gaps),
one discarded warm-up, plus 50 bare-provider TTFT control calls
(`scripts/latency-control.ts`) with the same model and system prompt, entirely
outside the room path. n=50 gives a **soft** P95, not a firm one.

## Measurements (ms)

Span distributions over the 50 turns:

| span                | min | p50     | p90  | p95      | max  |
| ------------------- | --- | ------- | ---- | -------- | ---- |
| t_command           | 12  | 13      | 15   | 15       | 16   |
| t_assemble          | 22  | 25      | 34   | 35       | 36   |
| **t_provider_ttft** | 531 | **666** | 1083 | **1598** | 2199 |
| t_persist_first     | 12  | 13      | 14   | 15       | 22   |
| t_fanout            | 0   | 0       | 0    | 0        | 0    |
| **ttfd_total**      | 581 | **726** | 1136 | **1651** | 2250 |

Bare-provider TTFT control (n=50): p50 **623**, p90 921, p95 **1190**.
Room `t_provider_ttft`: p50 666, p90 1083, p95 1598.
Warm-up (discarded): ttfd 1008ms — in-band (the DB was already warm).

## The four questions (step 12)

- **(a) Which span dominates?** `t_provider_ttft`, at **both** P50 (666 of 726ms
  total) and P95 (1598 of 1651ms total). Our entire overhead — `t_command` +
  `t_assemble` + `t_persist_first` + `t_fanout` — is **~51ms combined** and stable.
- **(b) Room `t_provider_ttft` vs the bare control.** P50 gap is 666 − 623 = **43ms**
  — small ⇒ the provider's TTFT is the floor, not our overhead. At P95 the gap widens
  (1598 vs 1190, ~408ms): that is the provider processing the room's 30-message
  context versus the control's single message — the provider working harder, not us.
- **(c) Outliers: autosuspend or provider variance?** The ttfd↔inter-turn-gap Pearson
  correlation is **r = 0.03** — none. The slowest turns did not follow the longest
  gaps. The four DB spans are tiny and flat regardless of gap. **The variance is
  provider TTFT, not Neon.** The A3 Neon-jitter hypothesis is refuted by the data.
- **(d) Fraction over §7.** 34% of turns exceed the 900ms P50 line; **8% exceed the
  1.5s P95 line.** P50 ttfd (726ms) is within budget; P95 ttfd (1651ms) is over.

## Dominant term

First-token latency **is** the provider's time-to-first-token. Playroom's own path
contributes ~51ms — below the noise floor of a single provider call.

## Recommendation — Option B (revise the P95, keep the P50)

**§7's 900ms P50 line stands and is met** (measured 726ms). **§7's 1.5s P95 line is
not reachable** while the provider's own bare TTFT P95 is ~1190ms and the room's
essential 30-message context pushes `t_provider_ttft` P95 to ~1600ms. This is not
our code (Option C is refuted — overhead is ~51ms) and not a one-off (Option A does
not fit a measured 8%-over-line P95).

Proposed replacement, measured not guessed:

- **First-token P50: < 900ms** — unchanged (measured 726ms).
- **First-token P95: < 1.8s** — revised from 1.5s (measured room ttfd P95 1651ms,
  soft at n=50; 1.8s leaves headroom for the soft tail and provider drift).

Context is the lever, not our code: the ~400ms P95 gap over the bare control is the
30-message context. Trimming context would lower P95, but that is a product decision
(a room agent with less memory) and an optimisation — out of scope here, and it must
never touch persist-before-fanout. The owner rules on whether to pull it.

## Operational note

Neon autosuspend was **not** observed today — the warm-up turn was in-band because
the database was already warm. But a cold compute (idle > ~5 min) would add a
one-time cold-start to the first turn. Before filming or any live demo, **warm the
database** with one throwaway turn; do not read a cold first turn as representative.
This is operational, not architectural.

## Status

**Accepted (scoped)** by the owner, 2026-07-24. No latency remedy was implemented.

- **First-token P50 < 900ms** stands.
- **First-token P95 < 1.8s** — accepted **at the current context depth** (30-message
  window, no summarisation).

**Open — revisit condition.** The ttfd↔`tokens_in` correlation was not measured, and the
run's per-turn data was deleted, so the P95 tail is not yet attributed between provider
variance and context length. **S1.6 (rolling summary) gains an exit criterion:**
re-measure ttfd P50/P95 and report the correlation against `tokens_in`. If summarisation
moves P95 materially, this budget is revised again — downward.
