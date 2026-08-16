# ═══ AUDIT-FABLE — THE CONTRACT MAP ═══

**ROLE:** You are the implementation agent for Playroom, executing AUDIT-FABLE — establishing, from
the repository, which of the Fable report's proposed contracts already exist under different names.
Owner: Prince. **No code changes. Two docs commits, then stop.**

**RUNNING THIS AS A LOOP PAYLOAD:** if a standing order is driving this, read the multi-cycle section
at the end **first**. A cycle's memory is eight turns. The audit document on disk is the only thing
that remembers what earlier cycles did.

---

## THE FRAMING

A consolidated architecture report dated 13 August 2026 proposes a terminology freeze over eighteen
terms — Worker, Room, Door, Fabric, Mandate, Delegation Chain, Harbor, Local Node, Action Gateway,
Execution Gate, Presence, Work Trace, Work History, Artifact, Handoff, Approval, Experience Record,
Worker Directory. The report was written **without access to this codebase**. Its own §19 asks, as its
first question, which of these contracts already exist here under other names. Nobody has answered it.

**That question must be answered before any freeze, not after.** A vocabulary frozen against a
codebase nobody read is not a freeze — it is a second dialect, and the cost of a rename at this commit
count has already been ruled prohibitive once (ADR-006, permit→mandate).

**The anti-goal, stated first: this slice renames nothing and builds nothing.** It produces a map and
a findings list. If you find yourself editing a symbol, you have left the slice. The temptation will
be to "just fix" a collision you find — do not. A collision is information; its resolution is Prince's
ruling.

**Second anti-goal: do not assert a contract exists because a similar word appears.** A term matching
is not a contract matching. `room` in the report means a governed shared execution context with
admission control; if this repo's room has no admission boundary, the correct answer is PARTIAL with
the gap named, not MATCH.

---

## PHASE 0 — DISCOVERY (no commits)

Everything in this section is a question. **Do not assume any repo fact stated in this brief;
establish it.**

1. **The report must be in the tree before anything else.** It is the input to this audit and you have
   never seen it. Confirm `docs/reports/2026-08-13-fable-consolidated-report.md` exists and contains
   §15 (the eighteen terms to freeze) and §17 (the twelve invariants). **If it is absent, STOP and say
   so** — Prince places the file; you commit it. Do not reconstruct the report's contents from this
   brief, from memory, or from the architecture bible. If §15 lists a different number of terms than
   eighteen, or §17 a different number than twelve, **report the real counts and use those** — this
   brief's numbers are secondhand and yours are firsthand.
2. Report the head commit, whether the tree is clean, whether `pnpm verify` is green, and the CI state
   on the pushed head. **STOP if the tree is dirty** — an audit against an unrecorded working state
   records nothing.
3. Report the actual test count and file count. Every later count in this slice reports its
   denominator: how many things were searched, and how many existed.
4. Establish the repo's own vocabulary before comparing anything. List the identity, authority and
   event concepts that actually appear as types, tables, event kinds or directory names — not what you
   remember them being called.
5. Report which of these exist as a **type or schema** versus only as prose in docs: member,
   principal, host, route, mandate, scope, protected_actions, co_sign, decision, order, interrupt,
   promotion, summon, adapter, claim.

---

## PHASE 1 — THE MAP (no commits yet)

For each of the eighteen report terms, produce one row:

| Report term | Repo name | Verdict | Evidence | Gap |

**Verdict is one of exactly four:**

- **MATCH** — the contract exists with the same meaning. Cite the file and symbol.
- **PARTIAL** — something exists that covers part of it. Name precisely what is missing.
- **ABSENT** — nothing in the repo does this. This is a legitimate and expected answer for several
  terms; do not manufacture a match.
- **COLLISION** — the repo already uses this word for a _different_ thing.

**Evidence must be a file path and symbol, or the word ABSENT.** A row citing a document rather than
code is a documentation claim, not an implementation claim, and must be labelled as such.

**Three collisions are suspected and must be confirmed or refuted from the code, not accepted from
this brief:**

- **Door** — the report means an admission boundary into a Room. Check what this repo's authenticated
  ingress (the external caller path) is called in code and comments.
- **Fabric** — the report scopes Fabric to context visibility only, placing it _beside_ authority.
  Check whether this repo's usage scopes it to the whole enforcement plane instead.
- **Worker** — the report's persistent AI identity. Check what this repo's equivalent is and how many
  concepts it separates that the report's single term would collapse.

---

## PHASE 2 — THE INVARIANT LEDGER (no commits yet)

The report lists twelve architectural invariants in its §17. For each, answer from the repo with one
of:

- **ASSERTED BY TEST** — name the test and what mechanism it asserts. Per standing discipline, a test
  that asserts an outcome did not occur does not count; it must assert _which rule fired_.
