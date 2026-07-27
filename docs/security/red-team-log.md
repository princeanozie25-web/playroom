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

| id      | date        | severity | discovered by                                 | principle violated                                                                                                                                | disposition                              | commit    |
| ------- | ----------- | -------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------- |
| RT-001  | 25 Jul 2026 | high     | found during A4 automated capture             | deny-by-default requires an explicit refusal; an unaudited failed write is worse than a delayed one                                               | fixed                                    | `161aa16` |
| RT-002  | 25 Jul 2026 | medium   | noticed while closing RT-001                  | rooms are invite-only by membership (§1); an unauthenticated create has no principal to bind to                                                   | fixed                                    | `S13c-2`  |
| RT-003  | 26 Jul 2026 | high     | property test, S0.5a                          | one human action must produce one agent action; a rooted turn is not automatically an asked-for one                                               | fixed                                    | `01ae2e8` |
| RT-004  | 26 Jul 2026 | high     | S0.5b activation-boundary review              | model output is DATA; a summon token in generated text would convert injection into cross-principal action                                        | guarded, one gap accepted until **S1.7** | `fe642c0` |
| RT-005  | 26 Jul 2026 | high     | S1.1a review, scoped in S1.1b                 | an unauthenticated roster read discloses which member may take which action, and M-N1 lets a caller claim to be that member                       | fixed                                    | `7fc279a` |
| M-N1    | 25 Jul 2026 | critical | logged at the mandate slice                   | identity must be stamped by the boundary, not asserted by the caller; `actor_id` arrived from the wire as a free string                           | fixed                                    | `7fc279a` |
| S04-N2  | 25 Jul 2026 | high     | logged at the mandate slice                   | a mandate is an unsigned file, so _this principal granted this authority_ is asserted by the document, not proven                                 | open, narrowed — trigger **S2.6**        | —         |
| S12-N2  | 26 Jul 2026 | medium   | S1.2 closeout, while writing the roster scope | a governed request's subject must be justified by a record, not asserted by the caller — and it was not even checked to be a member               | fixed                                    | `S13-3`   |
| S13-N2  | 27 Jul 2026 | high     | S1.3 Phase 0, reading the handshake           | room membership is the product's boundary; the handshake checks that a room EXISTS, not that the caller is IN it                                  | fixed                                    | `S13b-2`  |
| S12-N1  | 26 Jul 2026 | low      | S1.2, while scoping the roster read           | an oracle anywhere undoes silence everywhere; room existence was readable without a credential                                                    | fixed                                    | `S13b-3`  |
| S13-N3  | 27 Jul 2026 | medium   | S1.3 Phase 0, reading Room.tsx                | a credential must not travel where logs collect it; the browser's token is in the WebSocket query string, and the code cited the wrong finding id | fixed                                    | `S13c-1`  |
| S13c-N1 | 27 Jul 2026 | low      | S1.3b, a standalone run under load            | a suite that fails 1-in-N erodes the signal it exists to give; two timing-sensitive tests failed once and have not reproduced                     | accepted until the first CI failure      | —         |

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

