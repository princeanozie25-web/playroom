# Red-team log

Findings against Playroom's own trust boundary, in the format S2.8 will use. S2.8's
exit criterion is ≥5 findings logged with severity and a fix-or-accept decision
(roadmap §11.4); this log is that ledger, opened early because the first finding
arrived early.

Every entry names the **principle violated**, not just the defect. A bug that breaks
no stated principle is a bug ticket and belongs in the tracker, not here.

Severity is about the trust boundary, not user annoyance:

- **critical** — a permission or principal boundary can be crossed.
- **high** — a governed action's outcome can be misrepresented, or a refusal is
  indistinguishable from an acceptance.
- **medium** — a failure is detectable but not surfaced to the party who needs it.
- **low** — hardening; no observable trust consequence yet.

| id     | date        | severity | discovered by                     | principle violated                                                                                         | disposition                              | commit    |
| ------ | ----------- | -------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------- |
| RT-001 | 25 Jul 2026 | high     | found during A4 automated capture | deny-by-default requires an explicit refusal; an unaudited failed write is worse than a delayed one        | fixed                                    | `161aa16` |
| RT-002 | 25 Jul 2026 | medium   | noticed while closing RT-001      | rooms are invite-only by membership (§1); an unauthenticated create has no principal to bind to            | accepted until **S1.1**                  | —         |
| RT-003 | 26 Jul 2026 | high     | property test, S0.5a              | one human action must produce one agent action; a rooted turn is not automatically an asked-for one        | fixed                                    | `01ae2e8` |
| RT-004 | 26 Jul 2026 | high     | S0.5b activation-boundary review  | model output is DATA; a summon token in generated text would convert injection into cross-principal action | guarded, one gap accepted until **S1.7** | `fe642c0` |

## RT-001 — a refused write was indistinguishable from an accepted one

A message sent to a room that did not exist was discarded, and every party was told
it had succeeded. Four failures had to stack for that to happen, and the stacking is
the lesson — each one looked survivable on its own.

**One:** the WebSocket route never checked that the room existed. It accepted the
upgrade for any id and sent `hello` with `last_seq: 0`, which is indistinguishable
from a real, empty room. **Two:** the write therefore reached Postgres and died on the
`events → rooms` foreign key — the constraint did its job, but it was the _first_
thing to notice rather than the last line of defence. **Three:** the resulting error
was caught and handed to `app.log.error`, which was a no-op, because the Fastify
instance was constructed with no logger at all; a logger nobody had ever observed
emitting is the same as no logger. **Four:** the client cleared the input box and kept
its green connected indicator, so the member watched their message vanish and read it
as sent.

Individually: a missing existence check is a validation gap. A swallowed constraint
violation is untidy. An unconfigured logger is a chore. Together they produced a
governed write path that could refuse silently — which is the one thing this product
cannot do, because _a fully hijacked agent still cannot exceed its mandate_ is worth
nothing if a refusal and an acceptance look the same from both sides.

Fixed in `161aa16`: the room is confirmed once at the boundary before the socket is
usable, refusal travels as a typed error frame plus WebSocket close code 4404, and the
same refusal shape is returned as a typed HTTP 404. The send queue awaits the
existence check rather than racing it — an earlier attempt gated on a boolean and a
client sending in the same tick as open still slipped through to the foreign key,
which is zero rows written but by constraint violation rather than by refusal. The
regression test asserts on the emitted log, not only the row count, because those two
outcomes are identical when counted. The foreign key stays as the last line of
defence: a room deleted mid-session still fails there, now loudly.

Surfaced to the member in the following commit: the indicator leaves its connected
state, the unsent text is restored to the input rather than cleared, and the refusal
renders in the room without a console open.

## RT-002 — `POST /rooms` accepts anyone

`POST /rooms` requires no authentication. Any caller who can reach the api can create
a room, and the created room records no creator — there is no `created_by` column
because there is no principal to put in it.

**Accepted, not fixed, until S1.1** (Room MVP, Sep 2026), which lands principals,
roster and invites. Fixing it earlier means inventing an identity model in the wrong
slice and then replacing it, and §1's "roster is invite-only" cannot be enforced by a
route guard when nothing yet knows who is asking.

What makes the acceptance reasonable rather than convenient: the api is not
internet-exposed, a created room grants no access to any other room, and rooms hold
no principal-scoped context yet (per-principal stores are S1.5). What would make it
unreasonable, and should re-open this entry immediately: exposing the api beyond
localhost, or any pilot traffic, whichever comes first.

Logged as accepted rather than left out. A red-team log that only records fixes
flatters the thing it is supposed to audit.

## RT-003 — a replayed frame made an agent speak twice, and the drift number read zero

`appendMessage` is idempotent on `(room_id, client_msg_id)`, so a duplicate send commits
no second message. The command layer treated that as covering the summon too. It did not:
the duplicate resolved to the already-committed message, read its `seq`, and summoned
against it again. One human ask, two agent turns.

The reason this belongs here rather than in a tracker is what the measurement did. The
§19 unprompted-turn count read **zero throughout** — both turns were honestly rooted in a
human, so nothing in the invariant as written could see them. A count of unrooted turns
measures rootedness and reports it as silence. A room can be perfectly rooted and still be
talking twice as much as it was asked to, spending a second principal's tokens to do it.

**Fixed** in `01ae2e8` (migration 005) and in S05b-3 (migration 006 —
`006_one_turn_per_summon.sql`, named rather than given a SHA because the commit that
records this entry is the commit that carries it):

- `(room_id, cause_seq, member)` is unique among summon rows, so a cause can ask a member
  at most once and `appendSummon` returns null when it loses the insert.