- **TRUE BY CONSTRUCTION** — name the construction. Enforce-by-absence counts; say what is absent.
- **CLAIMED, UNASSERTED** — believed true, nothing proves it.
- **FALSE TODAY** — the repo does not currently hold this.

This is the highest-value output of the slice. Report the count in each bucket with the denominator
(twelve).

---

## PHASE 3 — TWO TARGETED QUESTIONS (no commits yet)

1. **Temporal policy.** Can the evaluator today express a condition over prior events — "this action
   is refused unless event X occurred earlier in this room"? Answer from the evaluator's actual
   signature and inputs. If it cannot, state precisely what it would need: does the evaluator receive
   the event log, a projection, or only the request?
2. **Placement and continuity.** Does anything in the repo make a decision about _where_ a member's
   work executes, or hold durable task state across a restart? If nothing does, say ABSENT plainly
   rather than mapping it onto something adjacent.

---

## PHASE 4 — WRITE IT DOWN (two commits: `AUDITFABLE-1`, `AUDITFABLE-2`)

`AUDITFABLE-1` commits the report itself at `docs/reports/2026-08-13-fable-consolidated-report.md`,
unedited. The input to an audit belongs in the tree the audit ran against; otherwise the map cites a
document nobody can check.

`AUDITFABLE-2` writes `docs/audits/2026-08-fable-contract-map.md` containing: the Phase 0 state, the
map table, the invariant ledger with counts and denominators, the two Phase 3 answers, the findings
list, and the ruling list.

**Findings and rulings are separate lists and must not be merged.**

- A **finding** is something wrong or missing in the repo. Each gets an ID (`AF-N1`, `AF-N2`, …) and a
  **trigger** — the event that makes someone act on it. A deferral with no trigger is a deferral
  forever.
- A **ruling** is a decision only Prince can make — every COLLISION row, and any proposed rename.
  State the options and the cost of each; do not recommend by default, and do not act on any of them.

Commit the document. Do not touch any other file.

---

## STANDING RULES

- Single agent, serial. No `--no-verify`.
- Phase 0 is genuine discovery. Nothing in this brief about the repo is a fact until you have
  confirmed it.
- Every count reports its denominator.
- Nothing may be claimed that isn't true. If the closeout says a row was written, the row is in the
  file.
- Log findings; do not fix them inside this slice.
- Rename nothing. Build nothing. Delete nothing.

## EXIT CRITERIA

- [ ] Eighteen rows, each with a verdict and file-level evidence or ABSENT.
- [ ] Twelve invariants bucketed, with counts and denominator.
- [ ] Both Phase 3 questions answered from code, not from documents.
- [ ] Every COLLISION appears in the ruling list, not the findings list.
- [ ] Exactly two commits; tree clean; verify green; CI green on the pushed head.
- [ ] No symbol renamed anywhere in the repo.

---

## IF THIS RUNS ACROSS MULTIPLE CYCLES

A cycle sees eight prior turns (`RECENT_TURNS_IN_CONTEXT = 8`), and nothing summarises or compresses
them. There are no artifacts. Turn nine cannot see turn one.

**So the document on disk is the memory, and nothing else is.** This changes how you work, not what
you produce:

- **Write to the file every cycle, not at the end.** A section that exists only in a turn you wrote is
  gone in eight cycles. A section committed to `docs/audits/2026-08-fable-contract-map.md` is still
  there.
- **Start every cycle by reading that file**, and treat it as the record of what is done. Do not
  re-derive a row that already has a verdict and evidence. If a row is present and cited, it is
  finished.
- **Keep a progress block at the top of the document** — which terms are mapped, which invariants are
  bucketed, what is left — so the next cycle orients from the file rather than from the conversation.
- **Post a closeout as a message each cycle.** Messages enter the room window and the rolling summary;
  agent turns do not. A closeout message is the only cycle output that survives in the room itself.
- **The commit structure above is the final shape, not a per-cycle shape.** Intermediate cycles may
  commit work in progress; say so in the commit message. The exit criteria are met when the document
  is complete, not when a particular commit count is reached.

**ST-N1 applies:** an order has no way to say it is finished. When the document meets every exit
criterion, say so plainly in the closeout and raise a hand. The order stops because Prince stops it,
not because the work ran out of budget.

## REPORT BACK

The three suspected collisions: confirmed, refuted, or something stranger. The invariant bucket
counts. Whether the evaluator can see history at all.

Then the successor question, answered from the code: **the goal after this slice is an unattended
brief-and-closeout loop — a standing order that summons a hosted member to write the next brief, a
connected member that pulls it and works, and a raised hand that reaches Prince's phone when a
decision is needed.** From the repo, name the single missing piece that most blocks that loop, and say
whether the room-level briefing (a promotion pinned to the room, inherited by every summoned member)
requires a new ServerEvent type. New event types must join the ServerEvent union — an older server
meeting a newer event makes rooms unreadable on replay — so name it explicitly if one is needed.
