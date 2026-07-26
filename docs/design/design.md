# PLAYROOM — FRONTEND DESIGN (design.md, v1)

**Owner:** Prince · **Status:** adopted for all UI slices from S1.4 onward · **Companion:** Master Roadmap v1.0 (§1, §2, §8), ADR-004 (membership modes)

This document is the design contract, committed at `docs/design/design.md`: implementation agents follow it the way they follow the roadmap. Changing a numbered principle requires an owner ruling; everything else is a PR.

---

## Reconciliation log (DOC-1, 26 Jul 2026)

The document was written before ADR-006's terminology ruling, before mandate v0, and before the
S-UI and S-UI2 slices. It was landed here from the owner's PDF and then reconciled — **its
direction is unchanged**. Every edit is listed below and marked inline at the point it applies.
Nothing else in the body was altered.

| id      | what changed                                                                                 | why                                                                                                                                                                                                                                                                                     |
| ------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R-1** | §5.1's clause, §4's summary and principle 2's scope now all name the artefact **mandate**    | [ADR-006](../decisions/ADR-006-terminology-and-document-precedence.md) retired the older term from every document; that ADR is where the retired spelling is recorded, so it does not reappear here. `permission` as ordinary English is untouched where it is not naming the artefact. |
| **R-2** | §4: agent glyph ring is keyed to the **principal**, not the adapter                          | Roadmap §6 / Bible §10: the room, the fabric and the data model never contain a provider name. Adapter-keyed colour makes the surface provider-aware.                                                                                                                                   |
| **R-3** | Principle 2 amended — **owner ruling, 26 Jul 2026**                                          | S-UI2 removed the per-message provenance line and scope chip. Provenance is now encoded on the message, spelled on the roster, and spelled in full on every decision card.                                                                                                              |
| **R-4** | §9 palette rewritten to describe the shipped tokens, plus four principal accents and `--bad` | S-UI2 shipped four principal accents; `--bad` red exists for refusal states. Principle 3's reservation of amber and green is untouched.                                                                                                                                                 |
| **R-5** | §9 launch-film line: the film shoots **light**                                               | Take 10 is light, no dark tokens exist, and the asset is shipped. Dark mode moves to P1.                                                                                                                                                                                                |
| **R-6** | §13 gained S-UI and S-UI2                                                                    | Two P0 slices existed by the time this landed, both driven by the film rather than by this document.                                                                                                                                                                                    |
| **R-7** | §5.1 title example no longer says an agent _requests_                                        | Agents cannot initiate a structured action — no adapter carries tool calls. S06-N3, closed in UI2-4.                                                                                                                                                                                    |

**Divergences recorded, not resolved.** Three things in this document disagree with shipped
code and the disagreement is the owner's to settle, not an implementation agent's. They are
marked **[D-1]**, **[D-2]**, **[D-3]** inline and listed in §14. No app code was touched by DOC-1.

---

## 1. Design position

Studied for reference: Claude (generous whitespace, warm single column, serif accents, almost no chrome), ChatGPT (neutral, composer-centric, utilitarian), Gemini (material color, gradients, denser), Higgsfield (dark, cinematic, media-first).

Playroom's position: the calm of Claude, the utility of Slack, and one signature of our own. Familiar enough that nobody needs a tutorial; distinct enough that a screenshot is recognisably ours.

The signature is not a color or a font. It is provenance made visible: every agent message carries who it speaks for and what it may do, and every commitment is a card, not a sentence. That is the thing no other chat surface shows, because no other chat surface knows it.

**Principles (in priority order):**

1. **The thread is sacred.** One centered column, max-width ~720px, nothing competes with it. All chrome lives in sidebars, and every sidebar collapses. **[D-3]**

2. **Provenance one glance away.** _Amended by owner ruling, 26 Jul 2026 (**R-3**)._ Provenance is **encoded on the message** — the principal's colour and the member's shape, carried by the byline — **spelled on the roster**, where affiliation and a compact mandate summary sit once at the top with full detail on demand, and **spelled in full on every decision card**.

   > _The original read: "Agent identity, principal, and permission scope are visible on the message, not buried in a profile." S-UI2 removed the per-message provenance line and scope chip after they were built. The reason is density, not retreat: restating a member's affiliation and full mandate above every single turn is something nobody does about a colleague, and it made the message text no longer the largest thing on screen. The guarantee survives — nothing about a member's authority is buried in a profile, and the one moment authority is the subject (a decision) still spells it out completely. What changed is that the message carries provenance without spending a sentence on it._

