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

| id     | date        | severity | discovered by                     | principle violated                                                                                  | disposition             | commit    |
| ------ | ----------- | -------- | --------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------- | --------- |
| RT-001 | 25 Jul 2026 | high     | found during A4 automated capture | deny-by-default requires an explicit refusal; an unaudited failed write is worse than a delayed one | fixed                   | `161aa16` |
| RT-002 | 25 Jul 2026 | medium   | noticed while closing RT-001      | rooms are invite-only by membership (§1); an unauthenticated create has no principal to bind to     | accepted until **S1.1** | —         |

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
