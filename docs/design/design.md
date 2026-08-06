# PLAYROOM — design.md (v3)

**Owner:** Prince · **Status:** adopted for all UI slices · **Supersedes:** v1 (DOC-1) and v2 (owner PDF, 30 Jul 2026, never landed) · **v1 is archived verbatim** at `docs/design/design-v1.md` — every "v1 §n" pointer below resolves there, in-repo, not in git history.

**Precedence:** where this document and a generic design skill (Impeccable, etc.) conflict, THIS document wins — it holds product rulings a craft skill cannot override (DOC-1 settled this once; it stays settled). Changing a numbered ruling requires an owner ruling; everything else is a PR.

**Version log.**

| version | what it was                                                                                                                                                                                                                                                                                       | where it went                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| v1      | The full contract (shell, composer, cards, flows, tiers, tokens), landed by DOC-1 with reconciliations R-1…R-7 and divergences now renamed DIV-1…DIV-3                                                                                                                                            | Merged here; archived at `design-v1.md` |
| v2      | The rulings layer (anti-goal, D-1/D-2, reserved colours, density gradient, motion, terminal panel), owner PDF only                                                                                                                                                                                | Merged here; superseded                 |
| v3      | This document: one buildable contract. New: true-black dark mode (D-3), the landing page (§13, D-4), the motion vocabulary (§6), and the "what NOT to add" discipline. Revised same day by WF-review wf_9c9d8e5e (26 findings): restored v1 content F1/F2/F3/F7, amended D-4, re-anchored accents | Current                                 |

