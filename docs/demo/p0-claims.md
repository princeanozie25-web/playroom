# P0 film — what it proves, and what it does not

**Read this before cutting, captioning, narrating or showing the film.**

The deck currently promises six beats. The film shows five. This document exists so those
two artifacts cannot drift apart in front of an investor, and so nobody has to reconstruct
from memory which parts of what is on screen are enforced and which are drawn.

**The rule that governs every frame: the film may not imply a capability that does not
exist.** Four slices went into making governance structurally unfakeable in the product —
the DECISION card has exactly one possible input, `appendAgentEvent` will not compile
without a summon, and a co-signature completes only for the human bound to the decision's
principal — an agent can never sign (S2.2). A caption can undo all of it in ninety seconds,
and no test will catch that.

Recorded take: **take 13**, 54.04s, five beats, one continuous take, production build, 1280×800.
Take 12 attempted a 2× capture and produced a padded frame rather than a supersampled one — the
take log records the measurement. Take 13 is also the first take showing an interrupt chip.
Re-shot
after S1.3c on 27 Jul 2026, through a front door that checks room membership and a socket that
authenticates with a single-use ticket. **Take 11 is a six-beat variant** (61.60s) that adds the handoff; it is
kept and it is not the asset, because the sixth beat costs 8.8 seconds and the only way to fit it
under a minute would have been to shorten the decision card's hold. If take 11 is ever cut,
**beat 6's claims below apply and are not optional.** See [p0-take-log.md](p0-take-log.md) for
provenance and per-beat assertions.

**The surface changed after the first cut; the claims did not.** Take 6 was shot on the
pre-S-UI2 room, take 10 on the redesigned one. S-UI2 was appearance work — identity became
colour and shape, the roster became the dense surface, the decision card became sentences —
and **it changed no capability whatsoever**. Every entry in the what-it-does-not-prove
column below is unchanged from the take 6 version of this document, and one entry got
LONGER rather than shorter. A claims sheet that quietly shrinks after a redesign is the
exact failure it exists to prevent, so the diff is stated plainly: one finding closed
(S06-N3, by rewording), nothing else moved.

**S1.2 is the first change to this document that reflects a real capability change, and it
is a narrowing, not a deletion.** Identity is now stamped at the handshake rather than
claimed on the wire, so two sentences that were true when take 10 was first cut are no
longer true and have been replaced by narrower ones — not removed. Specifically:

- Beat 1's _"nothing verifies either claim"_ is gone, because something does: a connection
  presents a credential, and the member it resolves to is bound to a principal by a foreign
  key. What replaces it is the part the credential does not reach — **an unsigned mandate,
  and no authenticated person.**
- Beat 5's _"the subject is unauthenticated"_ became _"the requester is authenticated; the
  subject is still a claim"_, which is one half closed and one half named more precisely.
- The do-not-say table **grew by two rows.** "Authenticated members" became sayable at the
  connection level, so the ban narrowed to the thing still unearned — a verified _person_ —
  and two new bans were added for claims that a credential makes newly tempting.

Take 10 was **re-shot after S1.2** from the same script with no selector edits and no
product change for the camera: the only harness change is that it now presents a credential,
because the door it used to walk through unauthenticated is closed. Every beat asserted
green. If a claim here shrinks in a future slice, the shrinkage must name what proves it.

---

## The five beats

### Beat 1 — the room opens

|                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What it proves**   | The connection itself is governed: the socket carries a credential, and as of S1.3b **the room refuses a member who is not enrolled in it** — a room you are not in answers exactly as a room that does not exist, on the socket and on both HTTP reads. Two agent members then coexist in one room under **different principals**, and their granted authority differs and is visible. The scope text on each chip is read from that member's mandate file — it is the same array the evaluator checks, not a caption of it. Claude reads `review + comment, merge (co-sign)`; Sol reads `review + comment only` and does not carry merge at all. Each also wears its principal's accent, so the affiliation is answered by looking rather than reading.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **What it does NOT** | **A member's binding to its principal is now enforced; the mandate behind it is not, and no person is authenticated.** What changed in S1.2: members and principals are database records, a connection presents a credential, and the actor on every event is resolved from that credential rather than claimed by the caller — so `Sol speaks for Jerry` is enforced at the connection and the chips are no longer only an assertion. What did NOT change: **the mandate is an unsigned YAML file.** `Jerry granted this authority` is still asserted by the document, and anyone who can commit to `mandates/` can widen a scope — the room will render the widened scope truthfully, because the room is truthful about the document and it is the document that is unproven (S2.1). And a credential in an environment variable authenticates a **process acting as a member**, not a human: there is no login, no second factor and no per-human key, so nothing on screen identifies a person. S04-N2 stays open, narrowed. **And membership is enforced, not private:** the room refuses a non-member, and as of S1.3c the credential that opens it is no longer in the page — the browser is handed a single-use ticket worth thirty seconds, and the long-lived credential stays in the web tier. What has NOT changed is the part that matters for a caption: there is no login, so the web tier mints a ticket for anyone who can reach it. Say _the room admits only its members_; never _only Prince can open it_ (S04-N2). |

