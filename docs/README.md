# Playroom docs

Index of the documentation tree.

**Cite sections with their document** — `Bible §11`, `Roadmap §7`. A bare `§7` is ambiguous
between the two and has already caused one collision. See CONTRIBUTING and
[ADR-006](decisions/ADR-006-terminology-and-document-precedence.md).

- `architecture/` — **[Architecture Bible v1.1](architecture/playroom-architecture-bible-v1.1.md) — CANONICAL.** Supersedes the roadmap and absorbs it. Where the two disagree, the Bible wins; where the Bible is silent, the roadmap's operational detail stands.
- `roadmap/` — Master Roadmap v1.0, **superseded but retained** as the historical record: `playroom-master-roadmap-v1.pdf` (as the owner produced it) and `playroom-master-roadmap-v1.md` (transcription, for grep and section citation). Its body is not edited. `roadmap/amendments/` holds the RAs; `RA-001` re-scopes P4 into slices.
- `decisions/` — Architecture Decision Records. Start from `ADR-TEMPLATE.md`. `ADR-001` fixes the fail-closed mandate engine; `ADR-006` records the `mandate` terminology ruling and document precedence.
- `security/` — [`red-team-log.md`](security/red-team-log.md), the findings ledger S2.8 extends. RT-001 fixed, RT-002 accepted until S1.1.
- `deck/` — the YC deck v2. _Placeholder — owner will drop the file in._