| id      | finding                                                                                                                                                                                                                                                                                   | trigger                                                                                            |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| S05a-N1 | one-turn-per-member is an in-process `Set`; a restart forgets it and a second instance never knew                                                                                                                                                                                         | the first pilot, or the first deploy during a live turn — whichever is first                       |
| S05a-N2 | the drift query scans `events` to find `agent.turn.%` rows; no index on `event_type`, and 004's partial index cannot serve it                                                                                                                                                             | **S2.9**, when the nightly job meets pilot volume instead of 39 rows                               |
| S05b-N1 | any `@word` that names nobody produces a refusal notice, including ordinary prose like `@solar`                                                                                                                                                                                           | the first complaint about the noise, or **S1.7** — whichever is first                              |
| S05c-N1 | no keep-alive: the warm-up is paid at boot and never again, so a quiet afternoon leaves the connections cold. A timer calling `warmUp()` is the fix and the interval is a guess until a pilot exists                                                                                      | the first pilot, or the first deploy during a live turn — whichever is first                       |
| S05c-N2 | **Bible §11's fan-out row is measured by an instrument that cannot fail** — `t_fanout` reads P50/P90/P95 all 0ms because the span ends at an in-process EventEmitter, before any socket write or client. The row says "fan-out to room **members**". RA-004's shape in a different column | ADR-002's swap to Redis pub/sub, or the first non-localhost client — whichever is first            |
| S06-N1  | the capture harness's selectors rotted silently when S-UI rewrote the room — three stale selectors matched nothing rather than failing. It lives outside the repo and outside CI, so nothing could notice                                                                                 | the next UI change to the room, or the next slice that films it                                    |
| S06-N2  | the room header renders the room **id**; the room's `title` is rendered nowhere, so every filmed frame carries a slug                                                                                                                                                                     | **S1.1**, when rooms acquire real membership and a name worth showing                              |
| S06-N3  | the DECISION card's "Attempted by" asserts agency the product does not have — no adapter carries tool calls, so a request is always issued ON a member's behalf                                                                                                                           | the slice that gives adapters tool calls (S1.3's handoff object)                                   |
| S11b-N1 | `counterparties` is checked AFTER `protected_actions`, per Bible §9.2's order, so a protected action asked under a member who is NOT in the room returns CO_SIGN — a human invited to sign for someone who is not there. Fail-closed, but it asks the wrong question first                | an owner ruling on the evaluation order; the same argument that put scope before protected applies |
| S06-N4  | **Bible §11 has no budget row for opening a room** — where the database wake now lands (ADR-008) and where a pilot's first action of the day pays it. There is no written budget it could breach                                                                                          | **S1.1**, when rooms acquire real membership                                                       |

## RT-005 — the roster is readable by anyone, and M-N1 lets them use it

`GET /rooms/:id/members` requires no authentication. Any caller who can reach the api
receives, for every member of a room: their id, their display name, the principal they act
for, and **the exact scope and protected-action list from their mandate**.

Read-only. It asserts nothing, writes nothing, and names no provider (§6 holds). On its own
it is an information-disclosure finding of ordinary severity.

**It is not on its own.** M-N1 says `actor_id` arrives on the wire as a free string and the
server writes what it is given — a caller may claim to be any member. Put the two together:

> The roster read tells you **which member may take which action**. M-N1 lets you **claim to
> be that member**.

That is target selection followed by impersonation, using two documented findings and no
exploit. Before this the same information required filesystem access to the deployment; the
roster is now an HTTP GET. **This raises M-N1's severity rather than sitting beside it** —
M-N1 was logged as a gap in identity stamping, and it should be read from here on as the
second half of a two-step with a published first half.

**FIXED IN S1.2.** `7fc279a` deleted the impersonation half; the roster half lands in the same
slice's third commit. Both steps of the two-step are gone: the wire can no longer express _I am
this member_, and the roster read requires a credential and membership of the room being read.
The original disposition is kept below exactly as it was written — a log that edits its own
reasoning once the answer is known cannot be audited.

**Accepted until S1.2**, which stamps identity at the gateway. Fixing it earlier means
inventing an authentication model in the wrong slice and replacing it, and there is nothing
to scope a read _to_ until a caller has a verified identity.

What makes the acceptance reasonable rather than convenient: the api is not
internet-exposed; every action a claimed member could take still traverses the mandate
evaluator, so **a caller impersonating `claude-main` gains claude-main's mandate and not more
than it** — `pr.merge` is still CO_SIGN and still cannot be completed (S2.2), and an action
outside scope is still BLOCK. The disclosure widens who can aim; it does not widen what the
aim achieves.

What would make it unreasonable, and should re-open this immediately: exposing the api beyond
localhost, any pilot traffic, or any slice that makes an ALLOW verdict cause a real external
side effect before S1.2 lands. The third is the one to watch — today no ALLOW does anything,
which is most of why this is survivable.

S1.1b narrowed the read from every member in the system to the members of one room, which is a
smaller disclosure and the reason the capability was built here. Who may ask is still not
enforced.

### RT-005's acceptance condition — the one line to check

> **NO ALLOW CAUSES ANY EXTERNAL SIDE EFFECT ANYWHERE IN THE SYSTEM.**

That sentence is the whole acceptance, and it is checkable rather than a judgement. Today an
`ALLOW` verdict returns a verdict: nothing merges, nothing deploys, nothing is sent, nothing
is written outside Playroom's own event log. So a caller who impersonates `claude-main` gains
claude-main's mandate and **nothing that mandate permits actually happens**. The disclosure
widens who can aim; it does not widen what the aim achieves.

**The slice that ends this is S2.6, the GitHub bridge.** The moment an `ALLOW` causes a comment
to be posted, a branch to be pushed or a pull request to be touched, impersonation stops being
survivable and this entry stops being acceptable. **Whoever builds S2.6 must find this line
before they merge it** — that is what a trigger is for, and it is why the condition is written
as a sentence about the system rather than a paragraph about the risk.

Earlier candidates that also end it, in the order they are likely to arrive: any outbound
email or webhook; any write to a repository, tracker or calendar; any payment. If a slice adds
one of those before S1.2 lands, RT-005 escalates from _accepted_ to _blocking_ and M-N1 with
it.

---

## What S1.2 closed, and what it did not

Each finding individually, because "identity is stamped now" is the kind of sentence that closes
four findings by association and leaves the fifth quietly open.

### FIXED — M-N1: `actor_id` arrived from the wire as a free string

`ClientSend.author` is **deleted**. The frame has no field for it, so this is not validation of a
claim — there is nothing left to claim. The actor is resolved once at the handshake from a
credential and held in the socket's closure; `accepted` resolves the identity rather than a
boolean, so no code path handles a frame without an authenticated member in hand.

Asserted by `apps/api/test/identity.test.ts`: a frame smuggling `author: 'sol'` is written as
`prince`, and nothing anywhere in the room is attributed to `sol`.

`7fc279a`.

### FIXED — RT-005: the roster read, and what it was the first step of

Both halves. The rows were scoped to one room in S1.1b; the READER is scoped now — a credential,
then membership of the room being read.

An authenticated non-member receives **byte-identical bytes to a room that does not exist**,
deliberately. `sol` is a legitimate credential holder, and "you are not in this room" would let
Jerry's agent enumerate Prince's room ids by trying. This is the one place in the codebase where a
refusal does not distinguish two mistakes _to the caller_ — the distinction is not lost, it is
moved to the server's log, where the caller cannot read it. The reason is written at the route so
it cannot be tidied away later.

### FIXED for every write from here on — S11a-N3's authenticated half

Migration 008 made `actor_member_id` a nullable column with a real foreign key: when an event
named a member, that member existed. It could not say every event names one, because rejecting an
unrecognised actor required knowing who the caller was.

Migration 010 tightens it: `CHECK (actor_member_id IS NOT NULL OR actor_id = 'system')`.

- **Not `NOT NULL`.** `system` authors the room's own notices — the in-flight refusal, the
  unknown-member sentence. It is the room speaking, it has no principal, and seeding a `system`
  member to satisfy a constraint would be fabricating a record to make a check pass.
- **`NOT VALID`, deliberately.** The log holds rows written before authentication existed
  (`Fable`, `nobody-in-particular`) and it is **append-only**. Validating retroactively means
  rewriting history so that a new rule appears to have always held. The constraint governs every
  write from here on; the historical rows stay visibly historical.

So the honest sentence is not "every event names a real member". It is "every event written after
010 names a real member or is the room speaking" — a different claim, and the true one.

### STILL OPEN, NARROWED — S04-N2: a mandate is an unsigned file

The credential proves that the holder of a token is the member it was issued to, and a member is
bound to a principal. So **`Sol speaks for Jerry` is enforced at the connection** as of this slice.

**`Jerry granted this mandate` is still not proven.** The mandate is a YAML file in the repository;
the credential is not Jerry's key. Anyone who can commit to `mandates/` can widen a scope, and the
room will render the widened authority truthfully — because the room is truthful about the
document, and it is the document that is unproven.

A token in an environment variable authenticates a **process acting as a member**: exactly what an
agent gateway is, and only approximately what a browser session is. No login, no second factor, no
per-human key. Nothing here identifies a **person**.

Narrower than it was, and not closed. What closes it: signed mandates, or an identity provider that
authenticates humans. It inherits the acceptance condition below, and with it the **S2.6** trigger.

### NEW — S12-N1: `GET /rooms/:id` is still an existence oracle

The roster route is carefully not an oracle. Its neighbour is. `GET /rooms/:id` takes no credential
and returns the room row, so an unauthenticated caller can still probe whether a room id exists —
which means the handshake's deliberate "identity before existence" ordering is undermined by a
sibling route answering the same question for free.

Severity **low**: existence only. No roster, no principals, no mandates, no events, and room ids
are not secrets in any current deployment. Logged rather than fixed because authenticating the room
read is a different shape of change — every HTTP route, plus the web tier's room page — and
inventing it inside S1.2 would be the same mistake as inventing authentication inside S1.1a.

**Trigger:** exposing the api beyond localhost, or the first slice that authenticates HTTP routes
generally — whichever comes first.

### NEW — S12-N2: `subject` on `request_action` is still a claim

The REQUESTER is authenticated. The SUBJECT is not, and that part is deliberate: a host sidecar asks
on its member's behalf — beat 5 of the P0 film is exactly that shape — so requester and subject are
different parties, and only one of them is now proven.

What it permits today: any authenticated member may request an action naming **any other member** as
the subject, and the room records a decision evaluated against that member's mandate. `prince` can
cause a `CO_SIGN` card naming Jerry's principal as the required signer for an action Sol never asked
to take. The verdict is correct — the mandate evaluated is genuinely Sol's — but the room implies
Sol asked.

Severity **medium**: it misrepresents who initiated a governed action, and it cannot escalate
authority, because the subject's own mandate is what gets evaluated. Recorded at the schema rather
than left implicit.

What closes it: a delegation record saying which members a requester may act for. **Trigger: S1.3**,
which introduces the handoff object and is the first slice with a reason to express one.

### CONFIRMED — RT-005's acceptance condition survives, and is now S04-N2's

> **NO ALLOW CAUSES ANY EXTERNAL SIDE EFFECT ANYWHERE IN THE SYSTEM.**

Still true after S1.2. An `ALLOW` returns a verdict; nothing merges, deploys, posts or sends, and
nothing is written outside Playroom's own event log. Checked against this slice's own additions: the
credential path reads, the roster route reads, the stamp reads, and the two frame refusals write
nothing at all.

The sentence outlives RT-005 because it was never only RT-005's. RT-005 is fixed; the condition now
carries **S04-N2** and **S12-N2**, which are survivable for the same reason and in the same way — a
claim that cannot cause an effect outside the log is a claim about a picture, not about the world.

**S2.6, the GitHub bridge, is still the slice that ends it.** The moment an `ALLOW` causes a comment
to be posted or a branch to be pushed, an unproven mandate and an unverified subject stop being
survivable. Whoever builds S2.6 must find this line before they merge it.

---

## What S1.3 closed, and what it found

### CLOSED — S12-N2: `request_action`'s subject was a claim

A governed request is now refused unless a RECORD entitles the requester to name that subject:

| basis            | the record                                               |
| ---------------- | -------------------------------------------------------- |
| `self`           | the requester IS the subject — nothing to justify        |
| `delegated_task` | the requester created a task the subject currently holds |
| `handoff`        | the requester performed a handoff TO the subject         |

**The fix is not a rule about names, it is a record** — which is why this slice built tasks and
the handoff first and closed the finding third. A rule ("only name members you have worked with")
would have been a policy invented in the same commit that enforces it; a task and a handoff are
things the room already does, and the check reads them.

**Checked before the evaluator runs** — standing before the request (RA-007). A caller with no
standing must not learn what another member's mandate contains, and asking whether Sol's mandate
admits an action is meaningless if the caller had no right to ask under it.

**A refused request writes NOTHING to the room.** No `decision` event, deliberately: the fabric
evaluated nothing, and a BLOCK card reading _requested under Sol's mandate_ would render the very
claim being rejected. The refusal travels to the caller as a typed frame,
`subject_not_justified`, with a sentence naming what to do instead.

**And the hole was wider than the finding said.** `subject` was never checked to be a MEMBER at
all: a caller could name any string and get a decision row about it. `decision.test.ts` had a
PASSING case asserting exactly that — subject `nobody-in-particular`, verdict `NO_MANDATE` — which
means the test suite documented the hole as a feature for two slices. That case now names `prince`,
a real member who holds no mandate, which reaches the same branch through a door that exists.

The decision event records **both parties and the basis**: `subject`, `requested_by`,
`subject_basis`. The card reads _"Requested by Prince under Claude's mandate."_

### NEW — S13-N1: the delegation record is existential, not specific

The check establishes that the requester delegated work to that member **in this room**. It does
not establish that THIS request is that work, and standing never expires: a task delegated once
justifies requests under that member's mandate for as long as the room exists.

Severity **low**. It cannot escalate authority — the subject's own mandate is still what gets
evaluated, so the worst case is a request grounded in older work than the one it concerns. What
closes it: `request_action` carrying a `task_id`, so the justification is exact.

**Trigger: S2.2.** A co-signature has to reference the task it signs for anyway, so that slice is
where the tighter shape stops being extra work.

**A second face of the same looseness, found while filming:** standing MOVES WITH THE TASK. The
check asks who currently holds the work, so handing a task to Sol silently removes the requester's
standing to ask under Claude's mandate — even though Claude is the member who did the work. It is
fail-closed (a request that should be allowed is refused, never the reverse) and it is surprising:
the film's beat 6 has to come after beat 5 for exactly this reason, which is a script constraint
imposed by a rule nobody designed. Naming the task on the request fixes both faces at once.

### NEW — S13-N2: any authenticated member may connect to any room and write to it

Found while reading the handshake for this slice. The WebSocket handshake authenticates the
credential and checks that the room EXISTS — it does not check that the member is IN the room.
So an authenticated member can open a socket on any room id they can guess and post messages,
summon agents, and hand tasks around inside it.

The handoff refuses when either member is outside the room (S13-2), and `GET
/rooms/:id/members` refuses a non-member (S1.2) — so the roster rule is enforced at two places
and **not at the front door**. That is the inconsistency worth logging: the room's front door is
the widest opening left.

Severity **high**: it crosses a room boundary, which is the boundary the product sells. It is
survivable today for the reasons RT-005's acceptance names — the api is not internet-exposed,
there are three members and one deployment, and no ALLOW causes an external effect — and it is
not survivable at a pilot.

**Trigger: the first pilot, or exposing the api beyond localhost — whichever comes first.** The
fix is small (`isRoomMember` at the handshake, refused with its own close code); it is logged
rather than built because it is a fifth concern in a slice with four commits, and a membership
refusal at the handshake needs its own decision about what a non-member is allowed to learn.

### NEW — S13-N3: the browser's credential travels in the WebSocket query string

`Room.tsx` puts the token in `?token=` because a browser cannot set headers on a WebSocket
handshake. It is therefore written to any api access log that is ever enabled, and to browser
history. The comment at that line cited **S12-N2**, which is a different finding entirely — so
the concern was documented at the code and recorded nowhere, under a label that pointed at
something else.

Severity **medium**: it is a real credential in a real log line, mitigated only by there being no
access log configured and no proxy in front of the api. HTTP callers already use
`Authorization: Bearer` and the roster route refuses a token in the query string.

**Trigger: the first deployment behind a proxy or with access logging, or the first non-localhost
client.** The fix is a subprotocol-based handshake or a short-lived ticket exchanged for the
socket — both more machinery than S1.2 should have introduced, which is why the comment was right
to say so and wrong about which finding it was.

### S13-N3, re-examined in S1.3b — the constraint is real, and there are TWO faces

**Checked whether it could move, and it cannot without machinery this slice should not carry.** A
browser's `WebSocket` constructor takes a URL and a subprotocol list — there is no header argument,
by specification. So the options are:

- **A short-lived single-use ticket.** `POST /ws-ticket` authenticated by `Authorization: Bearer`,
  returning a ticket with a seconds-long TTL that the socket presents once. A leaked access-log line
  is then worthless by the time anyone reads it. **This is the correct fix** and it needs a store, an
  expiry and a consume-once rule — a small slice of its own, not a paragraph in this one.
- **Subprotocol smuggling** — `new WebSocket(url, ['playroom.token.' + token])`, so the credential
  travels in `Sec-WebSocket-Protocol` instead of the query string. Cheaper, and it moves a secret
  from one logged place to a less-logged one rather than making the secret worthless. A workaround,
  and the brief was right that saying so beats shipping it.

**And the finding has a second face that was never written down.** The token is read on the server
and handed to a client component as a prop, so it is **serialised into the page's HTML payload** —
anyone who can read the page can connect as that member. That is not the query string; it is the same
credential in a second place, and it is the honest limit of a credential without a login (S04-N2).
The ticket fix closes both faces at once, because a ticket in the HTML is worthless after seconds.

Severity stays **medium** for the same reasons: no access log is configured, no proxy sits in front
of the api, and the deployment is localhost. Both faces are now recorded, and the code comments that
described them cite this finding rather than an unrelated one.

### FIXED — S12-N3: test credentials accumulated

479 active credentials for `prince` had piled up in the test database — one per `startTestServer`,
never removed. `TestServer.close()` now deletes the credential it issued, and a test asserts the
count is unchanged across three server lifecycles. Deleted rather than revoked: revocation is the
product's rotation semantics, where the row survives as the record that the secret existed, and a
test credential is the record of nothing.

### CONFIRMED — RT-005's acceptance condition, again

> **NO ALLOW CAUSES ANY EXTERNAL SIDE EFFECT ANYWHERE IN THE SYSTEM.**

Still true after S1.3, and checked against this slice's additions rather than assumed: a task is a
row and three event types; a handoff moves an assignee and appends one event; the subject check is
two `EXISTS` queries. Nothing here reaches outside Playroom's own log, and **a handoff triggers no
turn**, so the slice does not even spend a token by itself.

It now carries S04-N2, S13-N1 and S13-N2. **S2.6 remains the slice that ends it.**

---

## RE-VERIFICATION — 27 Jul 2026, after the NUL byte

**Why this section exists.** `apps/api/src/agent.ts` carried a NUL byte from S0.5b (`fe642c0`) to
S1.3 (`38f5981`). A file containing NUL is classed as binary by ripgrep and **its contents are
skipped**, so for eight slices every content search of this repository silently excluded the
activation boundary — the most security-relevant file in it. Several exit criteria were signed off
on those searches. This is the record of re-running them against a corpus that no longer excludes
anything, and it is dated because the earlier claims were not wrong so much as **untested**.

Every grep below now lives in `tests/evidence.test.ts` and runs in CI. A claim a person re-runs by
hand is a claim that decays the moment nobody re-runs it, which is exactly what happened to the
third row.

| claim                                                     | closeout that asserted it | re-run verdict                                          |
| --------------------------------------------------------- | ------------------------- | ------------------------------------------------------- |
| no provider or model name in the room, fabric, data model | S0.4 (headline criterion) | **HELD** — zero hits                                    |
| exactly one construction site for a decision event        | M-3                       | **HELD** — `commands/requestAction.ts`                  |
| `permit` appears nowhere in code, schema, prompt, config  | ADR-006 / DOC-1           | **BROKEN** — four hits, fixed here                      |
| exactly one writer of agent turn events                   | S0.5a                     | **HELD** — `agent.ts`                                   |
| no `agent.summon` scope anywhere                          | S0.5b                     | **HELD** — zero hits                                    |
| no hardcoded member id or summon token in app code        | §21.2 / S0.5b             | **HELD in app code; the PROMPT was wrong** — fixed here |
| `mandate_label` is gone as a field                        | UI2                       | **HELD** — comments only                                |
| the decision card never says `attempted`                  | S06-N3                    | **HELD** — zero hits                                    |
| `principal:` never reaches the rendered surface           | UI2                       | **HELD** — fixture payload only, asserted in the film   |

### The one that broke: ADR-006's zero-hit `permit`

Four occurrences, all English usage: `hooks.test.ts` ("the only permitted form"),
`008_room_members.sql` ("THE SHAPE THE DATA PERMITS"), and two in `conformance.ts` ("the contract
permits", "what is NOT permitted").

ADR-006 refused this exception in advance, in writing: _"English usage is not the term. A sentence
using 'permit' as a verb is REWORDED rather than left, because the exit criterion is a zero-hit grep
and a grep cannot distinguish the two. Reworded, not excepted."_ So these are violations of the
ADR's own rule, not a scoping quibble.

**Two of the four predate the ADR** (`conformance.ts` is S0.4, `hooks.test.ts` is S-UI), which means
**the claim was false at the moment it was written.** The third arrived after it (migration 008,
S1.1b). All four are reworded in this commit.

**The NUL byte is not the excuse for this one.** None of those files is `agent.ts`. The grep was run
once, at the commit that made the claim, and never again — which is the failure this section's test
file exists to end.

### Two claims that HELD but could not have been evidence

Both have their answer inside the file the search skipped, so the search that "confirmed" them could
not have seen it:

- **one writer of agent turn events.** The only caller of `appendAgentEvent` is in `agent.ts`. A
  ripgrep for callers would have found none there — reporting zero callers for a function with one,
  which reads as a stronger result than the truth.
- **no hardcoded summon token.** `agent.ts` HELD a hardcoded `@claude` and a literal member id
  until S0.5b removed them. A grep that skips the file passes identically before and after the fix,
  so §21.2's exit criterion was verified by a check that could not have failed.

Both are true today, and now they are true **with evidence**.

### The prompt named one member to all of them

`prompts/room-agent.v1.md` said _"You are summoned by name (for example, `@claude`)"_ — one shared
prompt, so **Sol was told another member's tag as its own example.** Routing was never affected
(summon tokens come from the room's membership), which is why §21.2's claim was still true and why
no test caught it. It is a different defect from the one that claim covers, and it is fixed rather
than excepted: the line now says the room addresses you with an `@` and your own display name.

### The CRLF story from S13-1 was wrong, and this is the correction

S13-1's message called the CRLF rewrite an independent defect — _"a 546-line diff for a 29-line
change"_. Re-checked against git: `.gitattributes` sets `* text=auto eol=lf`, so git normalises CRLF
on commit and reports **no diff at all** for a working-tree file that has it (`.gitignore` is in that
state right now and `git status` is clean).

The whole-file diff happened because **`text=auto` stops normalising a file it detects as binary**,
and a NUL byte makes it do exactly that. So the CRLF was a _symptom_ of the NUL, not a second
defect: the byte removed the file from ripgrep's corpus **and** from git's line-ending handling. The
guard is built accordingly — the NUL check is the primary assertion, and the CRLF check is a backstop
against a file explicitly marked `-text`.

### Housekeeping, same shape as S12-N3

`decision.test.ts` created five rooms per run and deleted none, from S0.3 onward — 20 rooms by the
end of S1.3, and 20 tasks once S1.3 gave every delegated task a row. Fixed and measured: 0 rooms and
0 tasks remain after a run.

---

## S1.3b — the front door, and the third oracle

### FIXED — S13-N2: the handshake now checks membership

An authenticated member could open a socket on any room id they could guess and write into it. The
roster rule was enforced on the handoff and on the roster read and **not at the front door**, which
made it the widest thing an authenticated member could assert with no record behind it.

**A room you are not in is a room that does not exist** — one refusal for both, same close code 4404,
same typed frame, and the frames are asserted byte-identical once the room id is normalised out. The
log carries `reason: no_room | not_in_room` and the member id, server-side, where the caller cannot
read it.

**One query, not two.** `roomAccess` asks existence and membership in a single round trip, because
`getRoom` followed by `isRoomMember` would have cost one query for a missing room and two for a room
the caller cannot see — the oracle rebuilt out of latency after being closed in the response. The
roster route was consolidated onto the same helper for the same reason.

A member removed from a room loses the front door on their next connection, with no restart: the
check reads the table, and membership has been data since S1.1b.

### FIXED — S12-N1, and a third oracle nobody had logged

`GET /rooms/:id` now requires `Authorization: Bearer` and membership, refusing exactly as a
non-existent room does. A token in the query string is refused here, as on the roster route.

**And `POST /rooms` was worse than either.** It returned the room ROW, and it is idempotent on id —
so an unauthenticated caller who guessed `jerrys-review` got back **its title and its creation
date**. Not an existence oracle: a content one, and it was never written down. It now returns
`{ id }` only, so a collision and a fresh create are indistinguishable. Closing it needed no
credential and deliberately does not use one: creation stays unauthenticated, which is **RT-002,
still open on its own terms**.

The silence is asserted END TO END rather than route by route — the socket, both HTTP reads and the
create route, in one test — because the ruling's condition is that an oracle anywhere undoes silence
everywhere.

### STILL OPEN — RT-002, now the last unauthenticated write

Anyone who can reach the api can still CREATE a room. As of this slice it leaks nothing, and it is
the only route left that changes state without a credential. Its acceptance was "until S1.1", which
has landed — so it is overdue rather than deferred. It is small: the browser's create form is the
only client that would need a credential threaded through it, which is shell-slice work.

**Trigger: the first pilot, or the first non-localhost exposure — whichever comes first.**

---

## S1.3c — the ticket, and an acceptance that expired quietly

### FIXED — RT-002: creating a room required no credential

`POST /rooms` was open to anyone who could reach the api, from S0.3 until now. The creator is an
authenticated member, and `createRoom` enrols them **in the same transaction that creates the
room** — the first transaction in this codebase, and it earns it: after S1.3b's front door, a room
with no members is a room NOBODY can open, including the person who just made it, with no product
surface to repair it from.

The creator's row is written explicitly rather than left as a consequence of "every room gets every
member". Redundant today and not tomorrow: the day rooms stop enrolling everyone, the line keeping
a creator out of their own room would be a deletion nobody notices.

**THE ACCEPTANCE EXPIRED FIVE SLICES BEFORE ANYONE ACTED ON IT, and that is the finding worth
recording.** RT-002 was accepted "until S1.1", on a sound argument: §1's invite-only roster cannot
be enforced by a route guard when nothing knows who is asking. S1.1a, S1.1b and S1.1c landed
principals, members and rooms-with-members; S1.2 landed identity. Each of those closings made
RT-002's condition false, and none of them was the slice that owned RT-002, so nobody looked.

**An acceptance with a named trigger still needs someone to check the trigger.** This log records
dispositions and re-reads them only when the finding comes up again — which, for a finding nobody
is working on, is never. The cheapest fix is a habit rather than a mechanism: **when a slice closes,
re-read the acceptances whose trigger it just satisfied.** S1.3b's re-verification section exists
because greps decay the same way, and this is the same failure in a different column.

### FIXED — S13-N3, both faces: the socket takes a single-use ticket

A browser cannot set headers on a WebSocket handshake, so the credential travelled in the query
string, and the page handed the same credential to a client component so it could put it there.

`POST /ws-ticket` behind Bearer mints a ticket worth **one socket, one member, one room, thirty
seconds**, hashed at rest. Consumption is an atomic UPDATE — the property a signed ticket cannot
have, and the reason the store is rows rather than a signature. Two concurrent handshakes on one
ticket: exactly one `hello`, exactly one refusal.

The issuing route asks **no authorisation question** — checking membership there would answer "does
that room exist and am I in it", the oracle S1.3b closed, rebuilt one route over. The handshake
stays the single place that decides.

Fabricated, consumed, expired and wrong-room are **one refusal to the caller** and four reasons in
the log. There is no `token` fallback on the socket: a valid credential presented the old way is
refused, because a fallback is the old path still open.

**What it does not fix, and the reason it is still worth doing.** There is no login, so the web tier
mints a ticket for anyone who can reach it. The credential moved from every reader of the page's
HTML into one server process; `which human is this` is unchanged and is S04-N2. A ticket narrows
EXPOSURE, not authority.

### NEW — S13c-N1: two tests failed once, under load, and have not reproduced

`apps/api/test/idempotent.test.ts` and `apps/api/test/agent-error.test.ts` failed together in a
single standalone run during S1.3b, while the production stack was serving the film against the same
Neon compute. They passed on immediate re-run, in the pre-commit hook, in isolation at three commits,
and in CI.

**Reproduction attempted and failed** — three consecutive runs of the pair with the production stack
up, all green. Not pursued further: the owner's instruction was that the ledger entry matters more
than the reproduction, and an unreproducible failure investigated by staring at it is a session
spent on a hypothesis.

**Symptoms:** both tests are timing-sensitive in the same way. `idempotent` races two sends and
asserts one row; `agent-error` waits for a failed turn to be written and fanned out. Both assert on
something arriving within a window rather than on a state that settles.

**Hypothesis, unconfirmed:** the api under test and the production stack share one Neon compute
endpoint (different databases, same instance), so a heavy concurrent load can stretch a query past
a test's patience. That would make it an artefact of this machine rather than a defect in the
product — which is a comfortable conclusion, and the reason it is written down as a hypothesis
rather than a finding closed.

**Trigger: the first CI failure of either test.** At that point it gets a session, not a retry
button. A suite that fails one run in N erodes exactly the signal eleven slices have been spent
building — the value of a green run is that it means something, and a flaky test converts every
future failure into a coin toss about whether to look.

### CORRECTION — S13b-3 claimed a claims-sheet row it did not add

S13b-3's message says it added a do-not-say row for _"the room is private" / "only Prince can see
it"_. It did not: the edit was a string replacement with no assertion behind it, the anchor had been
reflowed, and the replacement silently did nothing. The commit's other claims-sheet changes landed;
that one did not, and the message was written as though it had.

Added in S13c-3, with the reason updated — the sentence is tempting for the same reason and the
mechanism behind the refusal has changed since. **The general fault is mine and it is mechanical:**
a `replace` without an assert is a no-op that reports success. Every scripted edit in this slice
asserts its anchor, and the two that failed to match said so loudly instead of passing quietly.

## S1.5 — context scopes, and the assertion that was checking itself

### FIXED IN THE SAME COMMIT — S15-N1: the §7.1 invariant could not see a mislabelled part

`assembleContext` labels each part of an agent's context window with its provenance, and
`windowFor` refuses to hand a window to a provider unless every private part belongs to the
principal being summoned. The first version derived BOTH sides of that comparison from the same
value: the part was labelled `input.principalId` and then checked against `input.principalId`.

**Found by mutation, not by reading.** One line of `assembly.ts` was changed to open a literal
foreign store — `withPrincipalStore(pool, 'principal:jerry', …)` while acting for
`principal:prince`. Four tests in `context-isolation.test.ts` went red on the TEXT of Jerry's note
appearing in Prince's window. **The invariant stayed silent**, because the part carried Jerry's rows
under Prince's label and the assertion had nothing to compare it against but itself.

That is the wrong way round. The text assertions run in CI; the invariant is what runs on every
turn in production, and it was the half that missed.

**Closed** by labelling the part from `store.principal` — the principal the transaction was actually
scoped to — so the comparison is between two independently-derived values. Re-running the same
mutation now throws `AssemblyInvariantError: §7.1 assembly invariant violated: 1 foreign principal
store(s) in the window (member acts for principal:prince)` and takes five tests with it.

**Severity as it stood: low, and only because nothing had a reason to open the wrong store yet.** No
released code path passed a principal other than the stamped one; the bug was in the control rather
than in the behaviour, which is the failure mode this project keeps finding — a field that looks like
authority, an assertion that looks like a check.

**The general lesson, and it now applies to every invariant in this repo:** an assertion whose
expected value and observed value come from the same expression cannot fail. Mutate the line the
control is about and watch WHICH assertion catches it. If only the tests notice, the runtime control
is decoration.

### MEASURED — the database, not the policy, is what isolates

Recorded because the first attempt at migration 015 shipped nothing and read correctly.

```
neondb_owner                                     superuser: false  BYPASSRLS: true
  policy ENABLEd + FORCEd, read as prince     →  BOTH rows visible
playroom_context (via SET LOCAL ROLE)            BYPASSRLS: false
  SELECT … WHERE principal_id='principal:jerry'  →  0 rows
  same query as neondb_owner                     →  1 row: "What Jerry needs before trusting…"
  setting unset                                  →  0 rows
  after COMMIT                                   →  current_user = neondb_owner
```

The third line is the falsification: the zero is a refusal and not an absence. A test asserting only
the zero would have passed against an empty table, a typo'd principal id, and a policy that does
nothing.

**Still true and worth stating: a superuser bypasses this.** CI's postgres user is one, and the
isolation holds there only because `SET LOCAL ROLE` drops to a role that cannot bypass — which the
tests assert rather than assume. Anyone with the owner credential can read every store directly.
This isolates PRINCIPALS FROM EACH OTHER through the application; it does not isolate either of them
from the database owner, and nothing in this design claims it does.

### CLOSED FOR ONE PATH — RA-005: a promoted span cannot activate a summon

S1.5 landed §7.2 promotion, which is content promotion, so RA-005's criterion applied at this commit
rather than at S1.7 as scheduled. It is satisfied **for the promotion path**, by construction:

A promotion is a `context.promoted` event, not a `message`. Barrier 1's allowlist reads text from
`message` and returns null for everything else, so a promoted `@sol` rules `NOT_ROOM_CONTENT` and
summons nobody. **Nothing in `agent.ts` changed.** The allowlist was written in S0.5b so that a new
event type would be inert until somebody deliberately admitted it, and that is exactly what it did
eleven slices later — the single best argument for allowlists over denylists this project has
produced.

Asserted with the payload that makes it worth asserting: a private note containing a resolvable token
for **another principal's agent**, promoted verbatim, run through the real `summonRuling`. It is
refused before token resolution even happens, so the refusal does not depend on the roster.

**RT-004'S ACCEPTED GAP IS NOT CLOSED, and the must-fail test still passes.** Its subject is
`message`: a member pasting quoted text still summons whoever it names, because `message.payload` is
still one flat string with no span provenance. Promotion added an inert path; it did not make the
other path safe. The pinned test now carries the full reasoning inline, because a passing must-fail
test whose trigger has fired is exactly the situation in which someone edits the expectation and
moves on. **Trigger unchanged: S1.7, when wholesale import lands.**

**What RA-005 itself got wrong,** recorded because the amendment is a document that claimed
something: it assumed promoted spans would arrive inside member-authored messages, and therefore that
closing the gap needed span provenance inside `MessageEvent`. It did not. Promotion did not have to be
a message, and the cheapest correct answer was to not make it one.

### NOTED — an agent cannot promote its own principal's context, and this is a real restriction

`promoteContent` refuses an agent approver (`not_a_human`). The reason is not tidiness: an agent reads
its own principal's store on every turn (§7.1), so an agent that could also promote could be talked
into publishing that store — barrier 1's injection path with a private store as the payload. Consent
for a disclosure is a human act or it is not consent.

**The cost, stated:** an agent that legitimately needs to share something from its principal's notes
cannot do it, and must ask. That is a worse product and a better boundary, and it is the owner's call
to revisit. If it is revisited, the thing to add is a co-signed promotion (§12.1's shape), not an
`allow_agents` flag.

## S-LIVE — what a stranger can reach

Deploy was taken as a NO-GO on the owner's own rule (no hosting platform is authenticated on this
machine; a first two-service deploy with WebSockets estimated at 2–3.5 hours against a ~2 hour line).
So nothing below has been exercised over the public internet. **Everything in this section is about
exposure that now EXISTS IN THE CODE and becomes live the moment a URL does.**

### ACCEPTED WITH TRIGGER — what a demo credential reaches

A room code redeems into a guest seat and issues a named, expiring member credential. What the holder
can then do:

**CAN:** connect to the ONE room the code named; read that room's transcript and roster; send
messages; summon the agents enrolled in that room, including other people's; raise and lower
interrupts within the mandate's `interrupts_per_day`; spend provider budget by summoning, up to the
daily ceiling.

**CANNOT:** reach any other room — the handshake refuses with byte-identical output to a room that
does not exist (S1.3b, asserted for a redeemed guest specifically); read any principal's private
context store, including their own seat's, because nothing exposes one over the wire; promote content;
act as a non-guest principal, because `mintRoomCode` refuses a non-guest seat — the one refusal in
that file whose absence would be a disclosure rather than an inconvenience.

**WORTH SAYING PLAINLY:** a guest CAN summon another person's agent, and that agent's turn is stamped
to ITS principal and spends against the shared ceiling. That is the product working as designed — this
is a shared room — but it means one tester can spend the day's budget through somebody else's agent.
**Trigger: the first tester who does it, deliberately or not.** The fix is S2.7's per-member budgets,
not a rule here.

**Trigger for the entry as a whole:** deployment to a public URL, at which point the gap below stops
being theoretical.

### NEW — SLIVE-N1: `POST /redeem` is unauthenticated and unthrottled

The only unauthenticated write in the api, and deliberately so — it is the endpoint whose entire job is
to give a credential to someone who has none. RT-002 closed the previous one in S1.3c; this opens a new
one with different bounds.

**The gap:** four characters from a 30-character alphabet is ~810,000 possibilities, and nothing slows
a script down. On a public URL that is a weekend of guessing for one seat.

**Why it survives today and would not survive tomorrow:** a successful guess costs the attacker a seat
a real person then visibly cannot claim (single-use, and the operator sees it in `--list`); only two
seats exist; and this is not internet-exposed. None of those three survives a deployment with more
seats.

**Not half-solved, on purpose.** The right answer is a rate limit keyed on IP plus a longer code, and
both are cheap — they are omitted because a limiter with no deployment to protect is untested code
sitting in the path that lets testers in. **Trigger: the first deployment to a public URL, before any
code is sent to anyone.**

### RE-CHECKED — RT-005's condition holds, and it was NOT checked off localhost

The condition: **no ALLOW verdict causes any external side effect.** Re-read against the code as of
S-LIVE and it holds, for the same structural reason as before: nothing executes a governed action.
`pr.merge` and `deploy` appear in mandates and in the decision path, and no executor exists for
either, so an ALLOW is a record that permission would have been granted and nothing more.

**What this slice adds to the question is new and worth stating.** A guest summoning an agent DOES
cause an external side effect — an HTTP request to a provider, and a charge. That is not an ALLOW
verdict causing it (a summon is not a governed action; `agent.turn` never has been), so RT-005's
condition is untouched as written. But the sentence now does less work than it sounds like it does,
because the room can spend money with no verdict involved at all. The spend ceiling is the control
there, not the evaluator.

**THE EXIT CRITERION IS NOT MET.** The brief asked for RT-005 re-checked _off localhost_ — the first
test of that line away from this machine. Deploy did not happen, so it was not tested there. Recorded
as unmet rather than as satisfied by a code read.

### NOTED — S15-N2 does not exist in this ledger, so its reasoning cannot be re-read

The brief asks that S15-N2's inference channel be re-read now that external callers exist. **There is
no S15-N2 in this file.** S1.5 logged exactly one new finding — S15-N1, the §7.1 invariant that
compared a value against itself — plus one measurement and two corrections. I am not going to invent
an acceptance argument in order to re-examine it.

**What can be done is to name the inference channels S1.5 actually created and check each against
external callers:**

1. **The assembly telemetry line.** `ctx=common:N+own:M+task:K` on every turn reveals whether a
   member's principal holds private notes and roughly how many. It is a SERVER LOG line, so an
   external caller cannot read it — the channel is real and the audience is me.
2. **Promotion existence.** A `context.promoted` event tells every member of the room that somebody
   has private context and chose to share part of it. Intended: a disclosure that concealed the fact
   it was a disclosure would defeat the record.
3. **Refusal wording on the store.** `withPrincipalStore` returns zero rows for a foreign principal
   rather than erroring, so `promoteContent` refuses a foreign item as `no_such_item` — the honest
   reason, since from inside Prince's scope Jerry's item does not exist. No tell between "not there"
   and "not yours".

If S15-N2 names something else it needs writing down before it can be assessed. **Owner's call, and it
is a question rather than a finding.**

### NEW — SLIVE-N2: bring-your-own provider keys, the settings surface and the storage question

Out of this slice by ruling. Logged because the shape is already visible and the design decision is the
hard part, not the code.

**The settings surface does not exist at all.** There is no per-member or per-principal configuration
surface anywhere in the product: adapters are a config file, mandates are files, and everything else is
a record with no editing path. A BYO key needs the first one ever built, and a settings page able to
edit an authority-adjacent field is a new attack surface the day it ships.

**The storage question is the harder half.** A provider key is a long-lived bearer secret belonging to a
person, and this codebase holds exactly one class of secret at rest — `member_credentials.token_hash`,
which is a HASH and works precisely because nothing ever needs to read it back. A provider key must be
read on every turn, so it cannot be hashed. That leaves an encryption key in the environment (and the
question of where THAT lives), a secrets manager, or never storing it and asking per session. All three
are real answers and none is a small change.

**Until then every turn spends MY key**, which is why the daily ceiling exists and why the guest
adapters run at half the output cap. **Trigger: the first tester who asks to use their own account, or
the first month the ceiling costs real money.**

### NOTED — the log is replayable only while every row in it is a valid event

Found by inserting a partial `agent.turn.completed` payload as a test fixture: the room's replay threw
inside `rowToServerEvent` and the client received NOTHING. No error on screen — just a room that would
not open, with a connection badge cycling forever.

**The general form is a deployment constraint rather than a test problem.** `ServerEvent` is a strict
discriminated union, so a server meeting an event type it does not know cannot parse it, and
`eventsAfter` maps over every row in the room. Deploy an older server against a database holding a
newer event type and **every room containing one becomes unreadable** — not degraded, empty.

S1.5 added `context.promoted`; this slice added nothing to the union. So today's exposure is purely
ordering: the server must be updated before any row of a new type is written, and a rollback past an
event type is unsafe once one exists. **Not fixed here, and the fix is a decision rather than a patch**
— skipping unparseable rows trades a hard failure for a silent gap in the transcript, which weakens
"the transcript is the record" and is therefore the owner's call. **Trigger: the first deployment, or
the first rollback.**
