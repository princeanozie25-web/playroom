# A4 — demo capture: report

**Run:** 25 July 2026, 20:00–20:50 local · **Commits:** `cf8cd78` (roadmap), `1da7ae3` (A4) · **CI:** green on both

---

## Headline

**Automated video capture worked.** No human was at the keyboard. Playwright's
`recordVideo` writes frames from the browser context directly — no display server, no
screenshot path — which is a different mechanism from the frame compositing that
defeated S0.2, S0.3 and T1. **13 takes recorded, all 13 verified as real video.**

Both P0 exit criteria now exist as clips:

- **S0.2** — two browsers converse, one socket is cut mid-conversation, two messages land
  while it is dark, and its own reconnect + resume-from-last-id refill the gap. Order
  correct, no duplicates, asserted against the sender's list rather than eyeballed.
- **S0.3** — an `@claude` turn held through the whole stream, ending on the tokens+cost
  footer.

You do not need to film tonight. The shot list exists anyway, for a prettier take and
for the S1.X/S2.X clips later.

---

## Where everything is

Everything below is **outside** the repo, in `C:\Users\princ\Documents\playroom-capture\`.

### Ready to use — `deliverables/`

| File                           | What                                          | Length | Size  |
| ------------------------------ | --------------------------------------------- | ------ | ----- |
| `S0.2-resume-B-observer.mp4`   | **The money shot** — observer heals itself    | 33.7s  | 211K  |
| `S0.2-resume-B-observer.gif`   | Same, trimmed to drop→recover, cropped        | 20s    | 314K  |
| `S0.2-resume-A-sender.mp4`     | Sender's side of the same take                | 31.2s  | 213K  |
| `S0.3-streaming-turn.mp4`      | Brief's prompt (turn completes in ~1.4s)      | 11.6s  | 138K  |
| `S0.3-streaming-turn.gif`      | Same, trimmed                                 | 8s     | 320K  |
| `S0.3-streaming-turn-long.mp4` | **Better footage** — 4s of visible token fill | 23.2s  | 525K  |
| `S0.3-streaming-turn-long.gif` | Same, trimmed                                 | 16s    | 1065K |

### Other artifacts

| Path                        | What                                           |
| --------------------------- | ---------------------------------------------- |
| `capture-shotlist.md`       | Your ten-minute shot list, if you want to film |
| `seam-transcript.txt`       | Terminal receipts artifact (see below)         |
| `videos/` + `videos-smoke/` | All 13 raw takes, nothing deleted              |
| `verify/`                   | The frames extracted for the realness check    |
| `A4-REPORT.md`              | This file                                      |

### The harness

`capture.mjs` (working copy), `verify-videos.sh`, `encode.sh`, `seam-demo.sh`,
`send-summon.mjs`, `query-events.mjs`, `db-probe.mjs`, `codrive.mjs`.

The capture script was graduated into the repo as `scripts/demo-capture.ts` (commit
`1da7ae3`). Playwright **1.62.0** + Chromium **151.0.7922.34** are installed here,
outside the tree — never in any repo `package.json` or lockfile.

---

## Proof the videos are real

`verify-videos.sh` pulls three frames from each clip at 20%, 50% and 85% of its duration
and hashes them. Three identical hashes would mean a still image in a video container.

**Result: 13/13 clips, 3/3 distinct frames each, all ≥11s, VP8 1280×800 @ 25fps.**

The clearest single piece of evidence is two frames from the observer's video:

- **frame 20** — red dot, exactly 3 messages. Dark, mid-gap.
- **frame 31** — green dot, all 5 messages, correct order, no duplicates.

Frame byte-sizes across that clip climb 35K → 44K → 59K → 67K (three messages), plateau
at ~81K through the dark period, then **jump to 100K** at frame 28 as the gap fills in.
That step is the S0.2 guarantee, visible in the file sizes alone.

---

## Terminal receipts artifact

`asciinema` could not be used: it needs a POSIX pty and has no Windows support, and `agg`
is likewise unavailable. Per the brief this fell back to a transcript —
`seam-transcript.txt`, every line real output, exit code 0:

- **S0.2 resume test, 3/3 runs green** (739ms, 602ms, 597ms)
- **Room created over HTTP** — `curl -X POST /rooms`, no UI involved
- **One live `@claude` turn**, then its event log straight out of Postgres: seq 816→821,
  `message` → `agent.turn.started` → 3 × `agent.turn.delta` → `agent.turn.completed`
- **The §17 telemetry columns as stored:** `claude-main`, `129→28 tok`, `$0.00027`,
  `latency_ms 881`, `prompt_hash ee7353d2a4253aef…`, `success true`
- **S0.3c latency spans:** `t_provider_ttft 638ms`, `ttfd_total 775ms`, `t_command 94ms`,
  `t_assemble 28ms`, `t_persist_first 14ms`, `t_fanout 0ms`

The script now computes its closing verdict from real exit codes. Its first version
printed a green success banner even though three steps had failed — fixed, because an
artifact that always claims success is worse than no artifact.

---

## Provider latency vs §7 budget

Eight live turns ran during A4. Provider TTFT, sorted (ms):

**633 · 638 · 643 · 690 · 717 · 763 · 811 · 834** — n=8, min 633, max 834, mean 716.

§7's budget for first streamed token (cloud) is **P50 <900ms, P95 <1.5s, ceiling 3s**.
Every one of the eight is inside the **P50** target, let alone P95. `ttfd_total` (first
delta actually fanned out to the client, which is what a member sees) ran 690–894ms.

Consistent with ADR-005's accepted scope. Note this is n=8 on one machine on one evening
against a single region — it corroborates the ADR, it does not re-measure it. S1.6 still
owns the `tokens_in` correlation.

Cost per turn ranged `$0.00027`–`$0.00172` with reply length. **Total provider spend for
the entire A4 run: ~$0.0052 (about 0.4p)** — against the £50/month dev cap (§16).

---

## The Neon autosuspend question

**Answer: autosuspend is real and costs about 0.6s on the first request.**

It took two measurements to establish that, and the first one is a trap worth recording:

| Idle before probe | Cold connect | Warm connect (avg of 2) | Delta               |
| ----------------- | ------------ | ----------------------- | ------------------- |
| 4m 20s            | 143.3ms      | 76.1ms                  | +67.2ms (1.9×)      |
| **7m 38s**        | **681.1ms**  | **80.6ms**              | **+600.5ms (8.4×)** |

**The first row proves nothing.** Neon's default suspend threshold is 5 minutes and
4m20s is under it, so that probe measured an endpoint that had never suspended; +67ms is
ordinary TLS variance. Had I stopped there I would have reported "no meaningful cold-start
penalty" — the probe script printed exactly that verdict — and it would have been wrong.

The second row is the real test: taken after the dev stack was **fully shut down** (the
API's `pg` pool otherwise holds the compute awake and no amount of waiting suspends it),
then a genuine 7m38s idle. Whole-request cost, not just connect:

|                                      | Cold        | Warm        | Delta      |
| ------------------------------------ | ----------- | ----------- | ---------- |
| connect                              | 681.1ms     | 80.6ms      | +600.5ms   |
| first query (`SELECT 1`)             | 17.3ms      | 12.1ms      | +5ms       |
| second query (`count(*) FROM rooms`) | 64.0ms      | 12.5ms      | +51.5ms    |
| **total first request**              | **762.4ms** | **105.1ms** | **+657ms** |

`pnpm migrate` against a warm endpoint applies nothing and takes **1631ms** wall.

**Guidance:** run `pnpm migrate` before filming, and before any latency measurement you
intend to cite. It costs 1.6s and removes a 0.65s confound. More importantly, see A4-F9 —
this interacts badly with the §7 first-token budget.

---

## Findings

### A4-F1 — a send into a non-existent room is dropped silently, end to end · **worth fixing**

Found by walking into it: the harness posted five messages that vanished with no error
anywhere. The chain:

0. `GET /rooms/:id` returns a correct **404** for the id. The server already knows the
   room does not exist — the knowledge is there and the socket path just does not use it.
1. `GET /rooms/:id/ws` never checks the room exists. `lastSeq` returns 0 and
   `eventsAfter` returns `[]`, so the socket opens happily for any id and even sends a
   cheerful `{"type":"hello","last_seq":0}`.
2. `postMessage` then violates the `events.room_id → rooms.id` foreign key.
3. The failure goes to `app.log.error` in `server.ts:135` — but `server.ts:27` constructs
   `Fastify()` with no logger, so Fastify v5 logging is disabled and **nothing is emitted**.
4. The client shows a green "open" dot and clears the input box.

Net effect: indistinguishable from success, from both sides. It was first seen on video —
a frame showing a green socket dot, a cleared input box and an empty message list — but
that take was from the pre-fix run and its video is gone, so the finding is backed instead
by a standalone reproduction: **`A4-F1-repro.txt`**, produced by `repro-f1.mjs`, which
posts into a room that does not exist and shows the socket opening, no error arriving, and
zero rows landing in Postgres.

This matters beyond the demo. §8's ordering law is "members never see a message the
fabric has not finished judging"; the dual of that is that a member should never be shown
a message _accepted_ that was in fact discarded. Worth an ADR-sized decision: reject the
socket for an unknown room, or surface send failures to the client, or both.

**Not fixed** — the brief forbids touching app code, and this is a design decision.

### A4-F9 — Neon autosuspend puts the first summon after idle at risk of breaching §7 · **new, from the measurement above**

Postgres is on the first-token path, not beside it. §8's persist-before-fanout law means
`postMessage` commits before the turn is triggered, and `recentMessages` then reads the
context window — so a cold connection delays the provider call rather than overlapping it.

Measured TTFT on a warm DB was 633–834ms, all inside §7's P50 <900ms. Add the measured
+657ms cold-connection cost and the **first summon after an idle period lands around
1.3–1.5s — breaching P50 and sitting on the P95 limit**, with nothing wrong in the code.

This is one of §21's audit questions answered with a number: "Are Section 7 budgets
realistic on Fly LHR with a single region, and what breaks first?" On this evidence, what
breaks first is the first request after quiet — and it breaks for infrastructure reasons,
not application ones.

Options, cheapest first: a keep-alive ping while a room has live members; accept it and
exclude first-after-idle from the P95 (but then say so in the telemetry, or the drift query
in §17 will flag phantom regressions); or disable autosuspend, which costs money against
the £40/mo infra line (§20). Worth noting `t_provider_ttft` already isolates the provider
leg, so the existing spans can distinguish this from real provider slowness — the data to
decide is already being collected.

Not urgent at P0 scale. It should be decided before S1.6 cites latency numbers, and before
any pilot sees a P95.

### A4-F2 — `POST /rooms` normalises the id with no signal

`createRoom.ts:4` slugifies (`toLowerCase`, non-alnum → `-`). Requesting `a4-clipA-1`
creates `a4-clipa-1`. The response carries the real id, so the contract is "always use
`room.id` from the response" — but nothing says so, and combined with A4-F1 the failure
mode is a room that looks fine and eats every message. My harness fell into exactly this
trap for one run. Documented in both capture scripts.

### A4-F3 — `scripts/` is not typechecked, contrary to CONTRIBUTING

CONTRIBUTING.md:14 states typecheck coverage is total and that an area the root build
cannot reach "is a defect: wire it in". The root `tsconfig.json` references
`packages/shared`, `packages/adapters`, `apps/api`, `apps/api/tsconfig.test.json` and
`apps/web/tsconfig.tsbuild.json` — **not `scripts/`**. So `migrate.ts`,
`latency-control.ts` and the new `demo-capture.ts` get no typecheck at all.

Predates this work. Called out rather than widened — wiring `scripts/` in may surface
pre-existing errors in the other two files, which is its own change.

### A4-F4 — two severance mechanisms in the brief do not work

Recorded because the next person will otherwise try them too.

- `context.route('**/…**', r => r.abort())` — `route()` **never sees WebSockets**. Only
  HTTP(S). It cannot sever a socket.
- `context.setOffline(true)` — does **not** drop an already-established WebSocket in
  Chromium 151. Measured: the observer's dot stayed green for the full 20s timeout.

What works is `page.routeWebSocket()` (Playwright ≥1.48), which proxies the real socket
so it can be cut on command and reconnects refused while dark. The server, the events and
the replay stay real; only the wire is cut.

### A4-F5 — `pg` will change SSL semantics under us · low, but diarise it

Every connection logs: `sslmode` values `prefer`/`require`/`verify-ca` are currently
treated as `verify-full`, and **in pg v9 / pg-connection-string v3 they will adopt libpq
semantics, which are weaker**. Both `DATABASE_URL` and `TEST_DATABASE_URL` use
`sslmode=require`. The repo pins `pg ^8.13.0`, so a major bump would silently loosen TLS
on a project whose §2 first principle is server-side enforcement. Pin `sslmode=verify-full`
explicitly and the warning goes away with no behaviour change.

### A4-F6 — the clips carry the Next.js dev badge · cosmetic

Filmed against `pnpm dev`, so the dev indicator sits bottom-left. Removing it needs no
source change — film against `pnpm --filter @playroom/web build && … start`. Noted in the
shot list.

### A4-F8 — agent replies render as raw markdown in one unbroken block · visible in every clip

Clearest in `S0.3-streaming-turn-long.mp4`'s final frame (`verify/final-footer.png`): the
reply shows literal `**Your client**` and `*Could fail:*`, and its numbered list collapses
into a single running paragraph because `page.tsx` renders `{it.text}` as plain text inside
an `<li>`, so newlines collapse under normal HTML whitespace handling.

Functionally correct and arguably the honest thing for v1 — rendering model output as
markup is a real injection surface, and §13's L1 rule is that foreign content is data, not
instructions. But it reads as unfinished on camera, and it is the one thing in these clips
that a YC partner would comment on. Two independent decisions: whether to preserve
newlines (`white-space: pre-wrap`, purely cosmetic, no new attack surface), and whether to
render markdown at all (not cosmetic — needs a sanitisation story first).

**Not fixed** — app code is out of scope for A4, and the second half is an ADR.

### A4-F7 — the short prompt is too fast to read on camera

The brief's `@claude explain what this room does in three short sentences` answers in
~1.4s (54 tokens). "Watch it fill in token by token" is a blink. Takes 1–3 use the
brief's prompt verbatim; `clipBLong` is an added take with a longer question — 312 tokens,
~4s of visible fill — which is the one to put in the deck.

---

## Invariants check

| Invariant                                                        | Status                                                                                                          |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Zero or one A4 commit                                            | One: `1da7ae3`. (`cf8cd78` is the separately-instructed roadmap.)                                               |
| `pnpm verify` green, CI green after push                         | Both green on both commits                                                                                      |
| Nothing in the repo but `scripts/demo-capture.ts` + `.gitignore` | Held for A4                                                                                                     |
| Every artifact is real capture of the running app                | Held — 13/13 frame-verified, no splicing                                                                        |
| Demo room and events deleted at stop                             | **Done** — 103 events + 15 rooms, then 8 + 1 from the post-cleanup verification run. `a4-%` rooms: 0, events: 0 |
| No new repo dependencies                                         | Held — Playwright resolves from `$PLAYROOM_CAPTURE_HOME`                                                        |
| No app/test/config/UI changes to flatter the demo                | Held — problems reported as findings                                                                            |
| Localhost only                                                   | Held                                                                                                            |

Dev stack shut down and ports 3000/3001 released.

---

## What I would do next

1. **Decide A4-F1.** It is the only finding with teeth. A silent drop on a governed write
   path is the wrong default for this product specifically.
2. **Pin `sslmode=verify-full`** (A4-F5). One-line change, removes a future surprise.
3. **Use `S0.3-streaming-turn-long.mp4`** for the deck, not the short one.
4. Leave A4-F3 (`scripts/` typecheck) for a slice of its own.