3. **Trust states have exactly three colors.** Indigo = identity/action, amber = needs a human, green = signed and done. Nothing else may use amber or green. _(Unchanged. See §9 for how the principal accents added in S-UI2 sit under this constraint.)_

4. **Spend is ambient, never nagging.** The room's meter is quietly present; it never interrupts.

5. **Calm by default.** Agents are silent until summoned; the UI matches — no badges begging, no pulse animations, motion only when something real happens.

6. **Familiar before clever.** If Claude/ChatGPT users would hesitate, redesign it.

## 2. App shell

```
┌────────┬──────────────────────────────┬───────────┐
│ LEFT   │ THREAD (center, ~720px)      │ RIGHT(ctx)│
│ sidebar│                              │ sidebar   │
│        │   messages / cards           │           │
│ spaces │                              │ Roster    │
│ rooms  │                              │ Tasks     │
│ pending│                              │ Receipts  │
│ ...    │        composer              │ Spend     │
└────────┴──────────────────────────────┴───────────┘
```

**Left sidebar (nav):** workspace switcher, Spaces (see §8), rooms list with unread markers, Pending (DECISION items awaiting you, with count — the only badge in the app), settings. Collapses to icon rail at <1200px; sheet on mobile.

**Right sidebar (context, per-room):** four stacked panels — Roster (member chips with mode badges **[D-2]**), Tasks (state chips), Receipts (chronological cards), Spend (today's meter + per-member breakdown). Collapsed by default on first visit; remembers state per room.

**Thread:** the only scrollable region that matters. Date dividers, quiet system lines ("Sol joined · connected"), infinite upward scroll via seq.

**Top bar:** room name, member facepile (chips on hover), `/freeze` under a shield icon, search. Nothing else.

## 3. The composer (the chat box)

The single most-touched element; it must feel as good as Claude's.

- One rounded container (radius 16), 1px slate border, subtle focus glow in indigo. Placeholder: `Message the room — @ to bring someone in`.

- **@-mention popover:** member chips showing avatar/glyph, name, and mode badge (`hosted` indigo dot · `connected` outlined dot · `bridged` grey dot) **[D-2]**. Agents and humans in one list — the symmetry is the product. Hosted agents show a one-line scope hint (`review-only`) in the popover.

- **Multi-line** grows to 8 lines then scrolls. Enter sends, Shift+Enter newline. Attach (files/artifacts) right-aligned inside the field; send is an indigo circle that only appears when there's content. **[D-2]**

- **Slash commands, v1 exactly three:** `/freeze` (confirm dialog, amber), `/export` (room → markdown), `/help`.

- **While an agent streams in-room:** composer stays enabled; a quiet line above it — "Claude is replying — sending will interrupt at the next sentence" (§8 interrupt semantics, stated honestly). **[D-1]**

## 4. Message anatomy

**Human:** avatar, name, time on hover, body. Nothing else. Left-aligned including your own (a room is a shared record, not a DM; OPEN-4 if this tests badly).

**Agent:** glyph avatar (**principal-colored ring — R-2**), then the byline, with the member's mandate reachable from the roster rather than restated per message (**R-3**). Streaming: text fills progressively with a 2px caret shimmer in the speaking member's accent; on `completed`, a quiet footer fades in: `1.2k tokens · £0.002 · 2.1s`. Errors render in-thread as a slate card with `error_class` and a retry affordance — never a toast, never silence.

> **R-2 — identity colour is keyed to the principal, not the adapter.** The original line specified an adapter-coloured ring. Roadmap §6 and Bible §10 hold that the room, the fabric and the data model never contain a provider name; an adapter-keyed colour makes the surface provider-aware, and a viewer who learns to read the colour has learned which vendor is behind a member. It is the same class of failure S0.6 caught when a provider name reached the frame while the provider grep over the repo was clean — the rule is a property of the code, the claim is about what a viewer sees. Colour answers _whose authority is this_, which is the question the product is about; it never answers _whose model is this_, which is the question §6 exists to make unaskable from the surface. Shipped in S-UI2.

**System lines:** centered, small, slate-500. Joins, promotions ("Prince shared 3 items into the room"), freezes.

## 5. The three cards

Cards are full-width interruptions of the thread. There are exactly three kinds.

1. **DECISION (amber). [D-1]** Left border 3px amber, warm wash fill. Title = the exact action (`merge of PR #41, requested under Sol's mandate` — **R-7**), one line of the **mandate clause** (**R-1**) that triggered it, then `Approve` (amber solid) · `Deny` · `Downgrade`. Shows who it's waiting on. Resolved state collapses to one line with the outcome and who signed.

   > **R-7 — the title says what was requested, not who attempted it.** The original example read `Sol requests merge of PR #41`. No adapter carries a tool-call channel — `AgentTurnChunk` is `text_delta | done | error` — so an agent cannot initiate a structured action, and a request is always issued _on_ a member's behalf by a caller. A title in the agent's voice asserts intent the event does not carry. This was finding S06-N3, raised when the film's claims sheet had to spend a paragraph counteracting the words "Attempted by Claude", and closed in UI2-4.

2. **RECEIPT (green).** Green wash fill, check glyph, human-readable terms, signer chips, timestamp, and a verify link (S3.5). This is the artifact of the whole company; it should look like something you'd keep.

3. **NOTICE (slate).** Failures, freezes, budget-degrade ("Room is in digest mode — daily budget reached"). Informational, never blocking.

No other card types in v1. Resist inventing a fourth.

## 6. Entry flows (starting must be trivial)

1. **Blank start** — first-class, not the fallback. New room → name + who's in it (chips, including your hosted agent by default) → in. Three interactions, under ten seconds. Empty-state line inside: `Quiet in here. @ someone — human or agent.`

2. **Export a chat into a room.** Paste or upload a Claude/ChatGPT export → preview screen shows the history provenance-tagged as imported (visually quieter, "imported" chip on the divider) → name it → invite. The room opens born with context. This is the hero onboarding for the launch, but flow 1 must never feel second-class.

3. **Invite link.** Lands on the room with a join card; joining as a human is one tap after auth.

4. **Connected member (ADR-004).** From Claude/ChatGPT: add Playroom as a connector → OAuth. Consent screen copy, exact: "Playroom will let this assistant read rooms you're a member of and act in them — under permissions you set. It cannot read your other chats. You can revoke this any time." Inside the room, connected members carry the outlined-dot badge; tagging one shows an inline hint: `Sol is connected — they'll see this next time they're active, and we've pinged Jerry.`

5. **Bridged.** GitHub-bridged participants render with the grey dot and a small octicon; their messages note the origin (`via GitHub`).

## 7. Surfaces

- **Web is canonical.** Everything above is the web app.

- **App = PWA wrapper in v1** (roadmap §3: mobile wraps web). Installable, push notifications for BLOCKER/DECISION only. Native apps are not a v1 promise.

- **MCP surface (P4).** No pixels of ours — the design deliverable is the text our tools return. Rules: tool outputs are tight markdown; `list_pending_tags` returns a numbered list with room, asker, and the ask in one line each; `read_room` returns the last N messages with provenance inline (`[Claude · for Prince · review-only]`); every mutating tool's confirmation line ends with the room's canonical URL so the human can jump to the full surface. The MCP surface should read like a well-behaved terminal, not a webpage forced through a straw.

## 8. Tiers as they touch the UI

Final pricing lives in the commercial doc; this section fixes only the principles the UI must encode, because they shape components:

- **Trust is never paywalled.** Receipts, co-sign, audit view, `/freeze`, provenance chips — identical on every tier including free. A trust product that gates safety behind payment has misunderstood itself.

- **Connected members are unlimited on free.** Their inference costs us nothing (ADR-004); generosity here is pure distribution.

- **What paid buys is capacity and reach:** hosted-agent usage, room/space counts, the GitHub bridge, admin. Draft surface (numbers indicative, not final): Free — 3 rooms, 1 Space, modest hosted allowance, unlimited connected members. Team £99/mo — unlimited rooms/Spaces, GitHub bridge, pooled hosted allowance + BYO-key option, admin + receipts export.

- **Gating behavior:** entitlement limits appear as quiet inline NOTICE cards at the moment of need (`This room's hosted minutes are done for today — upgrade or continue with connected members`) — never a modal mid-task, never a lock icon shaming the sidebar.

- **Spaces** (project-like grouping: shared context, member defaults, room templates — the ChatGPT/Claude "Projects" analog): OPEN-1 below.

## 9. Tokens

_Rewritten by **R-4** and **R-5** to describe what is actually in `apps/web/app/globals.css`. Principle 3 is unchanged and still governs._

**Color — as shipped.**

| role              | token                                          | value                             |
| ----------------- | ---------------------------------------------- | --------------------------------- |
| ink               | `--ink` / `--ink-2` / `--ink-3`                | `#0f172a` / `#475569` / `#94a3b8` |
| surfaces          | `--paper` / `--paper-2` / `--line`             | `#ffffff` / `#f8fafc` / `#e2e8f0` |
| identity / action | `--indigo` / `--indigo-soft` / `--indigo-line` | `#4338ca` / `#eef2ff` / `#c7d2fe` |
| needs a human     | `--warn` / `--warn-soft`                       | `#b45309` / `#fef3c7`             |
| signed and done   | `--ok` / `--ok-soft`                           | `#15803d` / `#dcfce7`             |
| refused           | `--bad` / `--bad-soft`                         | `#b91c1c` / `#fee2e2`             |

The original section specified `indigo #4F46E5`, `amber #F59E0B`, `green #047857` and their washes. The shipped values differ; the table above is authoritative for what exists, and the hues are unchanged in role.

**Red is in the system, narrowly.** The original line — "Red is not in the system — even errors don't get to shout" — no longer describes the app. `--bad` exists and carries exactly one meaning: **a refusal the member must not mistake for success.** It is the connection state when a room refuses a socket, and the failed-turn marker. That is RT-001's remedy made visible, and it is the one case where not shouting was the bug: a refused write that looked like an accepted one is the single failure this product cannot have. Red is never decorative, never a severity gradient, and never applied to anything a member did wrong.

**Principal accents (S-UI2).** Four accents, assigned by a principal's index in `adapters.yaml`:

| slot   | value     | hue |
| ------ | --------- | --- |
| `--p0` | `#4338ca` | 245 |
| `--p1` | `#0e7490` | 192 |
| `--p2` | `#a21caf` | 295 |
| `--p3` | `#be185d` | 336 |

- **A principal accent may never carry state meaning.** Principle 3 reserves amber for _needs a human_ and green for _signed and done_, and no accent may be read as either. The hues are chosen around the state colours — `--ok` sits near 142, `--warn` near 28, `--bad` near 0 — so no accent lands on a state hue. `--p3` rose is nearest `--bad` and is therefore assigned last, after the other three; even then the two never co-occur in one element, because accents appear on markers, bylines and roster borders while the state colours appear only in the connection badge and refusal surfaces.
- **The palette holds four principals and wraps at five**, at which point two principals would look alike. That is the honest limit of a palette this size and it is recorded as **UI2-N1**, resolved when S1.1 makes principals real records rather than config entries.
- Colour is never the only channel. Human versus agent is carried by **shape and fill** — a hollow circle for a human, a filled rounded square for an agent — so the distinction survives with colour removed entirely (verified against a grayscale frame in S-UI2).

**Dark mode:** not tokenized. **The launch film shoots light** (**R-5**) — take 10, the shipped P0 asset, is light, and no dark tokens exist. Dark mode is a **P1 item**, not a P0 promise; when it lands, both are first-class.

**Type:** Inter for everything; tabular numerals for costs and seqs. One warmth signature, small: room titles and receipt headings in a soft serif (Source Serif 4). That single serif is our echo of Claude's warmth without cosplay. (OPEN-2 to veto.) _Not yet adopted — the app ships a system font stack; adopting either face is a font dependency and belongs to the S-UI shell slice._

**Shape:** radius 16 composer/cards, 12 chips, 8 inputs — the rounded-card motif from the decks, everywhere. _The app ships `--radius: 8px` and a pill radius for chips; the shell slice reconciles this._

**Motion:** 150–200ms ease-out; streaming caret shimmer; card resolve = one gentle settle. `prefers-reduced-motion` kills all of it.

**A11y:** 4.5:1 minimum, visible focus rings (indigo), streaming text in `aria-live="polite"`, cards keyboard-operable, chips reachable.

## 10. States

Every view ships empty/loading/error designed, not defaulted: skeleton bubbles for thread load; the empty-room line (§6.1); offline banner reuses the NOTICE card; reconnect shows `catching up…` then the replayed span slides in — the resume path is a visible moment of quality; let it feel instant and complete.

## 11. Explicit non-goals (v1 UI)

No message editing or deletion (append-only truth; a correction is a new message). No reactions (OPEN-3). No threads-within-threads. No themes beyond light/dark. No DMs — a DM is a two-member room. No read receipts. No typing indicators for humans (agents show working state via task chips instead).

## 12. Open decisions

- **OPEN-1** — Spaces on free tier: recommend 1 free Space (enough to feel the feature, upgrade for more). Decide before S1.6 UI.
- **OPEN-2** — the serif signature: keep or go all-Inter. Decide at first S1.4 UI review.
- **OPEN-3** — reactions: lean no for v1 (rooms are records, not feeds). Revisit on pilot feedback.
- **OPEN-4** — own-message alignment: left (record) vs right (chat convention). Test with pilots.

## 13. Slice mapping

What exists today (S0.2/S0.3 minimal client) intentionally ignores this doc. This doc governs: **S1.4** (interrupt cards = §5.1), **S1.5–S1.6** (context/spend surfaces = §2 right sidebar, §8 gating cards), **S1.7** (import flow = §6.2), **S2.2** (co-sign = §5.1 resolved states), **S2.3** (receipts = §5.2), and a dedicated **S-UI shell slice** (app shell + composer + tokens, §2–§4, §9) that should land early in P1's UI work. The MCP text surface (§7) governs **S4.2–S4.3**.

**Landed since this was written (R-6).** Two P0 slices built UI before this document was due, both driven by the ninety-second film rather than by this contract:

- **S-UI** (P0) — the three objects the film needed: the room shell, the member chip, the DECISION card. Built against the film's requirements; the brief that produced it asked the chip to render `display_name + principal + mandate_label`, which was right for proving the data was real and wrong as a product surface.
- **S-UI2** (P0) — identity and density. Principal accents, shape-encoded member kind, the roster as the dense surface, the transcript as the quiet one, and the decision card rewritten as sentences. Source of **R-2**, **R-3**, **R-4**, **R-7**.

The **S-UI shell slice stays where it is** — early in P1's UI work. S-UI2 did not consume it: the app shell, the sidebars, the composer and the token reconciliation are all still ahead.

## 14. Recorded divergences (DOC-1)

Three places where this document and the shipped app disagree, and the disagreement is the
owner's to settle. **None was resolved by DOC-1, which touched no app code.**

**[D-1] — the DECISION card is amber here and indigo in the app.** §5.1 specifies a 3px amber
left border and a warm wash; the shipped card is indigo. This is not merely unbuilt — under
principle 3, amber means _needs a human_, and a `CO_SIGN` decision is exactly that, so **the
shipped card contradicts principle 3 today**, on screen, in the P0 film. §3's streaming line has
the same shape of problem in copy rather than colour: it promises "sending will interrupt at the
next sentence", while the app refuses a second summon of a busy member with "claude-main is
already replying in this room." Interrupt semantics do not exist, so shipping that line now would
be a false promise. Both belong to the slice that builds co-sign and interrupts (S2.2 / S1.4);
recorded here so neither is re-derived as an oversight.

**[D-2] — the encoding budget for a member glyph is oversubscribed.** §2 and §3 key a dot to
**membership mode** (hosted indigo · connected outlined · bridged grey). S-UI2 already spends
that glyph on two other facts: **shape** carries human-versus-agent, **colour** carries the
principal. Indigo specifically is now `--p0`, the first principal's accent, so a "hosted indigo
dot" would read as _belongs to Prince_. Three facts cannot share one mark. The same tension
reaches §3's send button, specified as "an indigo circle" — indigo is now an identity colour, and
a send affordance wearing it says something about authority that it does not mean. A ruling is
needed on which fact owns the glyph; the cheapest resolution is that mode becomes a **word** in
the popover rather than a colour, leaving shape and accent as they are.

**[D-3] — column width.** Principle 1 says ~720px; the app ships 860px. Cosmetic, listed for
completeness, and the shell slice's to settle.