**ID scheme (collision fixed).** v1 used `[D-1..D-3]` for _divergences_ while v2 used `D-1/D-2` for _rulings_. From v3 on: **D-n = owner rulings** (D-1 colour, D-2 shape, D-3 dark, D-4 honest marketing), **DIV-n = recorded divergences** between this document and shipped code (v1's [D-1..D-3] are now DIV-1..DIV-3). Older session notes that say "[D-1]" about the amber card mean DIV-1.

---

## 0. THE ONE RULE ABOVE ALL OTHERS (the anti-goal)

**Nothing in the UI may render a mandate, decision, block, receipt, or any governance state the event log did not produce.**

Every chip, card, switch, and status either reflects a real record/event, or is visibly disabled with an honest label. There is no third state. A settings screen, a mock, a "make it look done" pass — these are exactly where this rule slips, because a nicer surface invites a nicer story. When in doubt: if you can't point to the event that produced what's on screen, it doesn't go on screen.

This is not a style rule. It is the product. Playroom's entire claim is that what you see is what the fabric enforced. A UI that can show a block the fabric didn't produce makes the whole product a lie.

**The believability warning.** Every increase in readability is an increase in believability. Rendering `principal:prince` as **Prince** makes an unverified assertion read more like fact while staying exactly as unverified. Until S1.2-grade identity is fully enforced, polish applied to an unauthenticated claim is a lie amplifier — keep the claims sheet honest about what identity actually proves.

## 1. POSITION & PRINCIPLES

Playroom is **one room for people and their agents** — never "a workspace for agents." The symmetry is the product: humans and agents in one member list, one thread, one record. Copy that renders humans as spectators of agent work has the emphasis backwards; the human holds the pen (co-sign), the agents hold the pace.

Position: the calm of Claude, the utility of Slack, and one signature of our own — **provenance made visible**. Every agent message carries who it speaks for and what it may do; every commitment is a card, not a sentence. That is the thing no other chat surface shows, because no other chat surface knows it.

**Principles (priority order):**

1. **The thread is sacred.** One centered column (~720px spec; shipped 860px — DIV-3), nothing competes with it; chrome lives in collapsible sidebars.
2. **Provenance one glance away** (amended R-3): encoded on the message (colour + shape in the byline), spelled on the roster, spelled in full on every decision card. Never restated in prose per turn — that is a debug view, not a room.
3. **Trust states have exactly three colours** — amber / green / slate — plus indigo for the interactive brand. §3 governs.
4. **Spend is ambient, never nagging.**
5. **Calm by default.** Agents are silent until summoned, and the UI matches — no badges begging, no pulse animations, motion only when something real happens.
6. **Familiar before clever.** If Claude/ChatGPT users would hesitate, redesign it.

## 2. IDENTITY: HOW A MEMBER LOOKS (rulings D-1, D-2)

Three facts must be legible about every member — who they are, whose authority they carry, what they may do — but NOT all three restated in prose on every message. Use the density gradient (§4).

**D-1 — Colour keys to the PRINCIPAL, never the provider/adapter.** Each principal gets an accent colour; their agent inherits it. Prince and Claude share one accent; Jerry and Sol share another. This answers "whose authority does this agent carry" with zero words and survives a room with four principals. Never key colour to the adapter — that makes the surface provider-aware, the same failure class as a provider name leaking on screen (R-2's history). The code must not know providers; neither may the palette.

**D-2 — Shape keys to KIND; the name carries the binding.** Humans = circle. Agents = rounded square. Must be legible with colour removed entirely. Agent display name is **Claude (Prince)** — the binding as the name; no word does the work the shape and name already do. Humans render as their name in their colour (**Prince**), never `principal:prince` — an internal identifier reaching the surface is the `mandate_label` category error. No "speaks for" phrasing anywhere in the transcript: the roster spells it; the transcript encodes it; the card states it in full.

**Avatars:** person glyph for humans, robot glyph for agents, inside the existing shape+colour. Inline SVG only — no stock images, no licensing.

## 3. COLOUR (ruling: state colours are reserved)

**Reserved — may NEVER be used decoratively or as a principal accent:**

| colour            | meaning                                                       | never                     |
| ----------------- | ------------------------------------------------------------- | ------------------------- |
| **Amber**         | needs-a-human (CO_SIGN, pending decision)                     | decoration, accents       |
| **Green**         | signed-and-done (approved, verified)                          | decoration, accents       |
| **Slate**         | BLOCK / refused-and-informational                             | —                         |
| **Indigo**        | the BRAND / interactive token ("you can act here")            | a principal accent        |
| **Red** (`--bad`) | genuine error/refusal the member must not mistake for success | severity gradients, blame |

**Principal accents** are drawn from a non-indigo, non-amber, non-green set; they carry identity only, never state. The palette holds four principals and wraps at five (UI2-N1, resolved when S1.1 makes principals real records).

**Accent anchoring (v1 §9, carried forward — it caught a real bug the same day it was restored):** the accent hues are chosen _around_ the state colours — `--ok` sits near hue 142, `--warn` near 28, `--bad` near 0 — so no accent lands on a state hue. **Rose is nearest `--bad` and is therefore assigned LAST, after the other three; even then the two never co-occur in one element.** Any dark-lift of an accent must preserve this distance (a lifted rose `#fb7185` is indistinguishable from `--bad-d #f87171` — forbidden pairing; the landing prototype shipped it once, WF-F5, fixed to the magenta family). Colour is never the only channel: human-vs-agent is carried by shape and fill, verified against a grayscale frame (S-UI2).

**Card chrome carries STATE; chips inside a card carry IDENTITY.** An amber card containing a cyan member chip is correct, not a clash. Never conflate the two axes.

**Decision-card colour keys to the VERDICT, not the card type:** CO_SIGN → amber; BLOCK → slate; resolved co-sign → collapses to green. (This resolves DIV-1's substance: the shipped indigo card contradicts this ruling and is the shell slice's to fix.)

**Light tokens — as shipped** (`apps/web/app/globals.css`):

| role            | token                                          | value                             |
| --------------- | ---------------------------------------------- | --------------------------------- |
| ink             | `--ink` / `--ink-2` / `--ink-3`                | `#0f172a` / `#475569` / `#94a3b8` |
| surfaces        | `--paper` / `--paper-2` / `--line`             | `#ffffff` / `#f8fafc` / `#e2e8f0` |
| interactive     | `--indigo` / `--indigo-soft` / `--indigo-line` | `#4338ca` / `#eef2ff` / `#c7d2fe` |
| needs a human   | `--warn` / `--warn-soft`                       | `#b45309` / `#fef3c7`             |
| signed and done | `--ok` / `--ok-soft`                           | `#15803d` / `#dcfce7`             |
| refused         | `--bad` / `--bad-soft`                         | `#b91c1c` / `#fee2e2`             |

**Accent re-slot required (DIV-4).** Shipped `--p0` is `#4338ca` — indigo — which D-1 + the reserved table now forbid as a principal accent. The accent set is re-drawn without indigo at the shell slice: `--p0` cyan-teal (`#0e7490` family; dark-lift `#3fd4e0`), `--p1` magenta (`#a21caf` family; dark-lift `#c862da`), `--p2` `#be185d` family, `--p3` rose **last per the anchoring rule above**. Until then the shipped indigo `--p0` is a recorded divergence, not a precedent.

## D-3 — DARK MODE IS TRUE BLACK (new ruling, 6 Aug 2026)

Dark mode is **first-class and designed now** — it is the landing page's only mode and the app's second theme. The ground is **proper black, never navy**: no `#0F172A`, no `#123655`, no blue-cast neutrals anywhere in the dark theme. **Neutrals carry zero hue; chroma belongs to identity and state only.** That one sentence is the whole ruling — a "dark blue-grey" theme is the generic default this product refuses.

**Dark tokens (normative for landing + app dark):**

| role            | token                           | value                             | note                                            |
| --------------- | ------------------------------- | --------------------------------- | ----------------------------------------------- |
| ground          | `--void`                        | `#000000`                         | OLED-true page ground                           |
| raised          | `--panel` / `--panel-2`         | `#0a0a0b` / `#121214`             | hue-free lift                                   |
| line            | `--line` / `--line-2`           | `rgba(255,255,255,.08)` / `.16`   | hairlines                                       |
| ink             | `--ink` / `--ink-2` / `--ink-3` | `#ededed` / `#9d9d9d` / `#8a8a8a` | equal-RGB neutral; 15.1 / 7.8 / 5.1 :1 on black |
| interactive     | `--indigo-d`                    | `#8b8dff`                         | brand lifted for black ground                   |
| needs a human   | `--warn-d` / wash               | `#f2a93b` / `#181106`             | wash = solid dark equivalent of 10% over black  |
| signed and done | `--ok-d` / wash                 | `#3dd68c` / `#061509`             |                                                 |
| refused / block | `--slate-d` / wash              | `#8b94a1` / `#0e0f10`             |                                                 |
| error           | `--bad-d`                       | `#f87171`                         | never adjacent to a rose accent (§3)            |

Contrast floor stays 4.5:1. `--ink-3` (5.1:1) is for caps/labels at ≥11px; body text uses `--ink-2` or brighter. **Dark card chrome** renders v1 §5's card language on black: 3px LEFT border in the verdict colour + the verdict's dark wash as fill (not a top strip — WF-LAND-7 recorded this as a decision, not a drift). The launch film's shipped asset stays **light** (v2's amendment stands — do not leave a written instruction the delivered asset ignores); dark is now a designed theme, not a P1 afterthought.

**A11y (v1 §9, carried forward):** 4.5:1 minimum on both grounds, visible focus rings (indigo — and the ring never mutates element geometry), streaming text in `aria-live="polite"`, cards keyboard-operable, chips reachable.

**Shape (v1 §9, carried forward):** radius 16 composer/cards, 12 chips, 8 inputs. The app ships `--radius: 8px`; the shell slice reconciles this.

## 4. THE DENSITY GRADIENT

- **Roster strip** — dense, once, at the top: full affiliation + compact mandate indicator per member. This is what the film records; density is deliberate here.
- **Transcript** — sparse: name, colour, shape, message. The message text is the largest thing on screen. No repeated chip per turn.
- **Decision card** — dense again, because authority is the subject at that moment.
- **Full mandate detail** — on demand (tap/hover a roster entry), never permanently on screen.

The compact mandate indicator (`review-only`, `review + merge (co-sign)`) **derives from the mandate's scope/protected_actions — never a hand-written string**. A member with no mandate shows no mandate text, never an implied "unrestricted."

## 5. THE DECISION CARD

The card is the product's most credibility-carrying surface. It is screenshotted into the pitch — and it is the landing page's hero object (§13).

- **Sentences, not form labels.** Kill uppercase grey field labels (`ATTEMPTED BY`, `STOPPED BECAUSE`). Say it as a person would: the action, who it was requested for, why it stopped, whose signature it needs. "Needs Prince's signature," not "REQUIRES a co-signature from principal:prince."
- **"`pr.merge` requested under Claude's mandate"** — NOT "attempted by Claude." Agents cannot attempt anything until the tool-call channel carries it (R-7 / S06-N3); the request names Claude as subject and was evaluated against Claude's mandate. Claim the evaluation, never the agency — until S1.8+ tool-calls make agency real, then update honestly.
- **The mandate clause that triggered the card gets one line** (v1 §5.1 / R-1) — e.g. _merge requires co-sign_ — the card states its cause, not only its demand.
- **Reason code present but demoted** — `PROTECTED_ACTION` as a small tag, never embedded mid-sentence. The code→sentence mapping is a REVIEWED lookup table (it stated something false once; no test asserts prose).
- **Mandate hash present but quiet** — monospace, small, truncated. It is the proof; it must be on screen for the film without competing with the sentence.
- **Actions: `Approve` (amber solid) · `Deny` · `Downgrade`** (v1 §5.1 — Downgrade stands). Live ONLY for the required signer (post-S2.2); every other member sees them inert with the signer named. There is no third render: a live Approve beside a "only X can sign" label is a state no viewer ever sees (WF-HON-1 caught the landing shipping exactly that chimera). Before the co-sign machine exists, buttons are disabled and labelled with what unlocks them — and must not read as actionable.
- **Resolved state collapses to one line: the outcome and who signed** (v1 §5.1).

**The three cards stand** (v1 §5, anatomy binding):

1. **DECISION** (amber, verdict-keyed per §3) — as specified above.
2. **RECEIPT** (green) — check glyph, human-readable terms, signer chips, timestamp, and a **verify link (S3.5)**. The artifact of the whole company; it should look like something you'd keep.
3. **NOTICE** (slate) — failures, freezes, budget-degrade. Informational, never blocking.

No fourth card type. Resist inventing one.

## 6. MOTION (vocabulary + rules)

Motion is most of what separates a polished product from a form with buttons. It belongs in the **shell slice**, not sneaked into functional slices.

**The vocabulary — three entrances, one easing.** All app + landing entrance motion uses exactly:

```css
--ease-out-quiet: cubic-bezier(0.22, 1, 0.36, 1);
.animate-rise {
  animation: rise 0.6s var(--ease-out-quiet) backwards;
} /* opacity 0→1, translateY(24px)→0 */
.animate-fade {
  animation: fade 0.8s ease-out backwards;
} /* opacity 0→1 */
.animate-zoom {
  animation: zoom 1.2s var(--ease-out-quiet) backwards;
} /* opacity 0→1, scale(1.05)→1 */
@media (prefers-reduced-motion: reduce) {
  /* all three disabled, full stop */
}
```

Named, few, and reused — not per-component bespoke curves. Micro-transitions (hover, focus, chip settle) stay 150–200ms ease-out. Streaming caret shimmer and the card's one gentle settle stand from v1. **Hidden-until-animated is a JS enhancement, never the resting state: no-JS renders everything** (WF-JS-1).

**Rules:**

- **Motion never invents state.** An animated card still renders only what the log produced.
- **Motion serves legibility, not decoration.** A transition that makes a state change readable earns its place; a flourish that doesn't, doesn't.
- **Promoted/imported content appears visibly distinct from native record** (v2 §5) — motion and styling may never let imported history read as fabric-produced record.
- `prefers-reduced-motion` kills all of it — entrances, ambience, shimmer.
- **Framer Motion** is the app's motion layer (springs, gestures, layout, presence) and enters ONLY at the shell slice, so craft and motion land together, once. Functional UI slices stay tokens-only. The landing page (§13) is not the app: it uses the CSS vocabulary above + canvas, no Framer dependency.
- **Remotion is NOT this** — it is for the P3-era launch video, filed separately, never an app dependency. (Checked 6 Aug 2026: not installed anywhere in the repo.)

## 7. TYPE

| role                                      | face                                                                                                    | rules                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Display (landing + dark shell headlines)  | **Archivo 800**, uppercase, tracking −1..−2%                                                            | headlines only; never body                           |
| Body (app)                                | **Inter** intended (v1 §9; adoption is the shell slice's font dependency) — shipped today: system stack | tabular numerals for costs and seqs                  |
| Body (landing)                            | Archivo 400                                                                                             | ~65ch measure, 1.5–1.6 line-height                   |
| Mono (hashes, labels, receipts, terminal) | **IBM Plex Mono**                                                                                       | caps labels get +8..22% tracking, ≥11px              |
| Light-app warmth serif (Source Serif 4)   | OPEN-2, unchanged                                                                                       | belongs to the light shell decision, not this ruling |

The display face is licensed once, subset, and self-hosted. No font CDNs at runtime.

## 8. THE TERMINAL PANEL (agreed, after S-CC)

A terminal glyph in the room opens a panel that slides over the thread — not a new screen. The terminal is a member's capability rendered in-place.

- `shell.read` (ls, cat, git status, tests) — scoped, runs freely, streams live, costs nothing.
- `shell.write` / secrets / deploys / rm — protected: a command-PREVIEW card (same visual language as the decision card) pauses for co-sign. The co-sign approves that EXACT command string (S2.2 stale-check applied to shell).
- Saved commands — the handful actually run (deploy, tests, status) as one-tap pre-scoped buttons.
- Watching CC's live terminal workflow ships FIRST (read-only; watching ≠ running).
- Never used for pasting secrets/keys — some things stay hand-typed at the machine, and the mandate enforces that.

## 9. THE APP SHELL (unbuilt — the shell slice)

The shell slice owns the app shell, composer, and surfaces. The binding specs (v1 §2–§8, archived in full at `design-v1.md`; load-bearing details inlined here so this document stands alone):

- **Shell:** left nav (workspace switcher, Spaces, rooms with unread markers, **Pending — the only badge in the app**, settings; icon rail <1200px, sheet on mobile) · centered thread (date dividers, quiet system lines, infinite upward scroll via seq) · right context sidebar (Roster, Tasks, Receipts, Spend), collapsed by default on first visit, remembers state per room · top bar: room name, facepile, `/freeze` under a shield, search — nothing else.
- **Composer** (the single most-touched element): one rounded container, placeholder `Message the room — @ to bring someone in`, multi-line to ~8 then scrolls, Enter sends / Shift+Enter newline, attach inside the field, send affordance appears only when there's content and must not wear a principal's colour (DIV-2). @-popover lists humans and agents together — the symmetry is the product — with a one-line scope hint for hosted agents. Exactly three slash commands: `/freeze` (amber confirm dialog), `/export` (room → markdown), `/help`. While an agent streams, the composer stays enabled with the quiet line "Claude is replying — sending will interrupt at the next sentence" — **which may not ship before interrupt semantics exist** (DIV-1's copy half).
- **Message anatomy:** human = avatar/name/body, left-aligned including your own (OPEN-4). Agent = glyph with principal-coloured ring (R-2), streaming caret in the member's accent, quiet cost footer on completion (`1.2k tokens · £0.002 · 2.1s`), errors as slate in-thread cards with `error_class` and a retry affordance — never a toast, never silence.
- **Entry flows (v1 §6, all five stand):** blank start in under ten seconds (empty-room line: `Quiet in here. @ someone — human or agent.`); import-a-chat as hero onboarding with history **provenance-tagged as imported** (quieter, "imported" chip — the §6 distinctness rule's origin); invite link; connected member (ADR-004) with consent copy **exact**: _"Playroom will let this assistant read rooms you're a member of and act in them — under permissions you set. It cannot read your other chats. You can revoke this any time."_; bridged members with grey dot + origin note.
- **Surfaces (v1 §7):** web canonical; mobile = installable PWA wrapper, push for BLOCKER/DECISION only. **MCP text surface (P4):** tool outputs are tight markdown; `list_pending_tags` = numbered list, one line per item (room, asker, ask); `read_room` = last N messages with provenance inline (`[Claude · for Prince · review-only]`); every mutating tool's confirmation ends with the room's canonical URL. Reads like a well-behaved terminal, not a webpage forced through a straw.
- **Tiers (v1 §8):** **trust is never paywalled** — receipts, co-sign, audit, `/freeze`, provenance identical on every tier. Connected members unlimited on free. Paid buys capacity and reach. Gating = quiet inline NOTICE at the moment of need (`This room's hosted minutes are done for today — upgrade or continue with connected members`) — never a modal mid-task, never a lock icon shaming the sidebar.
- **States (v1 §10):** every view ships empty/loading/error designed, not defaulted; the reconnect replay (`catching up…`) is a visible moment of quality.

**Sequencing ruling:** ship the loop and get people using it first, THEN the shell slice — real use reveals which UI matters. Exception: if testers are imminent on a public link, the shell jumps up. First impressions on a public URL outweigh the loop for people who aren't Prince.

## 10. PHONE-FIRST

The loops screen and any control surface are phone-first — base CSS is the 390px layout, not a narrowed desktop. The whole point is steering from your pocket. **Real-glass rule:** a narrowed browser is NOT a phone; every mobile surface is verified on real glass before it's called done — flagged for Prince, never assumed from a viewport.

## 11. HARNESS DISCIPLINE (every UI slice)

- Stable hooks owned by the app on every element the capture harness depends on.
- The harness fails LOUDLY on a zero-match selector — a selector matching nothing is a failed take, not an empty result (RT-001's shape in a test harness).
- Assert the rendered surface, not only the source — a provider name reached the screen once while the provider grep was clean. Take assertions for provider names and markdown artefacts stay.

## 12. NON-GOALS (v1 UI)

No message editing or deletion (append-only truth; a correction is a new message). No reactions (OPEN-3). No threads-within-threads. No themes beyond light/dark. No DMs — a DM is a two-member room. No read receipts. No typing indicators for humans (agents show working state via task chips).

## 13. THE LANDING PAGE (new, 6 Aug 2026 — rulings D-4 + direction)

**Direction (owner pick, 6 Aug 2026): "Quiet, deliberate" × "Console".** Vast black restraint, one confident display headline — and the **real decision card as the hero object**. The receipt is the product; the landing page leads with it.

**Voice ruling — humans AND agents, always.** The page never reads as an agent workspace humans supervise. The frame is one room, two kinds of members, one record; the human holds the pen. Reference wording: "Agents move fast. You hold the pen." / "Agents hold the pace; a person holds the pen." Copy that casts the human as an observer of agent work fails review — including copy that assigns _all the work_ to agents ("the agent does the work" failed WF-COPY-2).

**D-4 — Honest marketing.** The landing page obeys §0 in spirit: it may depict only **surfaces the product renders or the adopted contract specifies, in states the fabric could actually produce** — and it must say which register it is speaking in (a page shipped before the shell slice claims the contract, not the code; "exactly as the room renders it" was false while DIV-1 stands, WF-HON-2). Concretely banned: invented metrics, fabricated testimonials or logo walls, "live" badges on static content, screenshots of unbuilt features presented as shipped, and CTA buttons that fake a flow that doesn't exist (a CTA may scroll to an honest "access is manual for now" section until a real flow ships). **One producible world:** every specimen on the page must be mutually consistent — the same members, the same mandates, verdicts derivable from those mandates (a "review-only" Sol with a deploy CO_SIGN pending is an impossible world, WF-LAND-2). The pitch is composure, not volume — trust is the product, so the marketing must be the one thing other landing pages aren't: true.

**Hero spec:**

- Ground `--void` true black (D-3). Eyebrow: mono, tracked caps. Headline: Archivo 800 uppercase, clamp to ~2 lines on 390px.
- Hero object = one amber CO_SIGN decision card, exactly as §5 specifies: sentence copy, the mandate clause, demoted reason tag, quiet mono hash, and the **observer's render — Approve · Deny both inert, the signer named beside them**. Never the signer's live buttons on a public page, never a mixed render.
- Ambient: a code-native canvas fabric (drifting hairline threads), **monochrome white-alpha with ≤2 threads carrying indigo** — an all-indigo fabric is the gradient-mesh failure by other means (WF-LAND-3). No AI-generated video chrome — the hero is honest or it isn't the hero.
- Micro-labels must be true (`append-only`, `est. 2026`) — no cargo-culted coordinates or fake version strings.

**Page structure:** hero → "the receipt is the product" (three card states teach amber/slate/green) → "who's in the room" (roster strip teaches D-1/D-2) → "the rules of the room" (§0 as the differentiator) → honest access section. Phone-first (§10), motion per §6 vocabulary (no-JS renders everything; reduced-motion clean).

**WHAT NOT TO ADD (landing):** no navy or blue-grey grounds; no purple/indigo gradient meshes (including accent-flooded canvas work); no glow, bloom, or neon; no AI-generated hero video; no stock imagery or 3D mascots; no feature-grid of 6 icon cards; no testimonial wall; no logo carousel; no fake dashboard screenshots; no metric counters; no chatbot widget; no cookie banner theatre. When a section can't be filled honestly, it is cut, not faked.

**Prototype:** `docs/design/landing-prototype.html` (self-contained, fonts embedded) is the reference implementation of this section — reviewed by wf_9c9d8e5e (26 findings fixed same day). It is intentionally a **fragment**: the artifact wrapper supplies doctype/charset/viewport/lang; a standalone deployment must add those four. The production page is a later slice; the prototype is the contract for its look, copy voice, and honesty rules.

## 14. OPEN DECISIONS

- **OPEN-1** — Spaces on free tier: recommend 1 free Space. Decide before S1.6 UI.
- **OPEN-2** — the light-shell serif signature: keep, or go all-Inter (v1 wording preserved). Decide at first shell-slice review.
- **OPEN-3** — reactions: lean no for v1 (rooms are records, not feeds). Revisit on pilot feedback.
- **OPEN-4** — own-message alignment: left (record) vs right (chat convention). Test with pilots.

## 15. SLICE MAPPING

Unchanged from v1 §13 (archived): this doc governs S1.4 (interrupt cards), S1.5–S1.6 (context/spend), S1.7 (import), S2.2 (co-sign resolved states), S2.3 (receipts), S4.2–S4.3 (MCP text surface), and the S-UI shell slice (early P1). Landed P0 slices S-UI and S-UI2 are recorded in v1's log. **New:** the landing page (§13) is its own slice, buildable before the shell slice — it shares tokens (D-3) but no app code; because it precedes the shell, it speaks in the contract register D-4 defines, never the shipped-code register.

## 16. RECORDED DIVERGENCES (owner's to settle)

- **DIV-1** (was v1 [D-1]) — the shipped DECISION card is indigo; §3/§5 rule it amber-by-verdict. And v1 §3's streaming line — _"Claude is replying — sending will interrupt at the next sentence"_ — promises interrupt semantics that don't exist; the app truthfully refuses with "claude-main is already replying in this room." Both belong to S2.2/S1.4. _Substance ruled (verdict colours the card); code change outstanding._
- **DIV-2** (was v1 [D-2]) — the member-glyph encoding budget is oversubscribed: shape=kind and colour=principal are spent; membership mode cannot also be a coloured dot, and the send button cannot be "an indigo circle" now that indigo is the brand token. _Recommended resolution stands (mode becomes a word in the popover); not yet ruled._
- **DIV-3** (was v1 [D-3]) — column width: spec ~720px, shipped 860px. Shell slice settles.
- **DIV-4** (new) — shipped `--p0` is indigo `#4338ca`, which D-1 + §3 forbid as a principal accent. Re-slot at shell slice per §3's anchoring rules (rose last, never beside `--bad`).

---

## SUMMARY OF STANDING RULINGS (quick reference)

- **Anti-goal:** nothing renders governance the log didn't produce (§0)
- **D-1:** colour = principal, never provider (§2)
- **D-2:** shape = kind; **Claude (Prince)** is the name; no "speaks for" (§2)
- **D-3:** dark mode is true black — hue-free neutrals, never navy; dark card = left verdict border + wash (§3a)
- **D-4:** the landing page depicts only real or contract-specified surfaces, in producible states, in one consistent world; nothing faked, no invented proof (§13)
- Amber/green/slate/indigo reserved; principal accents carry identity only; rose assigned last, never beside `--bad` (§3)
- Card chrome = state, chips = identity; verdict colours the card (§3, §5)
- Density gradient: dense roster, sparse transcript, dense card (§4)
- Compact mandate indicator derives from the mandate, never hand-written (§4)
- Card speaks in sentences; clause line present; "requested under X's mandate," not "attempted by X"; Approve · Deny · Downgrade; one producible render per viewer (§5)
- Motion: three named entrances, one easing, never invents state; no-JS renders everything; promoted ≠ native; Framer Motion shell-slice only (§6)
- Impeccable supplies craft; this doc wins on rulings (header)
- Terminal panel: read scoped and free; write previewed and co-signed (§8)
- Shell slice deferred; loop-first unless testers imminent (§9)
- Phone-first, real-glass verified (§10)
- Harness fails loud, asserts the rendered surface (§11)
- Humans AND agents — the voice never demotes the human to spectator or pure signer (§1, §13)
