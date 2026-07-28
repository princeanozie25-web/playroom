# S1.8 — the summon renders as an act, and the channel's latency is measured

**No film change. Take 13 stands.** S1.8 built the tool-call channel: an agent's turn emits a
structured action, it travels the adapter seam typed and attributed, and the fabric governs it at the
one constructor. The first consumer is a summon — one agent brings another into its turn. This is the
record of the two things the slice's last commit owed: how that summon RENDERS, and what the structured
path COSTS. Local build (the deploy is still billing-blocked — said plainly).

## The render — an agent-initiated summon is an act, not a tag

A human summon is already visible: it is the `@sol` in the human's own message, and the transcript
shows that message. So the transcript's `buildItems` allowlist has always IGNORED `summon` events —
they are "records of how a turn came to happen, not things a member said," and a row for one would be a
second representation of a fact already on screen.

An agent-initiated summon has no such message. When claude-main summons sol through the channel, there
is no `@sol` anyone typed — the act would be invisible, which is the RT-001 shape in a surface: real,
recorded, and unobservable to the people in the room. So `buildItems` now renders `summon` events
**conditionally**: only when `requested_by` is an AGENT (`SummonRow`, `data-pr="summon"`). A human
summon still produces no row.

It is deliberately the SAME shape as the handoff row — `[summon] claude-main → sol`, the two members in
their own colours, the arrow between them — because a summon and a handoff are the same class of thing:
one member acting upon another. The CSS rule is shared verbatim (`.handoff-row, .summon-row`); the
member colour and marker system is the existing one, unchanged. No new look, as the brief required —
this is labelling. It carries no mandate hash and no action code: a summon confers no authority, and the
summoned agent acts under its OWN mandate, which its turn already shows.

Verified in the browser against a seeded room (an agent-rooted summon event plus a human-rooted one):
the agent summon rendered its row; the human summon rendered none, its `@`-mention message carrying it
as before.

## The measurement — the structured path's added latency, and it stays inside ADR-008

**B's own first token is unchanged, and this is the load-bearing fact.** An emitted summon converges on
the SAME `summonCommand` and the SAME `triggerAgentTurn` a human summon uses — B's provider call is
byte-for-byte the human path. So B's time-to-first-token is the warm-path distribution ADR-008 already
published, and re-measuring it would be measuring the provider again. What is NEW is the **convergence
overhead**: the work the agent branch does before B's turn — read the room's members for the evaluator's
roster, `evaluate(summon.initiate)`, resolve the target against that roster. All warm-DB and CPU, all
ahead of the provider call.

Measured (`scripts/measure-summon-latency.ts`, n=500, live database, zero provider tokens):

|                           |  min |  p50 |  p90 |  p95 |   max |
| ------------------------- | ---: | ---: | ---: | ---: | ----: |
| convergence overhead (ms) | 22.6 | 25.1 | 29.0 | 35.0 | 255.7 |

Summon-path first token = convergence overhead (P95) + B's warm TTFT (P95, ADR-008), against §11's
1800ms P95 line:

| B (the summoned agent) | warm TTFT P95 | + overhead P95 | = first token | budget       |
| ---------------------- | ------------: | -------------: | ------------: | ------------ |
| **claude-main**        |        1742ms |           35ms |    **1777ms** | under 1800 ✓ |
| **sol**                |         698ms |           35ms |     **733ms** | under 1800 ✓ |

**The binary exit is met, and it took a fix to meet it.** The first measurement read the roster
**twice** — once for the evaluator, once again inside target resolution — and each read is a round-trip
to a remote database (Neon, eu-west-2) that also re-validates every mandate. That was ~63ms P95, and on
claude-main — which ADR-008 records at **58ms of headroom warm** — it pushed the first token to 1805ms,
**5ms over the line**. This is A4-F1's shape at the latency layer: a number that looks like a pass until
you measure it, on exactly the member with no room to spare.

The fix is the honest one, not a looser budget: read the roster ONCE and resolve the target from it
(`matchRoomAgent`, the pure half of the old `resolveRoomAgent`). Overhead halved to 35ms P95, and
claude-main returns to 1777ms — 23ms under, restored to roughly its warm headroom. The overhead that
remains is irreducible and correct: the evaluator needs the roster, and reading it is the price of
governing the summon rather than trusting it.

Two things stated precisely, because the obvious reading of each is wrong:

1. **The overhead is added to B's first token, not to A's turn.** A's turn had to complete regardless;
   the summon dispatches after it. So the ~35ms lands ahead of B's provider call, which is why it is
   summed against B's TTFT and not A's.
2. **This is a warm number, and cold is still ADR-008's separate row.** The overhead is DB round-trips;
   after an idle the first one pays the wake, which ADR-008 shows lands on the room fetch or socket
   connect — not on the summon. The compound does not occur here for the same reason it does not there.

## The successor question — what does S2.1 inherit, and what must it still build?

S2.1 is `pr.merge` through the channel: an agent emits a **protected** action, not a summon. The split
is clean and worth stating, because half of it is nearly free and half of it is the whole of S2.1.

**What S2.1 inherits — the channel, and it is general.** Nothing S1.8 built on the emission side is
summon-specific in principle: the `action` chunk in `AgentTurnChunk`, the adapter seam surfacing
`tool_use`/`tool_calls` as typed actions and translating `opts.tools` to provider format, the near
guard that offers a tool only when the mandate's scope grants it, the collection of emitted actions off
the turn. A `pr.merge` tool is offered the same way (gated on `pr.merge` in scope), emitted the same
way, collected the same way. And the load-bearing property carries: the channel does not bypass the
fabric. S1.8's summon is evaluated through `evaluate()` at the constructor; `pr.merge` is a protected
action the SAME evaluator already knows how to rule on — it returns `CO_SIGN` for it today.

**What S1.8 leaves for S2.1 to build — and deliberately did not touch (the brief forbade it).** Two
things, one small and one large:

1. **The dispatch is summon-shaped.** `runAgentTurn` collects emitted actions and routes them to
   `summonCommand`. A protected action routes to `requestAction` (the decision constructor) instead, so
   the action→command mapping must become general rather than hardcoded to `summon`. Small.
2. **A summon is fire-or-refuse; a protected action is not.** This is the substance of S2.1. A summon's
   verdict is `ALLOW` → it happens, or a refusal → it is named out loud. A `pr.merge`'s verdict is
   `CO_SIGN` → a decision that must **wait for a human signature and only then execute**. The evaluator
   already returns `CO_SIGN`, and the decision card already renders it — with its co-sign controls
   **disabled**. What does not exist anywhere yet: a decision that is PENDING, a functional co-sign act
   a principal takes, and the DEFERRED execution of the merge once signed. That is a different machine
   from a summon's synchronous dispatch, and S1.8 built none of it — correctly, because building
   protected-action emission was explicitly out of scope.

So: `pr.merge-via-channel` is a small addition on emission (the channel is general and ready) and a
large one on governance (a co-signable, pending, deferred-execution decision — which S1.8 left entirely
to S2.1, and which is the reason S2.1 is its own slice).