Also not shown, and worth knowing before anyone captions it: **no provider name appears
anywhere on screen, by design** (Roadmap §6 — the room, the fabric and the data model never
contain one). It is true that the two members run on two different providers, and it is
verifiable from `adapters.yaml` and from the two very different cost figures in beats 3 and
4 — but **the frame does not show it**. A caption may state it as fact; it may not point at
the screen as the evidence.

### Beat 2 — an untagged message, and nothing happens

|                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What it proves**   | Agents do not speak unless addressed, and this is a **structural** property rather than a prompt instruction: `summonRuling` is an allowlist over one event type with named refusals, and the activation boundary refuses generated text, non-room content, system output and agent-authored messages by name. Seven seconds of silence is held deliberately.                                                                                                                                                                                                                                                                                                                                      |
| **What it does NOT** | It does not prove agents cannot be **provoked** by content. Quoted and imported spans **do** activate today: `MessageEvent.payload` is one flat string with no span provenance, so a member who pastes a report containing `@sol` summons Sol. That is RT-004's accepted gap, pinned by a must-fail test, **still open after S1.5** and still triggered on S1.7. S1.5 satisfied RA-005 for the **promotion** path only — a promoted span is a `context.promoted` event, which the allowlist refuses, so a promoted `@sol` summons nobody — and that changed nothing about pasting the same words into a message. The silence shown is silence in the absence of a tag — not immunity to injection. |

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

|                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **What it proves**   | A real server-side evaluation against a real mandate document, producing a real `decision` row in the event log, rendered by a card whose **only possible input is that row**. `PROTECTED_ACTION` is the reason code the evaluator returned; Prince is the signer the mandate names (rendered from config — the identifier itself no longer reaches the screen); `sha256:1af314ca8427474e…` is the hash of the mandate that was actually in force. **Nothing merges** — no side effect was attempted and no integration exists to attempt one against. |
| **What it does NOT** | Five things, each of which a caption could get wrong. They are listed separately below because this is the beat that carries the whole film.                                                                                                                                                                                                                                                                                                                                                                                                           |

---

## Beat 5, in detail — the five things it does not prove

**1. Claude did not try to merge anything.** The request was issued **on Claude's behalf**
by a caller — the capture harness, standing in for the host sidecar that Bible §3.2
describes. **Agents cannot initiate structured actions at all:** `AgentTurnChunk` is
`text_delta | done | error`, with no tool-call channel, so there is no mechanism by which
Claude could have requested a merge. The evaluation is real and server-side. **The agency is
not.**

**S06-N3 is closed, and the underlying limit is not.** The take 6 card read
**"ATTEMPTED BY Claude"**, which asserted intent the product cannot produce, and this
document had to spend a paragraph telling an editor to narrate against the screen. UI2-4
replaced it with **"Requested under Claude's mandate."** — true, because the request named
Claude as its subject and was evaluated against Claude's mandate, and it claims nothing about
intent. S1.3 added the half that was missing: the card now names the requester too,
**"Requested by Prince under Claude's mandate."**, because the attribution is finally backed by
a record rather than by the caller's word. The film harness asserts the word "attempted" appears nowhere
on the card, so it cannot return.

That fixed the WORDING. It did not give any agent the ability to request anything, and this
entry stands exactly as it did before: **the request in beat 5 is still issued on Claude's
behalf by a caller**, and the agency is still not demonstrated. The screen no longer works
against the caption; the caption still has to be right.

