# S1.6 — a long room, verified on local

**No film change. Take 13 stands.** This is the record of the S1.6 slice being exercised on a real
browser against the local build (the deploy is still billing-blocked, so this is local, said plainly),
and the successor question it answers: what breaks first in a room that runs for a week.

## What was verified (local, real Anthropic)

A room was seeded with 50 messages and its summary folded ahead of time — 26 of the 50 messages folded
into a `room.summary` event, the recent window left verbatim — then opened in the browser as `prince`.

- **The meter renders, quiet and ambient.** The header showed `this room · $0.0018` — the per-room
  spend baseline, carried in the `hello` frame and summed server-side. At that point the only spend was
  the summariser's own fold, so the meter was showing summary cost: the accounting is not hidden.
- **The meter increments live.** Summoning `@claude` moved it to `this room · $0.0032` — the $0.0018
  baseline plus the turn's `$0.00132`(shown on the turn's own footer,`1122→39 tok · $0.00132`).
  Baseline plus live increment, no double count.
- **The summary keeps the room coherent.** Claude — holding only the last ~24 messages verbatim and the
  SUMMARY of the older 26 — answered that the room had been "splitting the fabric evaluator into its own
  service … token budgeting … endpoint throttling." Those topics live in the SUMMARISED span, not the
  recent window. The agent stayed oriented about the whole room while the window stayed at 1122 input
  tokens — the coherence this slice buys, doing its job.
- **The meter survived a truncated transcript.** The transcript on that load was short — see S16-N1 —
  yet the meter was correct, because it reads the server's `hello` baseline rather than the client's
  (incomplete) event list. That is the reason the number comes from the server and not from a
  client-side sum.

## The successor question — what breaks first in a week-long room

Now that a room can run long AND cheap, the honest limits are no longer about the agent's context. They
are on the human-facing side, and they decide whether an unattended loop can actually live in a long
room. These are performance/coherence observations, not trust-boundary violations, so they are recorded
here rather than in the red-team log (whose rule is a violated principle).

- **S16-N1 — the transcript truncates on reload; the meter does not.** `Room.tsx` seeds its resume
  cursor from `sessionStorage` on mount and then connects with an EMPTY event list. A full page reload
  resets React state but not `sessionStorage`, so the client replays only events AFTER the stored cursor
  and the room appears to have lost its history. Observed during this check: the room showed only the
  newest exchange. The resume-from-last-id design is right for a socket DROP (the component stays mounted
  and keeps its events); it is wrong for a reload, where the cursor should reset to 0. Pre-existing, but
  S1.6's whole reason to exist — long rooms — is what makes it the first thing a member notices.
  **Trigger:** the first member who reloads a long room, or the first pilot. **Fix:** re-fetch from 0 on
  a fresh mount (or paginate), keeping the cursor only for in-session reconnects.
  **RESOLVED in S1.6b** — the client windows on open and the cursor is in-memory only; see
  `s16b-windowed-load.md`.

- **S16-N2 — replay is O(room lifetime); the summary bounds the agent's context, not the client's load.**
  A fresh connect replays EVERY event (`eventsAfter(roomId, 0)`). The rolling summary bounds what a turn
  costs; it does nothing for what a browser downloads and rebuilds on open. A week-long room is thousands
  of events, so opening it is thousands of frames and thousands of DOM rows — slow, and heavy on a phone.
  This is the first HARD scaling limit for a long room, and it is exactly the shape the summary already
  solved one layer over. **Trigger:** the first genuinely long room, or a pilot. **Fix:** windowed
  replay — the recent window plus the summary first, older on scroll — the client mirror of what the
  server does for the agent.
  **RESOLVED in S1.6b** — measured 40x fewer events to open a 1000-message room; see
  `s16b-windowed-load.md`.

- **S16-N3 — the summary is lossy, and it compounds.** Each fold re-summarises (previous summary + new
  batch) under a fixed output cap, dropping the least important older detail. Over a week — dozens of
  folds — the distant past decays to a gist while the recent window stays verbatim. That is correct for a
  summary, and it is stated so it is not discovered as a surprise: an agent's memory of an early decision
  is APPROXIMATE, and precise recall means reading the log, not the summary. By design; the log remains
  the record.

## Can the brief-closeout loop live in a room that runs long?

**On the agent's side, yes.** The summary makes an unattended agent bounded in cost and coherent in
context indefinitely — a summon stays ~1.2k tokens and ~$0.0015 whether the room is an afternoon or a
week old, and the older span is represented rather than dropped. That is the property a long loop needs.

**On the observer's side, not yet comfortably.** A human watching a week-long room hits S16-N1 (a reload
shows a truncated room) and S16-N2 (opening it is slow). Neither stops the loop; both make watching it
unpleasant, and both want the same fix the summary already is — a window, not the whole history. And
S16-N3 means a loop that depends on precise long-ago detail must consult the log, not the summary.
