# SHELL-B — the craft pass and the motion layer

The first slice in which appearance changed on purpose. Four commits: the static craft pass
(SHELL-B1), the CSS motion layer (SHELL-B2), Framer Motion scoped to the primitives (SHELL-B3), and
this close (SHELL-B4). Companion record to [shell-a-primitives.md](shell-a-primitives.md); findings
here follow its convention. Engineering findings, not trust findings — the ledger rule keeps them
out of `docs/security/red-team-log.md` (whose S13c-N1 entry did gain a dated addendum from this
slice: a third timing-sensitive test failed once under shared-compute load).

## The evidence

- **Impeccable** skill v3.1.0 (`pbakaus/impeccable`, Apache-2.0; `universal.zip` sha256
  `960a7ce72a4b5464b0c047a9769f771c6559fd0590c0ca488689085349f93358`), CLI detector v3.5.0 (npm
  provenance verified to the same repo). Critique snapshot persisted at
  `.impeccable/critique/2026-08-01T08-01-30Z__apps-web-app.md`: **23/40 (Acceptable), P0=0, P1=4,
  P2=1**; CLI detector 4 findings / 1 rule (`side-tab`) / 21 scannable files / 58-rule registry, all
  four design-ruled with citations in `ignore.md`; browser-injected detector against the rendered
  room: 6 findings / 5 elements / 3 rules. Register: product. Inverse test: the surface reads
  generic only when no mandate-bearing chip or decision card is in frame.
- **Motion**: `motion.test.ts` (6 animations + 4 transitions counted exactly; reduced-motion kill
  dominant by cascade arithmetic) and `framer-scope.test.ts` (framer in Chip.tsx + Panel.tsx out of
  the whole-app walk; opacity/y/layout the closed animatable set; the resolved style only behind the
  event-derived `resolution`; reduced branches empty).
- **The after-capture**: `playroom-capture/videos/mandate-take2-LOCAL/` (390×844, 6 frames + webm,
  run report inside). `LOCAL` in the filename is the label, per the owner's ruling — see SHA-B-F1.
  Frame sweep: 6 of 6 frames, zero credential material (the sha256 on screen is a public identifier
  by design). take 13 and `mandate-take1` byte-identical to their pre-slice hashes, verified.
  The capture also proves SHELL-B3's exit-across-unmount headed: the welcome dismissed on camera and
  the node left the DOM (`welcomeExitCompleted: true` in the run report).

## Findings

| id       | severity | finding                                                                                                                                                                                                                                                                                                                                                                                               | trigger                                                                                     |
| -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| SHA-B-F1 | —        | **The after-capture on the live tier is outstanding.** The live web tier ran pre-SHELL-A code on 1 Aug 2026; the owner ruled no deploy that day (the fly permission gate stays — it is the same class of control this product sells). The LOCAL artifact is a craft record only and upgrades no claim.                                                                                                | **the next time Prince deploys from the laptop** — run `demo-capture.ts mandate 2` then     |
| SHA-B-F2 | low      | **Impeccable skill/CLI version skew.** Skill 3.1.0's critique flow instructs `npx impeccable live`; CLI 3.5.0 has removed the command ("Unknown command"). Worked around by serving and injecting the CLI's own browser bundle directly; the skill's documented path cannot run as written.                                                                                                           | the next Impeccable release taken, or the next `/impeccable critique` run                   |
| SHA-B-F3 | low      | **`MandateSurface` renders the mandate's raw `co_sign.by` value.** Today that value is the literal string `principal` (on film: "by principal"), which is odd copy but no identifier leak; a mandate whose `by` held `principal:prince` would put an internal identifier on screen — the category error the decision card documents avoiding. Needs display-name resolution: product work, not craft. | the first mandate whose `co_sign.by` is not the literal `principal`, or S2.1's signing work |

Behavioural findings from the critique (the @-affordance gap and silent untagged sends, the
scroll-yank while reading, the dead-end refused socket, the unconfirmed one-way taps, the missing
empty-state line) live in the critique snapshot with P-severities — logged there once, not
duplicated here. SHA-A-F1 remains parked by the owner, untouched.

## Exit criteria — one honestly unmet

Everything green except: **"After-capture at 390px against the live tier, liveness assertion fired"
— UNMET**, by owner's ruling (no deploy on 1 Aug; the permission gate stays). What exists instead is
the labeled LOCAL capture above, whose hash check ran against the local api and is named a
consistency check, not liveness. SHA-B-F1 carries the trigger so the deferral cannot expire quietly.
