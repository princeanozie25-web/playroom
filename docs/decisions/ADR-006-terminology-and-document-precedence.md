# ADR-006 — Terminology ruling (`mandate`) and document precedence

**Status:** Accepted · **Refs:** Bible §0 (precedence table, terminology ruling), Bible §9, Bible §26 · Roadmap §5, §11 · **Date:** 2026-07-26

Two rulings are recorded together because they are the same problem: two documents
describing one system, disagreeing, with no rule for which one loses.

## Context

The repository was being built against two documents that overlap heavily and conflict
in two ways.

**Naming.** Roadmap v1.0 says `permit`, prefix `pmt_`, directory `permits/`. Bible v1.0
and the pitch deck say **mandate**. Both terms had already reached the repository's
vocabulary: the deck's demonstration chip reads _mandate: review-only_, while the
roadmap's §5 schema and §10 repository layout say `permit`.

**Precedence.** On 25 July a brief cited "§7 budgets" meaning the Bible's §7 while a
closeout cited "§7" meaning the roadmap's §7 — latency budgets in one document, context
boundaries in the other. Both citations were correct against their own source and the
disagreement was invisible until someone compared them. That is not a
misunderstanding to be corrected; it is a defect in how the documents are referenced.

## Decision

**1. `mandate`, not `permit`.** Prefix `mnd_`, directory `mandates/`, field
`effective_mandate_hash`, reason codes and the decision contract per Bible §9. The word
`permit` appears nowhere in code, schema, prompt or config after this commit.

Two exceptions, both deliberate:

- **Historical documents keep their original wording.** `docs/roadmap/` and the Bible's
  own account of the ruling both contain `permit`, because a superseded document that has
  been silently edited is no longer evidence of what was decided.
- **English usage is not the term.** A sentence using "permit" as a verb is reworded
  rather than left, because the exit criterion is a zero-hit grep and a grep cannot
  distinguish the two. Reworded, not excepted.

**2. The Bible is canonical; the roadmap is retained, not deleted.** Bible v1.1 supersedes
Roadmap v1.0. Where they disagree, the Bible wins. **Where the Bible is silent, the
roadmap's operational detail still stands** — it is not void, it is subordinate. The
authoritative statement of which document owns which domain is the Bible's own precedence
table (Bible §0, "Precedence by domain"); it is referenced here rather than restated,
because a copy would drift and then there would be three documents to reconcile instead
of two.

The roadmap carries a superseded header pointing at the Bible and naming what it retains.
Its body is unchanged. RA-001 continues to amend it.

**3. Citations name their document.** `Bible §11`, `Roadmap §7` — never a bare `§7`.
Recorded in CONTRIBUTING so it binds briefs and closeouts, not only source comments.

## Consequences

**Easier.** A section reference resolves to exactly one paragraph. A future session
reading either document finds the precedence rule inside three lines of the title. The
rename is cheap now — the audit found `permit` in two places, neither of them a
`permits/` directory, because that directory was never created.

**Harder.** Two documents must be consulted where one would do, and the Bible's silence
is now load-bearing: "the Bible does not mention it, so the roadmap governs" is a real
inference someone will make, and it is only sound while the precedence table is accurate.

**Foreclosed.** Editing the roadmap to agree with the Bible. The moment that happens the
precedence table describes a document that no longer exists, and the provenance column —
which is how a reviewer checks that a rejected claim has not quietly returned (Bible §25)
— stops being verifiable.

**Deliberately not done here.** Bible §21.2 schedules the `permit` → `mandate` migration
"with S0.4". This ADR lands it earlier, alongside mandate v0, because the fabric package
acquires its first real surface area in the same slice and renaming after that is more
expensive than renaming before it. The sequencing intent is honoured; the date is not.
