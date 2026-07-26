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

52.8s, all five beats, one continuous take, shot on the S-UI2 surface and **re-shot after
S1.2** (see below — the clip currently on disk is the S1.2 one, and the earlier 52.2s cut was
overwritten by a re-run of the same script). Takes 1–7 were shot before S-UI2 and are kept:
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
