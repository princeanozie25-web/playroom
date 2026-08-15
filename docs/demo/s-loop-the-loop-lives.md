# S-LOOP — the loop lives: a standing order sustains an unattended cycle, within bounds

**Take 13 stands — this is a new asset, not a re-cut.** S-LOOP added the thing that was missing: a
governed record that turns a completed turn into the next summon, so a two-member cycle runs without a
person pressing go each time. It causes; it does not grant. Everything it fires travels the existing
summon constructor, is human-rooted through the order's creator, and is refused exactly as a person's
tag would be. This is the record of what the four commits built, the numbers that back it, and the shot
list for filming the loop. Local build (deploy still billing-blocked — see [[playroom-deploy-blocked]]).

## CORRECTION (15 Aug 2026, SL2-1) — the cycle in this document had never run

**Everything below about what a standing order IS was true when written. The two-member cycle was
not.** From `bc588bd` (SLOOP-2, this slice's own second commit) until `SL2-1`, an order-rooted turn
assembled a `room-turns` part that neither of assembly's two gates permitted, so `windowFor` threw
§7.1 on the feature this slice added, `agent.ts` caught it into `agent.turn.completed{success:false}`,
and the standing order paused — wearing "ended in error", the same sentence a provider outage wears.

**Every real cycle hit it, deterministically**, because the thing that triggers a cycle IS a
successful completed turn with text, which is exactly the row `recentCompletedTurns` reads. What ran
green was the suite: `order-firing.test.ts` synthesises `runOrders` directly and never writes a
completed-turn row, so the part was never built and the gate was never asked.

So the paragraph below — "Claude drafts and completes → Order B fires → Sol reviews … carries the
recent turns as context" — described a design, not a behaviour, for eleven days. **The shot list was
never shot**: no take of §3's "≥3 unattended cycles" exists, and searching both Neon databases for
the evidence found **zero `order.*` events and zero completed turns in either**, so there is no run
to point at in any direction. The correction is recorded here rather than quietly fixed because this
document is the durable record of what S-LOOP built, and what it built did not work.

**Fixed in `SL2-1`**, not hidden: the parts of a window are now declared once, and the permitted set,
the order, the shared/private rule and the telemetry all derive from that declaration — see
`apps/api/src/assembly.ts` and `assembly-parts.test.ts`. The first cycle to actually run is asserted
end to end in `loop-briefed-cycle.test.ts` (SL2-2), and **ran against real providers on 15 Aug 2026**
(`scripts/run-briefed-loop.ts`, local tier — the numbers are in the S-LOOP2 section of
[p0-claims.md](p0-claims.md)). The shot list below is still a shot list: there is no capture of any
of it (S17-N4).

## What a standing order is, and is not

- **It is delegated human intent.** Only a human creates one (checked against the socket's authenticated
  member's kind, never a claim in the frame). An agent may never create, resume, or widen one — the
  same reasoning that keeps an agent from signing a co-signature.
- **It causes; it does not grant.** The order does not add authority. When it fires, the summon it emits
  is evaluated against the action member's mandate like any other — a protected action still pauses for
  a co-signature mid-loop. Orders cause; mandates permit.
- **It is human-rooted.** An order-fired summon's root is the human creator, so every order-rooted turn
  resolves to a person in the §19 drift query. The query now reports the resolving population in two
  columns — directly-human-rooted and order-rooted — both tracing to a human, unprompted still exactly
  zero. Lumping them would have hidden the automation ratio.

## The two-member loop

Two orders make a cycle:

- **Order A** — _when Sol completes a turn, summon Claude._ (creator: a human; trigger: `sol`;
  action: `claude-main`)
- **Order B** — _when Claude completes a turn, summon Sol._

A person kicks it off with a normal tag (`@claude draft the opening`). Claude drafts and completes →
Order B fires → Sol reviews and completes → Order A fires → Claude revises → … The kick-off is cycle 0
and directly human-rooted; every cycle after is order-rooted, human-rooted through the creator, and
carries the recent turns as context so the reviewer sees the draft.

> **As of SL2-1 this paragraph is true.** Between `bc588bd` and `SL2-1` it was not: the "carries the
> recent turns as context" clause is the exact part that threw, so no cycle after the kick-off ever
> completed. See the correction at the top.

## The two runaway bounds, in two places

| bound                  | scope            | where                                                                            |
| ---------------------- | ---------------- | -------------------------------------------------------------------------------- |
| **depth cap** (S1.8)   | within one cycle | a summon may be one hop deep; an emitted summon cannot chain                     |
| **the order's guards** | across cycles    | idempotent per trigger + one-cycle-in-flight (DB), and the four self-stops below |

## The four self-stops — every one is named, and out loud

A loop that quits silently is indistinguishable from one that broke. So each stop moves the order to a
named state, writes the reason as a sentence in the room, and claims its owner's attention through an
interrupt (S1.4):

| stop           | state           | resumable | when                                                                |
| -------------- | --------------- | --------- | ------------------------------------------------------------------- |
| **expiry**     | `EXPIRED`       | no        | the wall-clock deadline passed — no cycle runs                      |
| **ceiling**    | `PAUSED`        | yes       | the daily spend ceiling is reached — no cycle runs                  |
| **max cycles** | `LIMIT_REACHED` | no        | the count the creator set is reached — the fired cycle was the last |
| **attendance** | `PAUSED`        | yes       | it ran its unattended budget of cycles with nobody watching         |

Expiry and the ceiling are checked **before** a cycle opens (an expired or unfundable order must not run
one more), against the database clock and the same log-summed spend the stranger ceiling uses. Max
cycles and the attendance dial are read **from** the atomic open, so the cycle that reaches a limit is
the last that runs, not the one refused.

### The attendance dial

`max_unattended_cycles` (default 3) counts cycles that ran with nobody watching. It resets when someone
is watching: **a human message in the room**, or **a resume**. At the dial the order pauses and taps its
owner on the shoulder — a DECISION interrupt, addressed to the humans of the creator's principal,
**charged to the loop's own agent member** (the recurring work is the agent's, so the claim it makes on
a person is the agent's to fund — exactly as a co-sign charges the subject). One tap resumes it and
resets the streak.

## The number: what the loop costs per cycle

`pnpm tsx scripts/measure-trigger-overhead.ts 40`, live DB, scripted adapters (no spend):

```
  trigger→summon         min 102.1  p50 106.1  p90 112.5  p95 113.7  max 125.9  (ms)
  normal-turn no-op      min 10.1   p50 11.0   p90 12.0   p95 14.1   max 80.8   (ms)
```

- **Trigger overhead — p95 114ms.** The convergence a completed turn adds before the next order-rooted
  summon exists: read the orders this completion triggers, open a cycle (the atomic guard), record it,
  fire the summon + route. It is Neon round-trips for a handful of writes, not compute.
- **Normal-turn no-op — p95 14ms.** A turn nobody automated pays exactly one indexed read
  (`activeOrdersForTrigger` returning nothing), and it is **post-completion, not first-token**.
- **ADR-008 is unaffected by construction, not by luck.** The room-turns context source is gated to
  order-rooted turns, so a normal turn's assembly is byte-for-byte what it was before S-LOOP. First
  token is untouched. This is the property the near-guard and channel tests hold.
- **§11's 1800ms first-token budget does not gate a loop cycle.** That budget prices a human's wait
  after they act; a loop cycle has no human waiting on its first token. For reference only, overhead +
  warm TTFT(p95) is ~1856ms for a Claude action, ~812ms for a Sol action.

## The shot list (for the film — a new asset, separate from take 13)

One continuous take, harness-paced holds, nothing spliced:

1. **Two orders exist** — the ambient chips: "standing order (by Prince) → summons Claude" and
   "→ summons Sol". No badge; quiet, like a spend footer.
2. **The kick-off** — Prince tags `@claude`. Claude drafts (cycle 0, human-rooted).
3. **≥3 unattended cycles** — Claude ⇄ Sol, draft → review → revise, each summon a "standing order
   (by Prince)" tag, distinct from a human tag and from an agent's own summon. Prince does nothing.
4. **A protected action holds mid-loop** — an agent attempts a protected action; it pauses for
   Prince's signature (the S2.2 co-sign card, "Needs a signature from Prince"). The loop is caused by
   the order but still governed by the mandate. Prince signs; the loop continues.
5. **The attendance dial** — after the unattended budget, the order **pauses out loud** and a DECISION
   interrupt lands on Prince ("ran N cycles without you — resume to keep the loop going"). **Prince
   resumes with one tap**; the streak resets; the loop continues.
6. **A self-stop** — the order reaches `LIMIT_REACHED` (or `EXPIRED`), says so in the room, and does not
   cycle again.

Reproduce the setup with `scripts/seed-loop.ts` (creates the room, both orders, and kicks cycle 0).

## do not say / say instead

| do not say                              | because                                                                                  | say instead                                                                |
| --------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| "the order grants the agent permission" | an order causes a summon; the mandate still permits or refuses it                        | "the order fires a summon, which the mandate evaluates like any other"     |
| "the loop runs itself / autonomously"   | it runs on a human-created, human-rooted, bounded, revocable record                      | "a standing order the creator can pause or revoke sustains the cycle"      |
| "it runs unsupervised / forever"        | the attendance dial pauses it after N unattended cycles; limits and expiry stop it       | "it runs a bounded number of cycles, then pauses for a person"             |
| "the agent kept the loop going"         | an agent may never create, resume, or widen an order                                     | "the creator's standing order kept the loop going; only a human minted it" |
| "the loop bypasses the mandate"         | a protected action still pauses for a co-signature mid-loop                              | "a protected action mid-loop still holds for a signature"                  |
| "the runner has special privileges"     | the runner gets no bypass; its summons travel the same constructor and are refused alike | "the runner fires ordinary summons; nothing about them is privileged"      |

## Findings raised by this slice

| id       | finding                                                                                                                                                                                                                                                                        | trigger                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| SLOOP-N1 | the trigger overhead (p95 114ms) is dominated by Neon round-trips across `fireSummon`'s several writes (summon, task, cycled, route); a batched write would cut it, but it is off every human-waited path, so the cost is throughput, not latency                              | S2.7, if loop throughput ever matters at scale                   |
| SLOOP-N2 | an order's about_id for its interrupt is unique per stop because there is no interrupt-clearing — a resolved co-sign interrupt and a stopped order's interrupt both persist as records that a claim was made; a clearing/acknowledged model is unbuilt                         | S3.2, when interrupts acquire a lifecycle beyond raise/downgrade |
| SLOOP-N3 | the attendance reset on a human message is fire-and-forget off the send path; if it is ever lost to a crash, the streak is only cleared on resume — acceptable because resume is the backstop, but it means the dial can over-count by the messages sent during a crash window | S2.7, if the dial's exactness ever becomes load-bearing          |