**2. The mandate is unsigned.** There is no `sig` field, by design in v0 — omit, never stub.
A fake `ed25519:` string would have been worse than an absent one. The hash on screen proves
_which document was evaluated_, not that anyone authorised it. S2.1.

**3. The co-signature IS completable now (S2.2) — and merge execution is still absent.** Approve
and Deny are live for the REQUIRED SIGNER — the human bound to the decision's principal, and no one
else; an agent can never complete one. A signed approval releases the decision's action exactly
once. But on this `pr.merge` decision the release records the sign-off and runs **NOTHING**: there
is no executor until S2.6, so no merge occurs and **RT-005's `pr.merge`/ALLOW clause still holds** — and
S-CC does not touch it. `claude-code`'s effects (SCC-2 onward) arrive through a _summon_, which was never
an ALLOW verdict, so "no ALLOW causes an external side effect" stays true and remains S2.6's to end. What
S-CC retires is the **informal world-guarantee** the condition stood in for — _that the system causes
nothing in the world_ — which S-LIVE had already narrowed to "nothing beyond metered provider spend." The
bridged member `claude-code` **will**, once enabled (SCC-2), do real workspace work on a summon —
arbitrary, uncapped side effects — so the system stops promising that. **Take 13 predates that member and
that capability**: in this film **no governed action executed and nothing was merged, sent, or written to
any external system of record**. Its beats DO show real provider calls and real spend, which the ledger
classes as external — so say exactly that, and do **not** say "nothing left the system" or "the system
cannot cause a side effect." The weakening is the SYSTEM's, not this footage's. See the ledger's RT-005
retirement. The completion is demonstrated on an
INTERNAL action — a protected summon that fires on approval — in the heartbeat clip, a separate
asset (`docs/demo/s22-cosign-completes.md`); take 13 shows the paused card, which is still a true
moment: a decision awaiting a signature. A caption may say _a human signs and the paused action
proceeds_; it may **not** say that anything merged, because nothing did.

**4. There is no receipt and no hash chain.** §19's `audit` table does not exist. Nothing on
screen may be described as _signed_, _notarised_, _tamper-evident_, or _provable
afterwards_. The event log is append-only Postgres with a monotonic sequence — good, and not
a chain. S2.3.

**5. Both parties are now grounded; WHICH task the request is about is not.** S1.2 proved who
asked. S1.3 grounds the attribution: `request_action` is refused unless a RECORD entitles the
requester to name that subject — a task they delegated to that member, a handoff they performed
to them, or acting as themselves. S12-N2 is closed, and the card's sentence changed to match:
it reads **"Requested by Prince under Claude's mandate."** Both halves are in the record the
card renders from, so the sentence is one a reader can check.

**What is still unproven, and it is narrower than what it replaced.** The record is
EXISTENTIAL, not specific: it establishes that Prince delegated work to Claude in this room, not
that THIS merge request is the work he delegated. Standing does not expire either — a task
delegated once justifies requests under that member's mandate for as long as the room exists. A
caption may say _the request is grounded in a delegation on the record_; it may not say _Claude
was asked to merge this_. Tightening it means the request naming its task, which is S13-N1 with
**S2.2** as its trigger, because a co-signature has to reference a task anyway.

And the deeper limit under this beat has not moved: **the request is still issued on Claude's
behalf by a caller**, because no adapter can carry a tool call. Grounding who may ask on whose
behalf is not the same as an agent asking, and beat 5's caption still may not imply the second.

### Beat 6 — the work moves (SIX-BEAT VARIANT ONLY, take 11)

|                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What it proves**   | A task moves between the agents of **two different principals**, and the mandate reference travels with it: the handoff row shows `Prince → Sol`, the work (`pr.review`), and the hash of **Sol's** mandate — while the decision card two rows above shows **Claude's**. Two different documents in one frame. The task chip follows to `assigned`, not `working`, because nothing is running. Every field is read from a `task.handoff` row in the log; the refusals behind it (roster, mandate) are server-side and asserted by tests.                                                                                                                         |
| **What it does NOT** | **Nothing typed this.** There is no UI for a handoff — the composer sends chat and nothing else — so the harness sends the frame a host sidecar sends, exactly as in beat 5. A caption may not say that typing "@sol take review" moved the task. **Sol has not started the work, and cannot be made to:** a handoff triggers no turn, because an agent cannot be asked for work by anything but a human summon (there is no tool-call channel). **And the handoff conferred nothing:** Sol acts under Sol's mandate — the film shows the transfer being ALLOWED, and the tests show `pr.merge` being REFUSED to the same member. That refusal is not on screen. |

