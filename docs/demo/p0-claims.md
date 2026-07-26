# P0 film — what it proves, and what it does not

**Read this before cutting, captioning, narrating or showing the film.**

The deck currently promises six beats. The film shows five. This document exists so those
two artifacts cannot drift apart in front of an investor, and so nobody has to reconstruct
from memory which parts of what is on screen are enforced and which are drawn.

**The rule that governs every frame: the film may not imply a capability that does not
exist.** Four slices went into making governance structurally unfakeable in the product —
the DECISION card has exactly one possible input, `appendAgentEvent` will not compile
without a summon, the co-sign buttons are inert by construction. A caption can undo all of
it in ninety seconds, and no test will catch that.

Recorded take: **take 6**, 56.5s, one continuous take, production build. See
[p0-take-log.md](p0-take-log.md) for provenance and per-beat assertions.

---

## The five beats

### Beat 1 — the room opens

|                      |                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What it proves**   | Two agent members coexist in one room under **different principals**, and their granted authority differs and is visible. The scope text on each chip is read from that member's mandate file — it is the same array the evaluator checks, not a caption of it. Claude carries `pr.merge (co-sign)`; Sol does not carry `pr.merge` at all.                                                                        |
| **What it does NOT** | **Identity is not authenticated.** The roster asserts that Claude speaks for `principal:prince` and Sol for `principal:jerry`; **nothing verifies either claim.** There is no principal table, no membership model, no signature — `adapters.yaml` says so and the UI renders what it says. S1.1 lands membership, S1.2 stamps identity. Until then the chips are an assertion of intent, not proof of authority. |

Also not shown, and worth knowing before anyone captions it: **no provider name appears
anywhere on screen, by design** (Roadmap §6 — the room, the fabric and the data model never
contain one). It is true that the two members run on two different providers, and it is
verifiable from `adapters.yaml` and from the two very different cost figures in beats 3 and
4 — but **the frame does not show it**. A caption may state it as fact; it may not point at
the screen as the evidence.

### Beat 2 — an untagged message, and nothing happens

|                      |                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What it proves**   | Agents do not speak unless addressed, and this is a **structural** property rather than a prompt instruction: `summonRuling` is an allowlist over one event type with named refusals, and the activation boundary refuses generated text, non-room content, system output and agent-authored messages by name. Seven seconds of silence is held deliberately.                                                        |
| **What it does NOT** | It does not prove agents cannot be **provoked** by content. Quoted and imported spans **do** activate today: `MessageEvent.payload` is one flat string with no span provenance, so a member who pastes a report containing `@sol` summons Sol. That is RT-004's accepted gap, pinned by a must-fail test, closed by S1.7 (RA-005). The silence shown is silence in the absence of a tag — not immunity to injection. |

### Beat 3 — `@claude`

|                      |                                                                                                                                                                                                                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What it proves**   | A real streamed turn from a real provider: token-by-token, persisted before fan-out, with **real spend visible in-thread** (`262→187 tok · $0.0012`). The token counts and cost come from the provider's own usage figures and the per-1k prices in config; nothing is estimated for display.                        |
| **What it does NOT** | The turn is **not a governed action.** It traverses no mandate — `room.post` was deleted from scope in S0.4 precisely because nothing evaluated it (RA-003 proposes S1.8). Postage is not debited, interrupt budgets do not exist, and no receipt is produced. The spend line is telemetry, not an accounting entry. |

### Beat 4 — `@sol`

|                      |                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What it proves**   | A second member, a **different principal**, a different provider, answering in the same room from the same shared context — routed entirely by roster config. The provider seam is real: enabling Sol in S0.4 touched two files and no application code.                                                                                                               |
| **What it does NOT** | Nothing about **isolation between principals**. Both members receive the same 30-message room context; there is no per-principal store, no promotion boundary and no selective disclosure yet (S1.5, S1.7). Sol seeing Prince's messages is not a demonstration that it may — it is a demonstration that everything in a room is currently shared with everyone in it. |

### Beat 5 — a `pr.merge` request, and the DECISION card

|                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What it proves**   | A real server-side evaluation against a real mandate document, producing a real `decision` row in the event log, rendered by a card whose **only possible input is that row**. `PROTECTED_ACTION` is the reason code the evaluator returned; `principal:prince` is the signer the mandate names; `sha256:1af314ca8427474e…` is the hash of the mandate that was actually in force. **Nothing merges** — no side effect was attempted and no integration exists to attempt one against. |
| **What it does NOT** | Five things, each of which a caption could get wrong. They are listed separately below because this is the beat that carries the whole film.                                                                                                                                                                                                                                                                                                                                           |

---

