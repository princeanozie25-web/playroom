# S1.6b — the client loads a window, verified on local

**No film change. Take 13 stands.** S1.6 moved the AGENT off full-transcript replay; this moved the
CLIENT, closing the two limits S1.6's own closeout named — S16-N1 (a reload showed a truncated
transcript) and S16-N2 (opening a long room replayed every event). This is the record of both, before
and after, on the local build (the deploy is still billing-blocked, so LOCAL, said plainly).

## S16-N2 — open-to-interactive is now O(window), not O(room lifetime)

What a client pays to open a room is what it downloads and rebuilds. Measured
(`scripts/measure-open.ts`, real rows, the window set where a fold would leave it):

| room size | full replay (before)          | window (after)            | fewer |
| --------- | ----------------------------- | ------------------------- | ----- |
| 50 msgs   | 51 events / 12.0 KB / 22ms    | 25 events / 6.0 KB / 12ms | 2x    |
| 200 msgs  | 201 events / 47.7 KB / 25ms   | 25 events / 6.0 KB / 10ms | 8x    |
| 1000 msgs | 1001 events / 238.7 KB / 48ms | 25 events / 6.1 KB / 11ms | 40x   |

The window is FLAT — ~25 events, ~6 KB — whether the room is 50 messages or 1000, while the full replay
grows with the room. A 200-message room now opens at the cost of a 20-message room, which was the exit
criterion. Verified in the browser: a 60-message room opened showing messages 37–60 and nothing older
loaded.

## S16-N1 — the transcript is windowed by design, not truncated by accident

The resume cursor was persisted to `sessionStorage`, so a RELOAD resumed from a stale point and showed
a truncated room. It is in-memory only now — it resumes a dropped socket, never decides what a fresh
open loads. Verified in the browser:

- **Open:** the 60-message room loaded messages 37–60 (the 24-message window) with a "load earlier
  messages" control at the top.
- **Reload:** re-loaded the same fresh 24-message window — not a truncated tail, which is what the old
  stale cursor produced.
- **Load earlier:** one click paged in messages 1–36, correctly attributed and in order, all 60 then
  present; the control then vanished, because the first message had been reached.

The distinction is the whole slice and it is a comment in the code: truncation loses messages silently;
windowing shows a bounded view of messages that are all still there and all one request away. A
server-level test (`history.test.ts`) pins it — the recent window excludes the summarised older
messages AND every one of them is reachable by paging, arriving correctly attributed. N1 fixed, not
hidden.

## The two questions the brief asked

- **Do reopen and reconnect share a path?** Yes — both connect the socket with `after=<newest event
held>` and resume from there, identical logic. The only difference is that a reopen first bootstraps
  its window over HTTP (it holds nothing); a reconnect already has it. One resume path, not two.
- **Are the client and server windows one config value or two-asserted-equal?** One BOUNDARY. The
  client loads the events after the summary's `covers_through_seq`; assembly reads the messages after
  the same floor. `history.test.ts` asserts the window's messages equal the agent's — same floor, same
  recent span, never two that drift.

## The successor question — what does the brief-and-closeout loop need next that does not exist?

The room is now coherent at any length (the summary), cheap to summon in (the window), openable and
watchable at any length (this slice), and honest about spend (the meter). What the loop needs next is
not a read or a render. It is a **governed agent-initiated continuation** — and it is boundary work, so
it is the hard, careful kind.

Every turn in Playroom today must be rooted in a HUMAN. `summonCommand` refuses an agent or `system`
as the root of a summon, `depth` is always 0, and a handoff to an agent moves who holds the work but
triggers NO turn (agent-path.test asserts exactly that). That is silence-by-default, and it is correct.
But the brief-and-closeout loop IS an agent-continued chain: one finishes, the next picks up, for hours
without a human tagging each step. So the boundary that makes Playroom safe is precisely the one a loop
must cross.

The summon constructor already names the shape of the answer and left it as a TODO: _"There is
deliberately NO CAP YET… the cap arrives with the path that needs it."_ This is that path. The first
thing the loop needs is a way for a completed turn (or a handoff to an agent) to trigger the next turn
UNDER A BOUNDED DEPTH AND A BOUNDED SPEND — so the chain continues unattended but provably cannot exceed
N steps or the daily ceiling. Two things do not exist yet and both are prerequisites:

1. **The depth cap, now load-bearing.** An agent-rooted summon, admitted through the constructor with
   `depth > 0` and refused past a cap. This is where silence-by-default meets automation, and it must be
   built as carefully as the activation boundary was, because it is the same boundary run in reverse.
2. **A trigger.** Nothing schedules or continues a turn today; a turn happens because a human sent a
   message. An unattended loop needs the completion of one step to BE the trigger for the next — an
   event-driven continuation, bounded by (1).

Everything else the loop wants — a durable in-flight guard across restarts (S05a-N1), a place to keep
the brief and the closeout as room artifacts — is smaller and can follow. The governed continuation is
the gate, and sequencing it before the loop is the same call that put this slice before the loop.
