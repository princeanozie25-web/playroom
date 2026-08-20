# ADR-022 — Work alongside ChatGPT and Claude from inside a room

**Status:** accepted
**Date:** 2026-08-20
**Slice:** embedded-model projections — the deterministic adapter + a multi-model demonstration

## Context

"Work alongside ChatGPT and Claude from inside a room" was, in large part, **already built** before this
slice. `@playroom/adapters` is the §6 anti-lock-in seam: it holds a provider-neutral `AgentAdapter`, a real
**anthropic** adapter (Claude) and a real **openai** adapter (ChatGPT), a registry (`adapters.yaml`) that
configures `claude-main` on Claude and `sol` on ChatGPT, and a conformance suite that drives each adapter's
translation loop with a stub transport. The room already summons those members and runs their turns through
the governed gateway. The registry even says why the second provider exists: _"sol stays on a second provider
because provider-neutrality is a claim this repository makes and one adapter has to prove it."_

Two honest gaps remained. First, both real adapters require their provider's **credential** to run, so there
was no way to exercise a _multi-model governed room_ offline — in CI, in the demo, or in a keyless deployment.
Second, nothing DEMONSTRATED the end state: two members from two providers taking governed turns alongside each
other in one room. This slice closes both without pretending to add a capability that was already there.

## Decision

- **`MockAdapter`** (`@playroom/adapters`) — a first-class, deterministic `AgentAdapter` with no SDK and no key:
  it streams a scripted turn (text deltas, then any structured `action`s, then exactly one terminal chunk), the
  same contract the real adapters hold. It is the offline analogue of the provider adapters, mirroring the Mock
  backends that already make reads (`@playroom/x-read`) and writes (`@playroom/write`) exercisable without a
  live service. It is **not** wired into `createAdapter` (that names real providers); it is constructed directly
  or injected as an `adapterFactory` via `mockAdapterFactory({ [memberId]: script })`.

- **A demonstration** — a test drives a real governed room where one human message names both `@claude-main`
  (anthropic) and `@sol` (openai); two independent, governed turns follow, and both members answer in the same
  room. It runs on the mock adapters, so it proves the room ORCHESTRATES two providers under governance with no
  spend. The providers' own faithfulness to their wire formats stays the conformance suite's job.

## Consequences

- **The multi-model room is provable offline.** "ChatGPT and Claude work alongside each other" is now shown
  end-to-end in CI, not just asserted from the fact that both adapters compile — and any test or demo can run a
  whole multi-provider room deterministically by injecting `mockAdapterFactory`.
- **The seam is confirmed provider-neutral at the ROOM level, not just the adapter level.** The governed turn
  path, the summon-by-mention, the assembly window, the spend line — all run identically for a Claude member
  and a ChatGPT member; the demonstration exercises exactly that.

## Honest limits

- **This slice did not add the capability — it made it runnable offline and proved it.** The provider adapters,
  the registry, and the governed turn machinery predate ADR-022; the honest contribution here is the
  deterministic adapter and the demonstration, not a new provider integration.
- **A live multi-model room needs the real keys.** `claude-main` and `sol` call their providers' SDKs when
  `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` are present; running them for real is credential-gated and billable,
  the same posture as the write backends (ADR-020). The mock is what stands in when the keys are absent.
- **`MockAdapter` is a stand-in, not a model.** It emits a script; it does not reason. It exists to exercise the
  room's orchestration and governance around a member, deterministically — never to simulate a model's answers.
- **No new web surface.** This is a server/adapter-side proof; a room UI that shows two model members
  conversing is the existing web tier's concern, unchanged here.
