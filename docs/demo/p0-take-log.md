# P0 film — take log

Provenance for the S0.6 recording. **No video is committed.** The takes live outside the
repo tree, at `../playroom-capture/videos-p0/`, and this file is the record of what was
shot, off what build, and what each beat asserted before the take was allowed to pass.

## The build filmed

- Web: **production** build (`next build` → `.next-prod`, `next start`). The harness aborts
  if the page carries `nextjs-portal` or `react-refresh` — A4-F6, the dev badge would sit in
  every frame. Checked against a real room page, not just `/`.
- API: `playroom-api` v0.0.1 at `869260f`, warmed at boot.
- Chromium 151.0.7922.34, viewport 1280×800, 25fps, Playwright `recordVideo`.
- Two live providers, real turns, real spend. Nothing stubbed, nothing replayed.

## Takes

| take | duration | size  | sha256 (first 16)  | note                                             |
| ---- | -------- | ----- | ------------------ | ------------------------------------------------ |
| 1    | 66.76s   | 4404K | `d820cf5de2529993` | superseded — provider name and markdown in frame |
| 2    | 67.24s   | 4887K | `d9fdcb967696923b` | superseded — same script as take 1               |
| 3    | 67.60s   | 4598K | `b0aa59c273b5d736` | superseded — same script as take 1               |
| 4    | 43.52s   | 2944K | `5fd4ff16bb5b1cb5` | corrected script; scratch room id still in shot  |
| 5    | 51.44s   | 3514K | `a7ca9031bedee483` | readable room id, longer holds                   |
| 6    | 56.48s   | 4062K | `f2171a0344a14274` | **RECOMMENDED**                                  |
| 7    | 51.84s   | 3486K | `ff6501ff078a81a2` | alternate, same script as 6                      |

Nothing is deleted. Takes 1–3 are kept because the two faults they exposed are the reason
the script changed, and a take log that only lists the good takes is a worse record.

All seven frame-verified with `verify-p0.sh`: three frames pulled from 20%, 50% and 85% of
each clip and hashed — **3/3 distinct** for every take. One distinct hash would mean a still
image, which is the failure A4 was built to catch.

## Recommended take: 10

51.88s, all five beats, one continuous take, shot on the S-UI2 surface and **re-shot twice
since** — after S1.2, when the harness had to authenticate, and after S1.3, when the decision
card's sentence and the human's display name both changed. The clip on disk is the S1.3 one; see
the dated sections below, which keep every measurement rather than overwriting the last. Takes 1–7 were shot before S-UI2 and are kept:
they are the record of what the room looked like when the P0 film was first cut, and take 8 is
kept because it is the take that failed on the decision card before UI2-4 reworded it.

What take 6 recorded — the pre-S-UI2 surface, retained for comparison:

| beat | recorded                                                                                                                                                                                  |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | roster: `Claude · speaks for principal:prince · pr.review, pr.comment, pr.merge (co-sign)` and `Sol · speaks for principal:jerry · pr.review, pr.comment` — socket connected in **454ms** |
| 2    | untagged message, **7.0s** of held silence, nothing summoned                                                                                                                              |
| 3    | `@claude` streamed, caret observed, `262→187 tok · $0.0012`                                                                                                                               |
| 4    | `@sol` streamed, caret observed, `292→152 tok · $0.00013`                                                                                                                                 |
| 5    | `DECISION · CO_SIGN`, `pr.merge`, `PROTECTED_ACTION`, co-signature from `principal:prince`, `sha256:1af314ca8427474e…`, Approve/Deny disabled and labelled `S2.2`                         |

Warm-up before take 6: **629ms** — database 98ms, claude-main 628ms, sol 598ms, concurrent.
Beat one opened in 454ms with no stall, which is the S0.5c primitive doing the job it was
built for outside its own measurement.

**What take 10 recorded**, on the same five beats and the same assertions:

| beat | recorded                                                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | roster: `Claude · for Prince · review + comment, merge (co-sign)` and `Sol · for Jerry · review + comment only`, each in its principal's accent                                                                    |
| 2    | untagged message, 7.0s of held silence, nothing summoned                                                                                                                                                           |
| 3    | `@claude` streamed, caret observed, spend visible                                                                                                                                                                  |
| 4    | `@sol` streamed, caret observed, spend visible                                                                                                                                                                     |
| 5    | `Decision · CO_SIGN` · `pr.merge` · "Requested under Claude's mandate." · `PROTECTED_ACTION` · "Needs a signature from Prince." · `sha256:1af314ca8427474e…` · Approve/Deny disabled, "co-signing arrives in S2.2" |