## Beat 5, in detail — the five things it does not prove

**1. Claude did not try to merge anything.** The request was issued **on Claude's behalf**
by a caller — the capture harness, standing in for the host sidecar that Bible §3.2
describes. **Agents cannot initiate structured actions at all:** `AgentTurnChunk` is
`text_delta | done | error`, with no tool-call channel, so there is no mechanism by which
Claude could have requested a merge. The evaluation is real and server-side. **The agency is
not.**

The on-screen label makes this worse and must be actively counteracted: the card reads
**"ATTEMPTED BY Claude"**. That wording asserts intent the product cannot produce. Recorded
as **S06-N3** at `apps/web/app/DecisionCard.tsx`; it is a wording change, not a mechanism
change, and it was deliberately not made during a filming slice.

**2. The mandate is unsigned.** There is no `sig` field, by design in v0 — omit, never stub.
A fake `ed25519:` string would have been worse than an absent one. The hash on screen proves
_which document was evaluated_, not that anyone authorised it. S2.1.

**3. The co-signature cannot be completed.** Approve and Deny are `disabled` and labelled
`S2.2` on screen. There is no co-sign flow, no signing key and no way to act on the
decision. The card shows a decision **awaiting** a signature that nothing can yet collect.

**4. There is no receipt and no hash chain.** §19's `audit` table does not exist. Nothing on
screen may be described as _signed_, _notarised_, _tamper-evident_, or _provable
afterwards_. The event log is append-only Postgres with a monotonic sequence — good, and not
a chain. S2.3.

**5. The subject is unauthenticated.** The `request_action` frame names `claude-main` as its
subject and **any caller may name any member**. The evaluator's verdict is sound for the
subject it was given; nothing establishes that the caller was entitled to speak for that
subject. S1.2.

---

## Caption guidance

**Beat 5's honest caption:** _a merge request is refused against Claude's mandate, and a
human signature is required before it can proceed._

**Not:** _Claude tried to merge and was stopped._ **Not:** _the agent was blocked._ **Not:**
_a hijacked agent attempted a merge._ The mechanism is the claim. Agent intent is not
demonstrated anywhere in this film and must not be narrated.

Other wordings to avoid across the whole cut:

| do not say                                   | because                                                    | say instead                                                |
| -------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| "signed receipt", "provable", "notarised"    | no chain, no signatures exist (S2.3)                       | "recorded in an append-only log"                           |
| "verified identity", "authenticated members" | nothing verifies a principal claim (S1.2)                  | "each member declares the principal it speaks for"         |
| "the agent was blocked from merging"         | the agent never requested it, and could not                | "a merge request against that member's mandate is refused" |
| "approve it here"                            | the buttons are inert and labelled S2.2                    | "the co-signature step lands in S2.2"                      |
| "agents can't be tricked"                    | quoted and imported content still activates (RT-004, S1.7) | "an agent's own output cannot summon another agent"        |
| "isolated context per principal"             | one shared 30-message window today (S1.5)                  | "one shared room context"                                  |

**One further honesty note about the recording itself.** The five beats are one continuous
take with no cuts, but the _pacing_ is set by the harness: holds are deliberate, and the two
long prompts are pasted rather than typed. Nothing is sped up, slowed down, spliced or
re-ordered, and no frame is composited. If the cut adds speed-ramps or trims the held
silence in beat 2, the silence stops being the claim it currently is.

---

## The deck's sixth beat

The deck promises six. This film delivers five. Whatever the sixth is, it is **not** in this
footage, and the deck must either drop it for P0 or mark it as forthcoming. Reconciling that
is an owner decision and is recorded here as the open item, not resolved.

---

## Findings raised by this slice

| id     | finding                                                                                                                                                                                                                                                                                     | trigger                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| S06-N1 | the capture harness's selectors rotted silently when S-UI rewrote the room — three stale selectors matched nothing rather than failing, and it lives outside CI                                                                                                                             | the next UI change to the room, or the next slice that films it       |
| S06-N2 | the room header renders the room **id**; the room's `title` is rendered nowhere, so every frame carries a slug                                                                                                                                                                              | **S1.1**, when rooms acquire real membership and a name worth showing |
| S06-N3 | the DECISION card's "Attempted by" asserts agency the product does not have                                                                                                                                                                                                                 | the slice that gives adapters tool calls (S1.3's handoff object)      |
| S06-N4 | **Bible §11 has no budget row for opening a room** — which is where the database wake now lands (ADR-008) and where a pilot's first action of the day pays it. The film's beat one opened in 454ms only because the harness warmed first; there is no written budget it could have breached | **S1.1**, when rooms acquire real membership                          |
