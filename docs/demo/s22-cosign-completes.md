# S2.2 — the co-sign completes: the card goes live, and the loop's heartbeat

**No film change. Take 13 stands.** S2.2 gave the decision a lifecycle and a completable co-signature:
a paused CO_SIGN decision can now be approved or denied by the required human, and an approval releases
its action exactly once. This is the record of the last commit — the card going live, the loop's
heartbeat captured, and the latency of the release path. Local build (deploy still billing-blocked).

## The card goes live — for the signer, and only the signer

The Approve/Deny buttons were inert and labelled "S2.2". They are now live, but the S2.2 rule is written
into who can press them:

- **The required signer** — the human bound to the decision's required principal — sees live buttons.
  Clicking sends a `sign_decision` frame carrying only the decision id and the answer; WHO is signing is
  the socket's authenticated member, which the server reads for itself.
- **Everyone else** sees the buttons inert, with the signer named ("Awaiting Prince"). An agent never
  sees a live button — and even a forged frame is refused server-side, because the check is against the
  authenticated member's kind and principal, not the frame. The affordance is a courtesy; the
  authorisation is `commands/signDecision.ts`.
- **Once answered**, the card shows the outcome in place of the buttons ("Approved by Prince") — the
  same card, now resolved, never a second one. `decision.resolved` mutates the card in place, the same
  discipline as an interrupt lowered in place.

## The heartbeat, verified live in the browser

With a designated member's `summon.initiate` marked protected (a mandate override; the shipped mandates
are unchanged), the full loop was driven end to end in the running app and observed in the room:

1. **claude-main emits a protected summon of sol** → it does not fire. A CO_SIGN decision appears
   (`summon.initiate`, "Needs a signature from Prince"), and a DECISION interrupt lands ("summon.initiate
   needs a signature").
2. **Prince — the required signer — sees live Approve/Deny buttons** (an agent, or any non-signer, would
   see them inert).
3. **Prince clicks Approve** → the card resolves to **"Approved by Prince" in place**, and the server
   logs `decision resolved`.
4. **The held summon fires** → a summon row appears (claude-main → sol), and **sol takes its turn** — a
   real reply ("I see that Claude-main wants to bring Sol in…", 265→50 tok). The chain continues.

That is the sentence from the deck made real: **paused until a named human signs.** It is the first
film-able piece of the loop, and it is a separate asset from take 13.

## Denied, and the honest absence

- **Denied**: the action never runs, the room says so ("… was denied and will not run"), the task is not
  silently dead, and nothing retries. The resolution is terminal and single-use.
- **`pr.merge` approved**: the resolution is recorded and **nothing executes** — there is no executor
  until S2.6. The room says exactly that ("… was approved. No executor exists yet, so nothing was
  performed (S2.6)"), and it must not imply a merge occurred. **RT-005 re-checked and holds: no ALLOW,
  and now no APPROVAL, causes any external side effect** (see the red-team log's S2.2 re-check).

## The latency — the release path rides the summon path

An approval releases the held summon through the SAME `fireSummon` → `triggerAgentTurn` a routine summon
uses, so B's own first token is the warm-path distribution ADR-008 published — this is not re-measured.
What the release ADDS is convergence before B's turn: `signDecision`'s checks + the resolution write +
`fireSummon`'s DB work, all warm and ahead of the provider call.

Measured (`scripts/measure-release-latency.ts`, n=40, live DB, zero provider tokens):

|                            |   p50 |   p90 |   p95 |
| -------------------------- | ----: | ----: | ----: |
| release-path overhead (ms) | 117.6 | 132.3 | 168.1 |

Release-path first token = overhead(P95) + B's warm TTFT(P95, ADR-008), against §11's 1800ms P95:

| B (the summoned agent)                | warm TTFT P95 | + overhead | = first token | budget       |
| ------------------------------------- | ------------: | ---------: | ------------: | ------------ |
| **sol** (the co-sign's actual target) |         698ms |      168ms |     **866ms** | under 1800 ✓ |
| claude-main (as a target)             |        1742ms |      168ms |    **1910ms** | OVER 1800 ✗  |

**For the realistic release path the number is 866ms — inside ADR-008.** In the co-sign flow the emitter
is the protected agent and the target is whoever it summons (here sol), so B is sol and the first token
lands at ~866ms. A protected summon that TARGETS claude-main would breach (1910ms) — but that is the same
tail ADR-008 already flags (claude-main's warm P95 has 58ms of headroom), now compounded by the release's
~168ms. The overhead is larger than the pure summon's ~35ms (S18-4) because `signDecision` adds its
checks; one of them — the early already-resolved read — is redundant with the database's single-use index
and could be dropped to shave a round-trip. Noted, not done, to keep this commit to the card and the clip.

## The claims sheet delta (verbatim)

- **Was** (Beat 5, item 3): "**The co-signature cannot be completed.** Approve and Deny are `disabled`
  and labelled `S2.2`… nothing can yet collect."
- **Now**: "**The co-signature IS completable now (S2.2) — and merge execution is still absent.**"
  The buttons are live for the required signer, an approval releases the action exactly once, and on a
  `pr.merge` decision that release **runs nothing** (no executor until S2.6, RT-005 holds).
- The "what it does NOT prove" column did not shrink: **merge execution remains absent.** S13-N1 stays
  open — S2.2 carries the held action on the decision's `pending_action`, not on a task, so a co-sign
  still does not reference the task it signs for.

## The successor question — from the code, not the roadmap

**Can a routine agent-to-agent continuation run as a pure ALLOW — no pause, no human — all the way
through, while a protected action in the same chain correctly pauses and waits?**

**Half yes, and the half that is no names the next slice exactly.**

- **The routine/pivotal split works, for one hop.** A routine summon (in scope, NOT protected —
  claude-main's `summon.initiate` in the shipped config) evaluates to ALLOW and fires immediately: no
  pause, no human. A protected action in that same chain (claude-main's `pr.merge`, or a designated
  protected summon) evaluates to CO_SIGN and pauses for a signature. Both are real today, and the
  smallest loop that runs is: a human summons A, A routinely summons B, B replies — and if A or B
  reaches for a protected action, it pauses. The machine this slice built is what makes that safe.

- **But a routine continuation CANNOT run "all the way through."** The `SUMMON_DEPTH_CAP` is 1 (S1.8's
  runaway bound): a human-rooted turn is depth 0, an agent it summons is depth 1, and that agent may NOT
  summon further — depth 2 is refused. So a routine agent-to-agent continuation runs exactly ONE
  agent-initiated hop and then the cap stops it. The loop Prince is building — many routine continuations
  unattended, surfacing to a human only at a protected boundary — does not yet exist, and it is the depth
  cap that forces it to stop when the loop would want it to continue.

**So the next slice is the loop's trigger and its ALLOW-continuation path**, and its whole job is to
replace a RECURSION bound (max one agent hop) with a LOOP bound suited to an unattended chain: a step
count and the daily spend ceiling, so a routine continuation can run many hops while provably terminating
(≤ N steps, or the ceiling), and protected actions still pause exactly as they do now. The co-sign machine
is complete; what it gates — the pivotal moments — now has a human behind it. What is missing is the
governed way to let the ROUTINE moments run past one hop. That gap must close before Claude Code joining
as a member means anything, and this slice is what made closing it safe to attempt.