The beats, the assertions and the claims are identical. Only the surface moved — and the
harness proved it by re-running take 6's script against the new room with **no selector
edited**, which is what the app-owned hooks were added for (S06-N1).

### Take 10, re-shot after S1.2 — 26 Jul 2026

Identity is stamped at the handshake now, so the film's own harness had to authenticate. The
take was re-shot rather than re-used, because a film of a room whose door has changed should
be a film of the room as it is.

| what changed                                                                                                                                                                                                                            | what did not                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| the harness presents a **member credential** on beat 5's socket, issued with `issue-credential.ts prince "capture harness"` — its own credential, separate from the browser's, so revoking the camera does not lock out the dev browser | the script, the prompts, the pacing, and **every selector** |
| the browser reads the room as an authenticated member (`PLAYROOM_WEB_TOKEN` in `apps/web/.env.local`) — without it the socket is refused 4401 and the roster returns 401                                                                | the five beats and all of their assertions                  |
| the composer no longer has a `you` field to fill — the harness's two lines that filled it are gone, along with the field                                                                                                                | nothing in the product was adjusted for the camera          |

Re-shot clip: **52.80s**, 3279K, `sha256:71efbc68e9dda027…`, frame-verified **3/3 distinct**
by `verify-p0.sh` like every take before it. App code filmed: `4498ad2` (S12-3), web
production build, api warmed at boot.

Re-shot run: warm-up **584ms** (database 120ms, claude-main 221ms, sol 583ms), beat 1 opened
with no stall, `262→178 tok · $0.00115` for Claude and `292→136 tok · $0.00013` for Sol, and
beat 5 rendered `CO_SIGN · pr.merge` from a real `decision` row. **Every beat asserted green
on the first run** — no selector edits, which is the second time the `data-pr` hook contract
has survived a change it was not designed for.

**A test-only path around authentication would have made this take worthless.** The harness
walks through the same door as a browser: `?token=` on the socket, because the browser
WebSocket API cannot set a header, and the credential is a real row in `member_credentials`.
A film shot through a door the product does not have proves nothing about the product.

### S1.3 — take 10 re-shot, and take 11 adds the handoff — 27 Jul 2026

Two takes, because the sixth beat costs more than the owner's runtime condition allowed.

| take   | beats | clip   | size  | sha256 (first 16)  | frames | note                                        |
| ------ | ----- | ------ | ----- | ------------------ | ------ | ------------------------------------------- |
| **10** | 5     | 51.88s | 3265K | `f935fe34664d602f` | 3/3    | **THE P0 ASSET.** Re-shot on S1.3           |
| 11     | 6     | 61.60s | 4085K | `7d2d52c8a44a2ada` | 3/3    | the handoff variant, kept and not the asset |

**Take 10 HAD to be re-shot, not merely kept.** S1.3 changed two things a viewer can read: the
decision card now says _"Requested by Prince under Claude's mandate."_ (both parties, because both
are grounded in records), and the room renders human display names — the previous take showed the
raw member id `prince`, lowercase, in every byline. An asset that no longer matches the product is
worse than no asset, and the claims sheet quotes that card sentence.

**The sixth beat costs 8.8 seconds of clip: 52.8s → 61.6s.** The owner's condition was "if it makes
the take longer than about a minute, do not force it", and 61.6s is over that line. The obvious way
to fit would be to shorten beat 5's hold, and that is the one hold that must not move: nine seconds
is what it takes to read who requested what, under whose mandate, why it was stopped and who has to
sign. Robbing the film's best beat to make room for a new one is padding dressed as thrift.

So the handoff is behind an argument — `node film.mjs 10 --five` shoots the asset, no flag shoots
the six-beat variant — and both clips are on disk. Nothing is deleted; that rule has held since
takes 1–3 were kept for the faults they exposed.

**What beat 6 records, when it is used:**

| beat | recorded                                                                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6    | `HANDOFF Prince → Sol pr.review under sha256:7d0d033c69effb…` and the task chip becomes `TASK assigned Sol pr.review` — the work moves, the mandate travels |

The mandate hash on the handoff row is **Sol's** (`7d0d033c…`), and the one on the decision card is
**Claude's** (`1af314ca…`). Two different documents, visibly, in the same frame: a handoff confers
no authority, so the reference that travels is the one the RECEIVING member acts under.

**Beat 6 is after beat 5 for a reason that is not staging.** The standing that lets Prince request
under Claude's mandate is the task Claude HOLDS; moving that task to Sol moves the standing with it,
so a handoff before beat 5 would make beat 5's request unjustified — correctly refused, and the film
would have shown nothing. That is S13-N1's second face, and it is recorded in the ledger.

