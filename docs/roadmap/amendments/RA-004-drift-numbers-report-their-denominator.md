# RA-004 — Roadmap amendment: every drift number reports its denominator

**Amends:** Bible §19 (drift queries) and §20 (testing and quality gates) · **Status:** Logged, adopted in S0.5b's query · **Raised by:** S0.5a/S0.5b

## The gap

§19 makes the unprompted-message count a nightly contract and requires it to be **exactly
zero**. §20 requires gates to assert mechanisms rather than outcomes. Neither says what a
zero has to prove, and three times in one week an instrument in this repo read green while
proving nothing:

1. **RT-001** — zero rows written, because the write died on a foreign key rather than
   being refused. The count was right and the meaning was wrong.
2. **RT-003** — zero unprompted turns, while two agent turns fired from one human action.
   Both were honestly human-rooted, so the number could not see them.
3. **S0.5a's first live run** — a clean zero over a log that contained **no agent turns at
   all**. The query parsed. That is all it demonstrated.

Each was a different defect and they share one shape: **a numerator of zero over an
unstated denominator.** The three cases are not a run of bad luck, they are what happens
when a count is published without the population it counted over.

This matters more for §19 than anywhere else, because §19's queries run **nightly and
unattended, reviewed weekly**. An assertion that fails loudly in CI gets fixed in an hour;
a vacuous zero on a dashboard nobody has reason to doubt survives for months, and it
survives precisely while it is most needed — after a migration, a backfill, or a deploy
that quietly stopped writing the rows being counted.

## The amendment

**§19 gains a rule.** Every drift query publishes, alongside each number, **the size of
the population it examined**. A query that cannot state its denominator is not reportable.
A zero over an empty population is labelled as such at the point of publication — not
inferred later by whoever reads it.

**§20's row for drift/latency gates gains the same requirement**, stated as the general
form of its existing assert-the-mechanism rule: a gate asserts the mechanism, and a
measurement states its population. "No failures observed" and "nothing was looked at" must
not be the same output.

**It generalises beyond §19's unprompted count.** The same rule applies to every number in
that paragraph — BLOCK and CO_SIGN rates per member, screening false-positive rate, cost
per summon, interrupt downgrade rate, projection divergence. A BLOCK rate of 0% over zero
evaluated actions is the same lie in a different column, and it is more likely, because a
screening service that has stopped receiving traffic looks exactly like one refusing
nothing.

## Already adopted, as the reference implementation

`scripts/sql/summon-drift.sql` reports `turn_rows_examined` and `summons_examined` next to
its two zero-counts, and `scripts/check-summon-drift.ts` prints
`NOTE: no agent turns in this log. Zero here is vacuous.` when the denominator is zero. The
test asserts the denominator is non-zero **before** asserting the counts are zero, so a
suite cannot pass by examining nothing.

The column is the example, **not** the rule. What generalises is the requirement to publish
a denominator; the specific columns belong to each query.

## Why an amendment rather than a convention

A convention would hold for as long as the person who learned it is the person writing the
query. §19's queries will be written by whoever builds S2.9's nightly job, against a
document that currently tells them a zero is sufficient. The document is where it has to
change.

**Precondition:** none. **Blocks:** nothing. **Binds:** S2.9, when the nightly job is
built, and any new drift number added before then.