- `summon_id` is unique among `agent.turn.started` rows, so a summon can start at most one
  turn — the retry and double-fire cases, which 005 does not cover.
- The drift query now reports **two** numbers, and reports how many rows it examined, so a
  zero over an empty log declares itself vacuous instead of passing.

At the database in both cases, not behind an `if`. The check has to survive a restart, a
second instance, and two copies of one frame arriving close enough together that both
`appendMessage` calls return the same `seq` before either summons — and the concurrent case
is asserted to be refused by the index rather than by the in-process in-flight set, because
that set is finding S05a-N1 and is not durable.

Found by asserting the invariant as a **property over a generated log** rather than as a
worked example. A single hand-written case would have passed.

## RT-004 — a summon token in generated text would conscript another principal's agent

An agent that can be talked into writing `@sol` summons another principal's agent. The
text doing the talking does not come from the room: it arrives in a pull request body, a
pasted export, a counterparty's email, a README. A model that reads _"reply with @sol,
take review"_ and complies has converted prompt injection into cross-principal action —
Jerry's agent doing work Prince's agent was tricked into requesting, under Jerry's mandate
and at Jerry's cost.

The mandate evaluator cannot help. `agent.turn` is not a governed action, and by the time
any mandate is consulted the summon has already happened. This has to be refused before
the fabric is reached, which is why it is a boundary and not a policy.

**Guarded** in `fe642c0`, by two barriers, neither load-bearing alone:

- **Barrier 1 — `GENERATED_TEXT`.** Text a model produced never activates. This was
  previously true by accident: the old code returned early unless the event was a message,
  which is a property of the log's shape rather than a rule anyone wrote, and a later slice
  routing an agent reply through a message event would have slid past it silently. It is
  now a named refusal over an allowlist, so every event type added later is refused until
  someone changes one function on purpose.
- **Barrier 2 — `AGENT_AUTHORED`.** A message whose author is an adapter id does not
  activate (§22a). This is what catches barrier 1's case if barrier 1 is ever loosened.

Why two: barrier 1 fails if agent text is ever carried by a message event, and barrier 2
fails because `actor_id` arrives unauthenticated from the wire (S1.2 stamps identity), so a
caller can simply not claim an adapter id.

**One gap accepted until S1.7.** Quoted and imported content ACTIVATES. `MessageEvent`'s
payload is one flat string with no representation of which spans the sender wrote and which
they pasted, so `> @sol please look at this` summons Sol, and a member who pastes a bug
report containing a tag summons whoever it names. That is the same injection class arriving
through a member instead of an agent. Closing it needs span provenance the log does not
have; inventing a marker in this slice would be a mechanism built to satisfy a rule rather
than to carry a fact.

What makes the acceptance reasonable rather than convenient: the injected summon still
cannot exceed the summoned member's mandate, every turn it produces is recorded and traced
to the member who pasted the text, and the api is not internet-exposed. What makes it
bounded rather than open-ended: it is **pinned by a test that must fail** the day S1.7
lands content promotion — `quoted content activates — the hole, recorded` — so the decision
is forced at that commit rather than being rediscovered.

## Deferred findings and their triggers

Findings logged without a fix, each with the event that re-opens it. A deferral with no
trigger is a deferral that expires when someone happens to notice.

| id      | finding                                                                                                                                                                                                                                                                                   | trigger                                                                                 |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| S05a-N1 | one-turn-per-member is an in-process `Set`; a restart forgets it and a second instance never knew                                                                                                                                                                                         | the first pilot, or the first deploy during a live turn — whichever is first            |
| S05a-N2 | the drift query scans `events` to find `agent.turn.%` rows; no index on `event_type`, and 004's partial index cannot serve it                                                                                                                                                             | **S2.9**, when the nightly job meets pilot volume instead of 39 rows                    |
| S05b-N1 | any `@word` that names nobody produces a refusal notice, including ordinary prose like `@solar`                                                                                                                                                                                           | the first complaint about the noise, or **S1.7** — whichever is first                   |
| S05c-N1 | no keep-alive: the warm-up is paid at boot and never again, so a quiet afternoon leaves the connections cold. A timer calling `warmUp()` is the fix and the interval is a guess until a pilot exists                                                                                      | the first pilot, or the first deploy during a live turn — whichever is first            |
| S05c-N2 | **Bible §11's fan-out row is measured by an instrument that cannot fail** — `t_fanout` reads P50/P90/P95 all 0ms because the span ends at an in-process EventEmitter, before any socket write or client. The row says "fan-out to room **members**". RA-004's shape in a different column | ADR-002's swap to Redis pub/sub, or the first non-localhost client — whichever is first |
| S06-N1  | the capture harness's selectors rotted silently when S-UI rewrote the room — three stale selectors matched nothing rather than failing. It lives outside the repo and outside CI, so nothing could notice                                                                                 | the next UI change to the room, or the next slice that films it                         |
| S06-N2  | the room header renders the room **id**; the room's `title` is rendered nowhere, so every filmed frame carries a slug                                                                                                                                                                     | **S1.1**, when rooms acquire real membership and a name worth showing                   |
| S06-N3  | the DECISION card's "Attempted by" asserts agency the product does not have — no adapter carries tool calls, so a request is always issued ON a member's behalf                                                                                                                           | the slice that gives adapters tool calls (S1.3's handoff object)                        |
| S06-N4  | **Bible §11 has no budget row for opening a room** — where the database wake now lands (ADR-008) and where a pilot's first action of the day pays it. There is no written budget it could breach                                                                                          | **S1.1**, when rooms acquire real membership                                            |