**There is no UI for a handoff**, exactly as there is none for `request_action`. The harness sends
the frame a host sidecar sends, on a socket with a real credential, and reads the task id from the
room's own replay the way a sidecar would — not from the database, because a camera that queries
Postgres to drive a beat is asserting knowledge no client has. **A caption may not say that typing
"@sol take review" did this.**

Re-shot run (take 10): warm-up **636ms** (database 97ms, claude-main 310ms, sol 636ms), beat 1 opened
in 463ms with no stall, `262→188 tok · $0.0012` for Claude and `292→151 tok · $0.00013` for Sol.
App code filmed: `S13-4`, web production build, api warmed at boot. No selector edited for either
take: the two new hooks (`task`, `handoff`) were added with the components that render them.

## What the harness asserts before a take passes

Every beat asserts; a take that captures a plausible-looking video of nothing happening
fails instead of shipping. Beyond the per-beat checks above:

- **Sol's mandate is narrower than Claude's** — asserted directly: Claude's chip must show
  `pr.merge (co-sign)`, Sol's must NOT contain `pr.merge` at all.
- **The untagged message summons nothing** — item count unchanged, no caret, no telemetry
  footer, after a full 7s hold.
- **Both turns really streamed** — the caret only renders while `streaming` is true, so
  observing it is the proof tokens arrived incrementally.
- **Spend is visible** — the footer must match `N→M tok` and contain `$`.
- **The Approve button is disabled** — otherwise the film would imply a co-sign flow.
- **No refusal notice, no failed turn, no in-flight notice, no refusal banner** on screen.
- **No provider name on screen** (Roadmap §6) and **no markdown artefact** — both matched
  against the rendered transcript, after takes 1–3 put `Anthropic's servers` and `*to*` in
  frame. Asserted rather than counted: a number in a report is not read before a cut.

## Housekeeping

- The room id `playroom-p0` is reused across takes and **purged before and after each one**,
  so no take inherits a previous take's messages (A4's rule) and nothing is left in the
  database. The drift query reads zero on both numbers afterwards.
- Harness: `../playroom-capture/film.mjs`, outside the tree, no new dependency.

### S1.3b — re-shot through the enforced front door — 27 Jul 2026

| take   | beats | clip   | size  | sha256 (first 16)  | frames | note                          |
| ------ | ----- | ------ | ----- | ------------------ | ------ | ----------------------------- |
| **10** | 5     | 54.80s | 3365K | `9c08905e06a4c9e7` | 3/3    | **THE P0 ASSET**, S1.3b build |

**The frame is stronger than it was, and nothing on screen changed to make it so.** The socket the
film opens is now refused for a member who is not enrolled in the room, and the two HTTP reads it
depends on require a credential — so the beats a viewer sees arrive through a door that checks
membership rather than one that checks only that the room exists. THE HARNESS NEEDED NOTHING: every
room enrols every current member at creation, so `prince` was already a member of `playroom-p0`.

**Numbers moved slightly, and the reason is the prompt.** `269→199 tok · $0.00126` for Claude and
`299→146 tok · $0.00013` for Sol, against S1.3's `262→188` and `292→151`. The system prompt changed
in S13b-1 — it said "you are summoned by name (for example, `@claude`)", which told Sol another
member's tag as its own example — so the input token count moved and the models answered at slightly
different lengths. Prompt hash changes with it; nothing pins the value.

Warm-up 697ms (database 102ms, claude-main 321ms, sol 695ms). Beat 1 opened with no stall. No
selector edited. Frame-verified 3/3 distinct.

### S1.3c — re-shot through the ticket path — 27 Jul 2026

| take   | beats | clip   | size  | sha256 (first 16)  | frames | note                          |
| ------ | ----- | ------ | ----- | ------------------ | ------ | ----------------------------- |
| **10** | 5     | 56.64s | 3941K | `157c44ac108fae27` | 3/3    | **THE P0 ASSET**, S1.3c build |

**What the harness needed: a ticket, and a credential on the create call.** The socket no longer
accepts a long-lived credential at all, so `?token=` had to become `?ticket=` — minted from
`POST /ws-ticket` with the harness's Bearer credential, one per socket, because a ticket is spent
on use and beats 5 and 6 open different sockets. And `POST /rooms` requires a credential now
(RT-002), which is also what keeps `prince` enrolled in the film's room and therefore able to walk
through the front door S1.3b built.

