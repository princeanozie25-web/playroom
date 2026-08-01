# SHELL-A — the primitives, extracted

The shared substrate the surfaces were hand-rolling, pulled into components so SHELL-B's motion
pass touches a handful of primitives once instead of every surface separately. **Structural, not
decorative:** appearance is unchanged by construction, and each commit proves it by rendering the
affected components to static HTML before and after and diffing.

This is not the red-team log. Every finding below breaks a consistency or craft rule, not a trust
boundary, so it lives here rather than in `docs/security/red-team-log.md` (whose own rule is that a
defect breaking no stated principle belongs in a tracker, not the ledger).

## What was extracted, and the denominator

Phase 0 settled the shape from the code, not the roadmap. The brief named five primitives "each
re-rolled across roughly seven surfaces"; the code disagreed, and two of the five failed the
substrate test. Three genuine primitives were built (owner's call, confirmed before any code):

| primitive         | call sites     | files | migrated | hand-rolled copies left |
| ----------------- | -------------- | ----- | -------- | ----------------------- |
| `Chip`            | 5              | 3     | 5        | 0 (grep-clean)          |
| `Panel`           | 6              | 4     | 6        | 0 (grep-clean)          |
| `DisabledControl` | 3 (2 surfaces) | 2     | 3        | 0 (grep-clean)          |

- **`Chip`** — the kicker-led flex row: TaskChip, InterruptChip, OrderChip, HandoffRow, SummonRow.
  `variant` selects the existing class pair (`.task-chip` / `.order-chip` differ by design), so the
  DOM emitted is byte-for-byte the hand-rolled markup. PromotionRow (a system-line block) and
  MemberChip (a pill) are **not** this family and are left alone.
- **`Panel`** — the bordered container: the decision card, the welcome strip, the mandate-detail
  popover, and the loops screen's row and two forms. Polymorphic over `section` / `div` / `li` /
  `form`; owns the element and the `data-pr` wiring, **not** the look — every panel keeps its own
  class, because their borders, fills and positioning genuinely differ. Those differences are what
  SHELL-B's motion has to animate. `.join` and `.home` are not panels (no border) and are left alone.
- **`DisabledControl`** — the control shown inert **as a statement**: the mandate co-signature switch
  and the decision card's non-signer Approve/Deny. `reason: string` is **required by construction** —
  no default, no fallback, no optional field — so a control that cannot say why it is disabled does
  not typecheck (`disabled-control.test.ts` proves it with a `@ts-expect-error` that `tsc -b` accepts
  only while the prop stays required). The reason travels as `title`, which changes no visible layout.

## Not built — and why (Phase 0, rule 7)

- **Disclosure — a rule-7 STOP.** The `<details>`/`<summary>` disclosure is used in exactly **one**
  place (`MemberChip.tsx`). A primitive extracted for one caller is indirection, not substrate, so it
  was reported and not built. (The loops "edit" reveal and the room's welcome are React-state toggles,
  a different mechanism; unifying them with `<details>` would change behaviour.)
- **Field — per-file, not cross-surface.** The three "field" flavours — the mandate surface's `dl/dt/dd`
  value pairs (5), the loops screen's wrapping `<label>`s (7), the join form's `htmlFor`+input+hint (2)
  — are each concentrated in a single file and structurally distinct (a definition list vs a wrapping
  label vs a labelled input). There is no field shared across surfaces; a shared primitive would either
  cover one file (indirection) or force unlike structures together (a restyle). Reported, not built.

## Findings logged, deliberately not fixed

| id       | severity | finding                                                                                                                                                                                                                                                                                                                    |
| -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SHA-A-F1 | low      | `hooks.ts:141` documents `loopResume` as "rendered disabled-with-reason for a non-creator", but `LoopsScreen` **hides** resume for non-creators (`{mine && status==='PAUSED'}`). The disabled-with-reason resume the brief names as a third DisabledControl site does not exist. Building it is behaviour, not extraction. |
| SHA-A-F2 | low      | `--amber` and `--rose` are used (task/interrupt chips) only as `var(--x, #hex)` **fallbacks** and are never defined in `:root`. A latent token gap; the fallbacks mask it today.                                                                                                                                           |
| SHA-A-F3 | low      | Inline hard-coded spacing bypasses the `--s` scale: `page.tsx` `style={{ gap: 8 }}` and `dev/decision-card/page.tsx` `style={{ marginTop: 24 }}`.                                                                                                                                                                          |

## Appearance proof (method)

Each surface's component was rendered to static HTML (`react-dom/server`) against the pre-extraction
tree (`git stash`) and the post-extraction tree, and the two diffed:

- **Chip** — byte-for-byte identical.
- **Panel** — Welcome, the mandate-detail popover, the loop row and the create form byte-identical; the
  decision `<section>` differs only in the **order** of two non-visual attributes (`data-pr` and
  `aria-label`), which HTML rendering and CSS matching both ignore.
- **DisabledControl** — the only change is the added `title=` carrying each control's reason; every
  existing attribute is preserved. A `title` renders nothing in a screenshot.

## Successor — SHELL-B (motion), answered from the code

design.md's motion spec lives in **§9** (not §8 — §8 is "Tiers as they touch the UI"): "150–200ms
ease-out; streaming caret shimmer; card resolve = one gentle settle; `prefers-reduced-motion` kills
all of it", under §1's "motion only when something real happens". The app already does motion in pure
CSS (`@keyframes pulse`, `@keyframes blink`). Per primitive:

| primitive       | §9 transition                  | CSS alone?                                                                 |
| --------------- | ------------------------------ | -------------------------------------------------------------------------- |
| Chip            | chip appearing                 | **CSS** — enter fade/translate via `@keyframes` on mount                   |
| Panel           | card resolve / popover opening | **CSS** for the resolve settle; enter/exit-on-unmount wants JS (see below) |
| DisabledControl | control emphasising            | **CSS** — a transition on the disabled/enabled state                       |
| (Disclosure)    | disclosure expanding           | **CSS** — `<details>` height/opacity; not a primitive here anyway          |
| (Field)         | field updating                 | **CSS** — value change transition; not a primitive here anyway             |

**Four of five need only CSS.** The one thing CSS cannot do cleanly is **enter/exit animation across
unmount** — a decision card or a chip appearing in and later leaving the transcript, where the element
is added/removed from the DOM rather than toggled. That, plus **layout animation** (a list reflowing as
a chip inserts), is the whole case for Framer Motion — and it touches **Panel and Chip only**. If
SHELL-B wants nothing more than the §9 settle and shimmer, it needs **no dependency at all**; Framer
Motion earns its place only if enter/exit-on-unmount or layout animation is in scope, and even then for
two primitives, not five. design.md's own rule — motion serves legibility, not decoration — points the
same way.