**The one sentence a caption may use:** _the task moves to Jerry's agent, and the mandate it will be
carried out under is Jerry's, not Prince's._ **Not:** _Sol takes over the review_ (nothing has
started). **Not:** _Prince delegates his authority_ (he delegates the work; the authority is Sol's
own, and narrower).

---

## Caption guidance

**Beat 5's honest caption:** _a merge request is refused against Claude's mandate, and a
human signature is required before it can proceed._

**Not:** _Claude tried to merge and was stopped._ **Not:** _the agent was blocked._ **Not:**
_a hijacked agent attempted a merge._ The mechanism is the claim. Agent intent is not
demonstrated anywhere in this film and must not be narrated.

Other wordings to avoid across the whole cut:

| do not say                                                             | because                                                                                                                           | say instead                                                                             |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| "signed receipt", "provable", "notarised"                              | no chain, no signatures exist (S2.3)                                                                                              | "recorded in an append-only log"                                                        |
| "verified identity", "we know who the human is"                        | a credential authenticates a PROCESS acting as a member; no login, no per-human key (S04-N2)                                      | "each connection authenticates as a member, and members are bound to principals"        |
| "the room is private", "only Prince can see it"                        | membership is enforced and there is no login: the web tier mints a socket ticket for anyone who can reach it (S04-N2)             | "the room admits only its own members"                                                  |
| "the mandate is authorised", "signed authority"                        | the mandate is an unsigned file; the hash proves which document, not who granted it (S2.1)                                        | "the mandate that was evaluated is recorded by hash"                                    |
| "Claude requested the merge"                                           | the requester is authenticated, the subject it names is not (S12-N2)                                                              | "a merge was requested under Claude's mandate"                                          |
| "the agent was blocked from merging"                                   | the agent never requested it, and could not                                                                                       | "a merge request against that member's mandate is refused"                              |
| "the card shows Claude attempted a merge"                              | the card has not said that since UI2-4, and it was never true                                                                     | "the card shows who requested what, and under whose mandate"                            |
| "approve it here" (in take 13)                                         | take 13 predates S2.2 and shows the paused card; completing a co-sign is a separate asset                                         | "a decision awaiting a signature; the co-signature completes in S2.2, shown separately" |
| "agents can't be tricked"                                              | quoted and imported content still activates (RT-004, S1.7)                                                                        | "an agent's own output cannot summon another agent"                                     |
| "isolated context per principal"                                       | one shared 30-message window today (S1.5)                                                                                         | "one shared room context"                                                               |
| "the mandate surface proves enforcement", "these limits are in effect" | the surface READS the document; limits aren't enforced (S2.7) and enforcement is beat 5's separate, action-specific demonstration | "the surface shows what the mandate requires, read from the document"                   |

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

## The mandate surface (UI3-3 — a new surface, not in take 13)

Take 13 shows a member's SCOPE on its chip. UI3-3 adds the rest of the mandate on tap — the co-signature
requirement, the declared limits, the policy version, the expiry **as a state**, and the hash that says
WHICH document is in force. It is read-only by construction (UI3-3c proves no write path exists) and every
control is disabled in its true position. The surface is captured at 390px in UI3-4; its claims apply to
that capture and are not optional.

|                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What it proves**   | Six fields READ FROM the member's mandate document — co-sign (which actions need a signature, and whose), limits, policy version, expiry, and the document hash — the same values the fabric loaded, not a caption of them. Expiry is shown as a STATE: a mandate past its `expires` reads **expired**, never as live authority with a stale date. The hash is truncated on screen but copyable in full, so WHICH document is in force is identifiable. A member with no mandate shows nothing; a mandate that grants or gates nothing shows an honest "none" — distinct from "not disclosed", which is a different fact.                                                                                  |
| **What it does NOT** | **It shows what a mandate SAYS, not that the server ENFORCED it on any particular action.** A disabled, checked co-signature control proves the mandate REQUIRES a signature for that action; it does not prove any specific request was gated — that is beat 5's separate, action-specific demonstration, and even there nothing merged. The **limits are DECLARED, not enforced** (no usage counters exist — S2.7), and the surface says so on its face. The hash proves WHICH document was read, **not that anyone authorised it** — the mandate is unsigned (S2.1), exactly as beat 5's hash. This is a faithful READ of the document, not evidence of enforcement, and a caption may not make it one. |