**The film gained an assertion rather than a beat.** After the last hold, the harness reads the
page's actual HTML and asserts that neither the harness credential nor the browser's own
`PLAYROOM_WEB_TOKEN` appears in it, and that nothing credential-shaped (`prm_…`) does either. That
is the runtime half of S13-N3's second face — no source-level check can see a rendered payload — and
it is asserted against the page a viewer is looking at.

Warm-up 762ms (database 104ms, claude-main 228ms, sol 760ms). Beat 1 opened with no stall.
`269→191 tok · $0.00122` for Claude, `299→265 tok · $0.0002` for Sol — the same prompt as S1.3b, so
the difference is the models answering at different lengths, which is what two takes of one script
look like. No selector edited; the handshake changed underneath and the hooks did not move.

### S1.4 — the 2× recapture — 27 Jul 2026

| take   | scale | resolution | clip   | size  | fps  | sha256 (first 16)  | frames | note                     |
| ------ | ----- | ---------- | ------ | ----- | ---- | ------------------ | ------ | ------------------------ |
| 10     | 1×    | 1280×800   | 56.64s | 3941K | 25.0 | `157c44ac108fae27` | 3/3    | previous asset, retained |
| **12** | 2×    | 2560×1600  | 55.64s | 6069K | 25.0 | `87e72a36792b9635` | 3/3    | **THE P0 ASSET**         |

**Supersampled, not upscaled.** `deviceScaleFactor: 2` renders the page at 2560×1600 into the same
1280×800 CSS viewport and records at that size, so every glyph is drawn with four times the pixels
and captured as drawn. That is capturing higher. Enlarging the 1× clip afterwards would invent
pixels that were never rendered, and this film's value is a mandate hash, exact token counts and a
reason code that a viewer is invited to READ.

**No AI upscaling and no frame interpolation, ever.** Anything that resynthesizes pixels can alter
a character, and a hash smoothed into a different hash turns the proof shot into a fake-looking
proof shot. The one thing worse than a soft frame is a sharp frame that is wrong. Written at the
capture options so the next person reaching for a "make it crisper" filter reads the reason first.

**It cost nothing but bytes.** 25.0 fps effective at both scales — 1391 packets over 55.64s at 2×,
1416 over 56.64s at 1× — so no frames were dropped and there is no stutter to report. The clip is
54% larger. The one-second difference is the models answering at slightly different lengths, which
is what two takes of one script look like.

Warm-up 1796ms (claude-main cold at 1795ms, which the warm-up exists to absorb — beat one still
opened with no stall). `269→176 tok · $0.00115` for Claude, `299→272 tok · $0.00021` for Sol. Five
beats; no beat was added for interrupts. No selector edited.

Take 10 is retained as the 1× fallback, per the rule that nothing is deleted.

### S1.4, corrected — take 13 at 1x is the asset, and 2x was not supersampled

| take   | scale | resolution | clip   | size  | fps  | sha256 (first 16)  | note                                      |
| ------ | ----- | ---------- | ------ | ----- | ---- | ------------------ | ----------------------------------------- |
| 12     | "2x"  | 2560x1600  | 55.64s | 6069K | 25.0 | `87e72a36792b9635` | padded, not supersampled — see below      |
| **13** | 1x    | 1280x800   | 54.04s | 3501K | 25.0 | `135b144bbed2eea8` | **THE P0 ASSET**, and the README's source |

**The 2x attempt did not do what it claimed, and this corrects the S14-4 entry above.** With
`deviceScaleFactor: 2` and a doubled `recordVideo.size`, take 12's page content occupies the top-left
1280x800 of a 2560x1600 frame; the remaining two thirds are grey padding. Measured rather than
assumed — a frame pulled at 44s crops to 1280x800 of room at exactly take 10's sharpness.

`deviceScaleFactor` reaches screenshots and **does not reach Playwright's video encoder**, which
captures the CSS viewport and letterboxes it into whatever size is requested. The result was 54% more
bytes for zero extra detail. Worse, so reported and reverted.

A genuinely supersampled capture needs the LAYOUT at 2560 — a 2560x1600 viewport — which is a
different shot with different line wrapping and a different amount of transcript on screen. That is a
decision about what the film shows, not a capture setting, and it is left for the owner.

**Take 13 is also the first take that shows the interrupt chip**, since take 10 predates S1.4. The
README's GIF and still frame are cut from it: 7 seconds at 10 fps from 41.5s, scaled down to 900px
wide with a 128-colour palette. Scaled DOWN, from captured pixels — never up, and never interpolated.

`269→172 tok · $0.00113` for Claude, `299→211 tok · $0.00017` for Sol. Every beat held first run, no
selector edited, frames 3/3 distinct.
