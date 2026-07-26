# Playroom docs

Index of the documentation tree.

**Cite sections with their document** — `Bible §11`, `Roadmap §7`. A bare `§7` is ambiguous
between the two and has already caused one collision. See CONTRIBUTING and
[ADR-006](decisions/ADR-006-terminology-and-document-precedence.md).

- `architecture/` — **[Architecture Bible v1.1](architecture/playroom-architecture-bible-v1.1.md) — CANONICAL.** Supersedes the roadmap and absorbs it. Where the two disagree, the Bible wins; where the Bible is silent, the roadmap's operational detail stands.
- `roadmap/` — Master Roadmap v1.0, **superseded but retained** as the historical record: `playroom-master-roadmap-v1.pdf` (as the owner produced it) and `playroom-master-roadmap-v1.md` (transcription, for grep and section citation). Its body is not edited. `roadmap/amendments/` holds the RAs; `RA-001` re-scopes P4 into slices.
- `decisions/` — Architecture Decision Records. Start from `ADR-TEMPLATE.md`. `ADR-001` fixes the fail-closed mandate engine; `ADR-006` records the `mandate` terminology ruling and document precedence; `ADR-008` makes cold start a separately published number.
- `security/` — [`red-team-log.md`](security/red-team-log.md), the findings ledger S2.8 extends. RT-001 and RT-003 fixed, RT-002 accepted until S1.1, RT-004 guarded with one gap accepted until S1.7. Its deferred-findings table carries the triggers that re-open each one.
- `design/` — **[the frontend design contract](design/design.md)** — the owner-authored UI direction, adopted from S1.4 onward. Its §14 records three places where it and the shipped app disagree; its reconciliation log records what DOC-1 changed and why.
- `demo/` — the P0 film's written record: [`p0-claims.md`](demo/p0-claims.md) — **read before cutting, captioning or showing it** — and [`p0-take-log.md`](demo/p0-take-log.md), the provenance of the recording. No video is committed.
- `deck/` — the YC deck v2. _Placeholder — owner will drop the file in._

## Amendments to the Bible, by section

An amendment nobody finds is an amendment that does not bind — RA-005's own argument, applied
to this index. Every RA that changes a canonical section is listed here **against that
section**, so the list is reachable from the number being checked rather than only from the
filename.

| Bible section           | Amended by                                                                                                           | Effect                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| §1, P4 slices           | [RA-001](roadmap/amendments/RA-001-membership-modes.md)                                                              | Connected members; P4 re-scoped into S4.1–S4.4                                                             |
| §9.2 (evaluation order) | [RA-007](roadmap/amendments/RA-007-standing-before-request.md)                                                       | `counterparties` moved ahead of `protected_actions`: establish standing before evaluating the request      |
| §11 (latency budgets)   | [ADR-005](decisions/ADR-005-first-token-latency.md), [ADR-008](decisions/ADR-008-cold-start-is-a-separate-number.md) | First-token P95 revised to 1.8s; the rows are **warm-path** budgets and cold start is published separately |
| §19, §20 (drift, gates) | [RA-004](roadmap/amendments/RA-004-drift-numbers-report-their-denominator.md)                                        | Every drift number publishes the population it examined                                                    |
| §21.2 (S1.7 exit)       | [RA-005](roadmap/amendments/RA-005-promotion-cannot-activate.md)                                                     | Promoted spans are inert: imported content cannot activate a summon                                        |
| §21.3 (S1.1 exit)       | [RA-006](roadmap/amendments/RA-006-enrolment-structural-then-authenticated.md)                                       | S1.1 makes enrolment binding and structural; S1.2 makes it authenticated                                   |
| §21.3 (P1)              | [RA-003](roadmap/amendments/RA-003-agent-turns-as-governed-actions.md)                                               | Agent turns through the evaluator, proposed as S1.8                                                        |