**The one sentence a caption may use:** _the surface shows the terms of a member's mandate, read from the
document the fabric enforces against._ **Not:** _the surface proves the mandate was enforced_ (it shows the
terms, not an enforcement). **Not:** _these limits are in effect_ (they are declared, not enforced — S2.7).

### UI3-4 — the surface, captured LIVE at 390px (a new artifact, not take 13)

The surface above is now recorded on the internet, on a phone-sized screen, against the fabric running on
a machine — a tester redeems a code, their member appears in the room, and the mandate opens. The artifact
lives at `playroom-capture/videos/mandate-take1/mandate-take1-stream.webm` (11.6s, 390×844), a NEW path;
**take 13 is untouched** (`videos-p0/take13/`, unchanged).

|                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **What it proves**   | The surface renders the LIVE fabric's mandate, not a local one — proven, not asserted: at capture time the `mandate_hash` on screen (`sha256:12f080…d35b`) was fetched from the live `/members` endpoint for the same member (`claude-main`) and the two were compared; a mismatch would have aborted the run. It was filmed against `playroom-web.fly.dev` via a redeemed tester code, at 390px, with every field in its true position and expiry reading `live`. |
| **What it does NOT** | It shows the surface rendering live mandate TERMS; it does **not** show the server refusing an action. No enforcement happened on camera — no request was made, gated, or denied. The liveness check proves the DOCUMENT on screen is the one the fabric holds; it does not prove the fabric acted on it. Enrolment is redeemed OFF-camera by design (a code must not appear in a frame), so the film shows the enrolled member and the surface, never the code.   |

**Caption:** _this is the live mandate, on a phone — the hash on screen is the one the running fabric
returned._ **Not:** _the fabric enforced this_ (the capture proves the surface is live, not that any action
was governed).

---

## Findings raised by this slice

| id         | finding                                                                                                                                                                                                                                                                                                                                                     | trigger                                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| S06-N1     | the capture harness's selectors rotted silently when S-UI rewrote the room — three stale selectors matched nothing rather than failing, and it lives outside CI                                                                                                                                                                                             | the next UI change to the room, or the next slice that films it                                                                                 |
| S06-N2     | the room header renders the room **id**; the room's `title` is rendered nowhere, so every frame carries a slug                                                                                                                                                                                                                                              | **S1.1**, when rooms acquire real membership and a name worth showing                                                                           |
| ~~S06-N3~~ | **CLOSED in UI2-4** — the card's "Attempted by" asserted agency the product does not have; it now reads "requested under … 's mandate". The LIMIT it described is unchanged and is stated in beat 5 above                                                                                                                                                   | closed as a wording defect. The limit itself lifts only when adapters carry tool calls (S1.3's handoff object), and beat 5's claim changes then |
| ~~S12-N2~~ | **CLOSED in S1.3.** A governed request is refused unless a record — a delegated task, a handoff, or acting as oneself — entitles the requester to name that subject. It also closed a hole wider than the finding said: `subject` was never checked to be a MEMBER, so a caller could name a string that referred to nobody and get a decision row about it | closed. The remaining looseness is S13-N1                                                                                                       |
| S13-N1     | the delegation record is **existential, not specific**: it establishes that the requester delegated work to that member in this room, not that THIS request is that work — and standing never expires. `request_action` naming its task is the tighter form                                                                                                 | **S2.2**, whose co-signature has to reference a task anyway                                                                                     |
| S06-N4     | **Bible §11 has no budget row for opening a room** — which is where the database wake now lands (ADR-008) and where a pilot's first action of the day pays it. The film's beat one opened in 454ms only because the harness warmed first; there is no written budget it could have breached                                                                 | **S1.1**, when rooms acquire real membership                                                                                                    |
