# Playroom UX Direction — GrokBot fan-out (19 Aug 2026)

_10-agent fleet (7 Haiku / 2 Sonnet / 1 Opus). GrokBot capability research + a code-grounded Playroom UX critique. Left local._

# Playroom UX Direction

## 1. The Thesis

**"I can see who decided what, and nothing happens to me without my hand on it."**

Not "governed multi-agent." The feeling is _legible custody_: a first-time user should feel that Playroom is the one place where people and their agents share a room as equals, every consequential move is a visible object with a name attached, and the user is never surprised. GrokBot sells you a coworker you message. Playroom sells you a **room with a memory of who is accountable** — the decision, the presence, the permission are all things you can point at. The product is the visibility of authority, not the automation.

Everything below serves that one sentence. If a change makes authority _more visible and more legible in plain language_, it's on-thesis. If it just adds capability, it waits.

---

## 2. The First Five Moves (ordered)

### Move 1 — Put the hero decision card on the landing page _(first impression)_

- **Kills:** The differentiator is invisible. A stranger sees `<h1>Playroom</h1>` and two unlabeled inputs and reads it as internal tooling. Ten seconds in, they cannot tell this from a chat window. (fix-list #2)
- **Change:** Port the static amber decision card + roster strip from `docs/design/landing-prototype.html` into the top of the page, above the form. Non-interactive is fine for v1 — it's an illustration of the thesis: _this is what a decision looks like here, colour = who, shape = kind._ The finished asset already exists and is orphaned; this is integration cost, not design cost.
- **Where:** `apps/web/app/page.tsx` (target) ← `docs/design/landing-prototype.html` (source).

### Move 2 — Make the landing page say what Playroom _is_, in one breath _(first impression)_

- **Kills:** "Create a room, then open it in two browsers" reads as a setup instruction for an insider. No framing, placeholder-only inputs, no reason to care. (fix-list #1)
- **Change:** One framing line above the form — _people and their agents in one room, with every decision made visible_ — then real labels on the inputs and plain help text ("Invite someone in to work alongside you and your agents"). Pair it directly under the Move 1 hero so the card _shows_ the claim and the sentence _names_ it.
- **Where:** `apps/web/app/page.tsx` (whole component, ~55 lines).

> Moves 1+2 ship together as the new front door. They are the entire first impression and both files are tiny. This is the highest-leverage block in the whole list.

### Move 3 — Show silent humans in the roster

- **Kills:** A human who joined and is reading is invisible until they speak — presence is asymmetric, which breaks Playroom's _own_ core principle ("the symmetry is the product"). It's a correctness bug visible on every multi-person room open, and the code already admits it was deferred. (fix-list #3)
- **Change:** Derive the human roster from the `roster` membership table, not the event log. Add a third chip state — _present-but-silent_ (dim chip, idle glyph) — alongside agent-with-mandate and human-has-spoken. No backend change; the data is already loaded.
- **Where:** `apps/web/app/r/[id]/Room.tsx` (roster composition ~467-489), `apps/web/app/MemberChip.tsx` (new idle state).

### Move 4 — Kill dead Approve/Deny buttons for non-signers

- **Kills:** Everyone who _can't_ sign still sees greyed-out Approve/Deny next to "Awaiting Prince." Disabled-but-present controls read as broken — and it's the first governance UI a newcomer hits. (fix-list #4)
- **Change:** For non-signers, remove the buttons entirely; replace with one sentence: _"Awaiting Prince to approve or deny pr.merge."_ Signers keep live buttons untouched. Tiny, isolated, high-visibility.
- **Where:** `apps/web/app/DecisionCard.tsx` (non-signer branch ~183-193).

### Move 5 — Define "mandate," or stop using the word

- **Kills:** The single word carrying the entire governance model is never explained in-product. A first-timer can't tell if it's legal, Playroom-specific, or filler — and bounces off the core idea. (fix-list #5)
- **Change:** Two parts. (a) Swap "mandate" for plain phrasing in user-facing reason copy: _"the room's rules allow this, but a human still has to sign off."_ (b) One inline first-use definition per session: _"A mandate is the set of permissions that say what an agent can do in this room."_ This directly serves the thesis — authority is only legible if its name is.
- **Where:** `apps/web/app/DecisionCard.tsx` (REASONS ~49-52), `apps/web/app/MandateSurface.tsx`.

---

## 3. The One Thing NOT to Copy from GrokBot

**Do not copy "sign in with your real credentials" — the shared-VM, one-owner, bots-log-into-your-accounts model.**

It is the most seductive thing GrokBot does (handoffs need no context copying because every bot shares one filesystem and one logged-in browser) and it is _exactly antithetical to Playroom's reason to exist_. GrokBot's convenience comes from collapsing all authority into one password inside one vendor's workspace. Playroom's entire wager is the opposite: **authority is scoped, named, and crosses ownership boundaries** — a grant you can point at and revoke, not a shared login. The moment Playroom copies the shared-credential trick to feel as frictionless as GrokBot, it deletes its own differentiator and becomes a worse single-vendor clone.

Concretely, this means: resist "just let the agent act as the user" shortcuts. Keep the raised-hand / interrupt path (`SCC-3`) as the seam. The friction of an explicit grant _is_ the product, the way a lock's click is the point of a lock. Where GrokBot optimizes the click away, Playroom makes the click legible.

---

## 4. Polish vs. Backend-First — the honest cut

**Ship-now UX polish (all five moves above + most of the list).** Every one of the first five is presentation-layer only, in a single small file each, reusing data that's already loaded. No API change, no schema change, no new events. Moves 6 (MandateSurface as sentences), 9 (relative timestamps in `LoopsScreen`) are the same story — pure render changes, safe to batch behind the top five.

**Needs backend before the UX is honest:**

- **Catch-up banner (#7)** and **recent-activity surface (#10)** need reliable reconnect-gap detection and an `order.cycled` / `decision.raised` / `interrupt.raised` event stream the client can summarize. The banner is a lie if the events feeding it aren't dependable — build the event fan-out first, then the banner, then fold #10 into it.
- **Notification trigger (#8)** is the one with a trust cost if shipped half-done. Narrowing push to `verdict=CO_SIGN` + `urgency=BLOCKER` lives in the **API push-trigger logic, not `apps/web`** — the PushControl toggle is cosmetic until the server stops firing on every `agent.turn.completed`. Do the server change and the UI toggle in the same block or not at all; a toggle that doesn't change behavior is worse than no toggle.

**Do not let the pitch outrun the build.** Two claims in the competitive synthesis are _roadmap, not shipped_, and the UI must not imply otherwise:

- **"Signed authority / delegation chain"** — the Drift piece (member + mandate + credential) is gated at Task 0. Until it lands, the landing hero and copy should say _"every decision has a name on it,"_ which is true today (the raised-hand interrupt is real and HTTP-reachable), **not** _"cryptographically signed portable authority,"_ which is not.
- **"Multi-owner room coordination"** — one prototype cycle measured, not a proven workflow. The hero card can show the _shape_ of cross-owner governance; the marketing sentence should stay at _"a room people and agents share"_ and avoid implying a shipped multi-party loop.

The move that would most change the pitch's _truth_ (not just the first five minutes) is verifying the provider-neutrality claim against the current code — auditing whether Claude Code behind the door has quietly coupled the governed-request path to one vendor's tool-calling conventions. That's not a UX task, but it's the load-bearing check under the whole "structurally different from GrokBot" story. Flag it for the next build block before anyone puts "provider-neutral" on the landing page.

---

**Steer for the next block:** ship Moves 1–5 as one front-door-and-legibility pass (all polish, all cheap, all on-thesis). Hold #7/#8/#10 until the event stream and push-trigger server work lands. Keep "signed" and "multi-owner" out of user-facing copy until Drift clears its gate — say what's true today (_decisions have names_) loudly, and let the roadmap stay the roadmap.

---

## Appendix A — Category map / where we win

# GrokBot vs. Playroom — Competitive Synthesis

## 1. The Category Map

**Table-stakes now** (GrokBot ships all of these; Cursor/Devin/Claude Code/Lindy/Notion converge on the same set):

| Capability                                                                       | Status                     |
| -------------------------------------------------------------------------------- | -------------------------- |
| Persistent cloud agent (survives disconnect, keeps files/browser/terminal state) | Table-stakes               |
| Natural-language task assignment, no workflow-builder UI                         | Table-stakes               |
| Per-action approval gates (allow once / always allow / deny)                     | Table-stakes               |
| Mobile push for approvals + status                                               | Table-stakes               |
| Centralized session/activity dashboard (running / needs input / done)            | Table-stakes               |
| Tool/integration status transparency (connected, used, failed)                   | Table-stakes               |
| Async work — agent runs while user is offline, reports on return                 | Table-stakes               |
| Audit trail / run history                                                        | Table-stakes, depth varies |

**GrokBot's actual differentiation** beyond that baseline: learn-by-demonstration (screen recording → reusable skill), bot-to-bot messaging in shared group chats with ownership handoff, and a shared-VM model where every bot in a workspace has the same browser/filesystem so handoffs need no context copying.

**What's still unsolved industry-wide** (their own docs/reviews admit this): approval fatigue on long multi-step jobs (repeated modals, no "approve all similar"), session memory loss on long conversations, weak live-status affordance ("is it still working?" requires a hover), and — most relevant to Playroom — every one of these platforms is a **single-vendor, single-owner** model. One provider, one account, one workspace boundary. Nobody in this research set has cross-owner rooms, portable signed authority, or a delegation chain that outlives the vendor relationship.

## 2. What GrokBot Nails in UX (steal these)

- **Message it like a coworker.** Onboarding = naming an agent + one sentence, not a builder. The metaphor ("hiring," not "configuring") measurably lowers activation energy — 1–2 minutes to first run per the research.
- **Approval shows before/after, not just a yes/no.** Current state → proposed change → expected impact, in the same card as the confirm button. This is the single highest-leverage trust move in the whole set — cheap to build, directly reduces "what did I just approve?" anxiety.
- **Learn by demonstration.** Recording a task once and getting a reusable skill back is a genuinely different onboarding path than writing instructions — worth studying even if Playroom doesn't build screen-capture itself; the underlying idea (capture a real transcript, turn it into a replayable procedure) maps onto Playroom's own delegation/room primitives.
- **Notifications grouped and identified by agent**, not generic pings — the user should be able to tell which agent needs them at a glance, not open the app to find out.
- **Work summaries land in the user's existing tools** (Notion/Drive/email), not a new inbox to check. Completion is reported into the surface the user already reads.
- **Escalation with full context**, not a raw error dump — when the bot can't proceed, it hands off reasoning + partial state, not a stack trace.

## 3. Where Playroom Can Win

Playroom's real, differentiated primitives — provider-neutral, cross-owner rooms, signed authority, delegation chain, verified experience — are things nothing in this research set has, because every competitor here is architected as one vendor's agents operating inside one user's accounts. That gap is the opening. Concretely:

- **Cross-owner rooms vs. GrokBot's single-workspace VM.** GrokBot's "shared computer" trick only works because all bots belong to one xAI customer. Playroom's room already supports owner-authored framing delivered to summoned members _and_ pullers across ownership boundaries (shipped in S1.7) — that's a structurally different claim: multiple parties' agents coordinating in a space neither of them unilaterally controls. GrokBot cannot do this without becoming a marketplace; Playroom's architecture starts there. **Status: real and shipped for the framing/delivery piece; the multi-owner room loop is not yet a finished, demoed workflow — the assembly-declaration defect blocking a full briefed cycle was only closed recently (S17-N1), and the "S-LOOP2 briefed cycle" note is explicit that only one real cycle has been measured, against a still-behind production tier. Say "prototype cycle proven once," not "shipped multi-agent coordination."**

- **Signed authority + delegation chain vs. GrokBot's "sign in with your real credentials."** GrokBot's approach — bots log into your actual accounts — is the _opposite_ of what enterprises and cross-party workflows will eventually need: an auditable, revocable, scoped grant that isn't a shared password. Playroom's governed-request path (channel → door → Claude Code → raised hand, S2.1a/b/SCC-2/SCC-3) is a real, working, HTTP-reachable approval-and-escalation mechanism today — that's ahead of GrokBot's approval UX in one respect: it's a protocol, not just a modal, so it can be driven by other software, not only a human tapping a button. **Status: the raise-a-hand / interrupt path is real and running. "Signed authority" and a full delegation chain with cryptographic provenance are not yet built — per memory, Drift (the piece meant to supply member + mandate + credential) is still held at its Task 0 gate. Until that lands, "signed authority" is a roadmap claim, not a shipped feature — do not present it to the owner as already differentiating in production.**

- **Provider-neutral vs. GrokBot's xAI-only stack.** GrokBot's docs are explicit that it's a Grok product with Grok's model, Grok's cloud VM, Grok's integrations. Playroom's positioning as provider-neutral (rooms, framing, and the request/approval path not welded to one model vendor) is a durable structural advantage _if_ it's actually kept vendor-agnostic in the implementation — worth auditing whether any recent work (Claude Code specifically as the executor behind the door) has quietly coupled the governed-request path to one provider's tool-calling conventions. **Status: unverified in this research pass — flag as a claim to check against the current codebase, not confirmed here.**

- **Verified experience vs. GrokBot's "trust us, here's an approval modal."** The industry pattern researched here (immutable audit log, replay, decision traces) is table-stakes-adjacent but nobody ships it as a _user-facing_ trust surface — it's positioned as compliance tooling for admins. Playroom's "raised hand" interrupt + poll-backoff protocol is closer to a verifiable interaction than a black-box approval click, because it's a discrete, inspectable event rather than a UI state. The steal from GrokBot here is presentational, not architectural: show before/after impact on the approval card (section 2, first bullet) — Playroom's mechanism is arguably more honest than GrokBot's already; it just needs GrokBot's clarity of presentation.

- **Approval fatigue is a real opening.** GrokBot's own users flag repeated-modal fatigue on long jobs as unsolved. Given Playroom already has a structured interrupt/hand-raise primitive rather than a bare modal, there's room to design "approve this class of action for the rest of this room-turn" as a first-class grant scoped to the delegation chain — something GrokBot can only bolt on as a UI toggle, because it has no underlying authority-scoping primitive to hang the grant on.

**Bottom line for the owner:** the differentiators are real in kind (rooms crossing ownership, a genuine interrupt protocol) but partially ahead of themselves in degree — one demoed cycle, not a proven workflow; a working escalation channel, not yet a signed/portable authority chain (Drift is the missing piece and it's gated). The honest pitch is "we have the shape GrokBot structurally cannot have," not "we already do what GrokBot does, plus more" — the latter isn't true yet on the authority/delegation axis.

---

## Appendix B — Prioritized fix-list

# Playroom UX Fix-List (prioritized, deduped)

Ordered by impact-to-effort. Items 1-5 are the ones most likely to change a stranger's first five minutes; items 6-9 are real but narrower; item 10 is the biggest lift and belongs last regardless of its severity rating, because it's a multi-surface redesign, not a fix.

---

## 1. Landing page explains nothing — "open it in two browsers" reads as internal tooling

**PAIN:** A newcomer lands on `apps/web/app/page.tsx` and sees `<h1>Playroom</h1>`, the sentence "Create a room, then open it in two browsers," and two unlabeled inputs (`placeholder="room name"`, `placeholder="slug (optional)"`). Nothing says what a room is, why two browsers, or what Playroom does that a normal chat doesn't. Confirmed at `apps/web/app/page.tsx:38-51` — this is the entire page, no hero, no framing copy.
**FIX:** Two changes, do them together:

- Rewrite line 39's help text to plain language ("Invite someone else into your room to see it together" or similar) and label the inputs instead of relying on placeholder-only text.
- Add one short framing paragraph above the form stating what Playroom is (people + agents in one room, decisions made visible) before asking the user to create anything.
  **WHERE:** `apps/web/app/page.tsx` (whole component, ~55 lines — small, contained file, cheap to touch).
  **SEVERITY:** High.
  **TYPE:** Table-stakes (every onboarding surface needs to say what the product is before asking for input; GrokBot clears this bar trivially with "message like a coworker").

## 2. Landing page has no hero object — the product's actual differentiator is invisible

**PAIN:** GrokBot's onboarding leads with a concrete value prop in one line. Playroom's designed differentiator — a real decision card showing amber/slate/green states, provenance made visible, a roster strip where colour = principal and shape = kind — exists as a _finished prototype_ at `docs/design/landing-prototype.html` (per design.md §13) but was never wired into `apps/web/app/page.tsx`. A visitor cannot see, in the first ten seconds, what makes this different from a chat window.
**FIX:** Port the hero section from `docs/design/landing-prototype.html` into `page.tsx` — at minimum, one static (non-interactive) amber decision card and the roster strip as illustration, placed above the create-room form. Full parity with the prototype is not required for v1; the form can stay as-is beneath it.
**WHERE:** `apps/web/app/page.tsx` (target), content sourced from `docs/design/landing-prototype.html` (source, currently orphaned).
**SEVERITY:** High.
**TYPE:** Playroom-only-win — this is the one thing GrokBot's reference material has no equivalent of (governance-as-hero-object). Shipping it is a differentiator, not a catch-up.

## 3. Humans vanish from the roster until they speak — presence is asymmetric

**PAIN:** `Room.tsx` composes the header roster from `agents` (every agent member, unconditionally, `Room.tsx:473`) and `humans` (only member ids seen as a `message` event author, `Room.tsx:480-489`). A human who has joined and is silently reading is indistinguishable from a human who never joined — the roster strip simply doesn't show them. This directly contradicts design.md §1's stated principle ("one room for people and their agents… the symmetry is the product") and the code's own comment at `Room.tsx:475-479` acknowledges the gap was deferred, not resolved.
**FIX:** Derive the human portion of the roster from `roster` (already a full membership table per S1.1b) instead of from the event log, and partition into three visual states instead of two: agent-with-mandate (unchanged), human-has-spoken (unchanged look), human-present-but-silent (new — dim/low-opacity chip with an idle glyph). This is a composition change in `Room.tsx` plus one new visual state in `MemberChip.tsx`; no new data is needed since membership is already a table.
**WHERE:** `apps/web/app/r/[id]/Room.tsx` lines 467-489 (roster composition), `apps/web/app/MemberChip.tsx` (add idle/silent chip state).
**SEVERITY:** High.
**TYPE:** Playroom-only-win / correctness fix — GrokBot doesn't have a symmetric human-agent roster to compare against; this is Playroom failing its _own_ stated bar, and it's cheap (roster data already exists) relative to how visible the bug is on every room open.

## 4. Disabled Approve/Deny buttons shown to people who can't use them

**PAIN:** When a decision awaits Prince's sign-off, every other viewer sees greyed-out "Approve"/"Deny" buttons next to "Awaiting Prince" text (`apps/web/app/DecisionCard.tsx:183-193`, the non-signer branch). Disabled-but-visible controls are a pattern GrokBot and ChatGPT users don't expect — buttons should be clickable or absent, not present-and-inert. It's the first governance UI a new user hits and it reads as broken rather than intentional.
**FIX:** For non-signers, remove the button elements entirely and replace with one sentence naming the decision and who's deciding it, e.g. "Awaiting Prince to approve or deny pr.merge." Signers keep the live buttons unchanged.
**WHERE:** `apps/web/app/DecisionCard.tsx` lines 183-193 (the `else` / non-signer branch).
**SEVERITY:** Medium (high visibility, but a small, isolated, low-risk change — bumps up in priority because of how cheap it is).
**TYPE:** Match-GrokBot (GrokBot's approval-gate UX shows controls only to the person who can act; everyone else sees a status line, not dead buttons).

## 5. "Mandate" is load-bearing jargon that's never defined

**PAIN:** "Mandate" appears throughout `DecisionCard.tsx` (reason strings, e.g. lines ~49-52) and structures the entirety of `MandateSurface.tsx`, but the word is never explained in-product. A user new to delegation systems has no way to know whether it's a legal term, a Playroom-specific concept, or filler copy — and it's the single word carrying the product's core governance idea.
**FIX:** Two changes:

- Swap "mandate" for plain-language phrasing in the reason copy that renders to users (e.g. "the rules for this room allow this, but a human still has to sign off").
- Add a one-line inline definition (tooltip or first-use footnote) the first time "mandate" appears per session: "A mandate is the set of permissions and rules that say what an agent can do in this room."
  **WHERE:** `apps/web/app/DecisionCard.tsx` lines 49-52 (REASONS strings); `apps/web/app/MandateSurface.tsx` (all user-facing copy).
  **SEVERITY:** High.
  **TYPE:** Table-stakes — "say it as a person would" is design.md's own bar (§5), and this is the single word most likely to make a first-time reader bounce off the governance model entirely.

---

## 6. MandateSurface reads as a database dump, not an explanation

**PAIN:** `MandateSurface.tsx` (lines 40-143) renders mandate details as a definition list — `Status: live · expires 2026-09-15`, `Co-signature: merge requires a co-signature by prince` — field-label-and-value, not sentences. Violates design.md §5 ("sentences, not form labels") and compounds finding #5: even after "mandate" is defined, the surface that's supposed to explain the mandate reads like a schema.
**FIX:** Rewrite the render to compose 2-3 plain sentences from the same underlying fields — "Claude can act in this room until Sept 15. Before Claude runs a merge, Prince has to approve it." — instead of a labeled list. Data model doesn't change, only the presentation layer.
**WHERE:** `apps/web/app/MandateSurface.tsx` lines 40-143 (the entire definition-list structure).
**SEVERITY:** Medium.
**TYPE:** Table-stakes.

## 7. No catch-up summary on return — user has to hunt the transcript for what happened

**PAIN:** GrokBot surfaces "agent X completed task Y — needs your decision" the moment you reopen the app after being away. Playroom just reconnects the socket and shows the transcript tail; there's no banner summarizing turns completed, loop cycles fired, or decisions now waiting. Contradicts design.md's "calm by default" promise, because calm-by-default requires _something_ to tell the user there's nothing to worry about (or exactly what needs them) — silence forces manual scrolling instead.
**FIX:** Add a dismissible "while you were away" banner to the room header that fires on reconnect-after-gap, summarizing turn count / loop cycle count / pending-decision count with a jump link to the first unread item.
**WHERE:** `apps/web/app/r/[id]/Room.tsx` — new `CatchUpBanner` component, rendered in the header, conditioned on (a) socket reconnected after a drop, (b) gap between last-seen event and now exceeds a threshold, (c) not yet dismissed this session.
**SEVERITY:** High.
**TYPE:** Match-GrokBot (this is GrokBot's most direct win over Playroom in the reference material — async-first, results-not-hunting).

## 8. Push notifications fire on every turn, not just on things that need the user

**PAIN:** Notifications trigger on `agent.turn.completed` — every turn, including routine background work — rather than only on decisions or interrupts. PushControl's own copy promises "notify me when something needs me" (line ~195) but the trigger doesn't match the promise; a user's phone gets woken for work that required no action from them.
**FIX:** Narrow the default trigger to decision-raised (`verdict=CO_SIGN`) and interrupt-raised (`urgency=BLOCKER`) events only. Keep a secondary, off-by-default toggle in PushControl for "also notify on completed standing-order cycles" for users who want the noisier stream.
**WHERE:** `apps/web/app/PushControl.tsx` (the toggle UI) plus the server-side push-subscription/trigger logic that decides which events fan out (not in `apps/web` — API layer).
**SEVERITY:** High (breaks trust in the notification channel once it happens a few times — user memory already flags push as "SHIPPED and observed... through Do Not Disturb," so getting the trigger right matters more, not less).
**TYPE:** Match-GrokBot (GrokBot's approval-gate model interrupts only at decision points, not on every completed step).

## 9. "Last fired" timestamp forces mental math instead of showing elapsed time

**PAIN:** `LoopsScreen.tsx`'s `fired()` helper (lines 31-35) renders a locale timestamp like "3:45 PM." Returning from hours away, the user has to do arithmetic against the current time to know if that's recent or stale — exactly the away-and-return moment this UI should make legible at a glance.
**FIX:** Make relative duration ("fired 3 hours ago") the primary display, with the full timestamp as a secondary `title` attribute or small subtext. Consider live-updating it (e.g. every 60s) so it doesn't go stale while the tab is open.
**WHERE:** `apps/web/app/r/[id]/loops/LoopsScreen.tsx` lines 31-35 (`fired()` helper) and its call site around line 158.
**SEVERITY:** Medium.
**TYPE:** Table-stakes (relative timestamps are the default expectation in essentially every modern async tool — Git, Slack, GitHub all do this).

---

## 10. No "recent activity" surface for standing-order completions

**PAIN:** A loop can fire and complete several cycles with only a quiet `OrderChip` update in the transcript — no badge, no summary, nothing that says "your standing order did work" unless the creator happens to notice the chip changed and scrolls to find it.
**FIX:** Add a lightweight "recent activity" section (header or sidebar) listing recent `order.cycled` / `decision.raised` / `interrupt.raised` events with a jump-to link; alternatively, a transient toast when a cycle completes while the room is open.
**WHERE:** `apps/web/app/r/[id]/Room.tsx` — new activity component in header/sidebar, or a transient in-transcript card.
**SEVERITY:** Medium.
**TYPE:** Match-GrokBot (routines/scheduled-automation reporting). Placed last because it overlaps materially with #7's catch-up banner — implement #7 first and this may reduce to "make the catch-up banner also count order cycles," which folds most of the work into an already-planned component rather than a separate build.

---

## Notes on prioritization logic

- **#1-#2 (landing page)** lead because they're the very first thing anyone sees, both files are small (`page.tsx` is 55 lines) and the hero content for #2 already exists finished at `docs/design/landing-prototype.html` — this is an integration cost, not a design cost.
- **#3 (presence)** ranks just behind the landing fixes because it's a correctness bug against Playroom's own stated principle, visible on literally every room with more than one human, and the fix reuses data (`roster`) that's already loaded — no backend change needed.
- **#4-#5 (disabled buttons, "mandate" jargon)** are cheap, isolated, high-visibility text/branch changes in a single component each — high ROI even though severity is medium/high rather than critical.
- **#6-#9** are real but each is scoped to one component and lower first-impression weight than the top five — a returning user, not a new one, is who's most affected.
- **#10** is placed last and flagged as overlapping #7 because building it independently risks shipping two half-redundant "here's what happened" surfaces; sequencing #7 first is the efficient path.

File written to: `C:\Users\princ\AppData\Local\Temp\claude\C--Users-princ-Documents-playroom\f71a9847-d0cf-48ec-ba1b-c909f669dc72\scratchpad\playroom-ux-fixlist.md`

Grounding checked against the actual repo (not just the critiques' claims): confirmed `apps/web/app/page.tsx` is 55 lines with the exact copy quoted at line 39, and confirmed `apps/web/app/r/[id]/Room.tsx` lines 467-489 match the described agents/humans roster split including the developer's own deferred-fix comment at 475-479.
