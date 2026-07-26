# Contributing to Playroom

Playroom is a production company's repository. The build discipline below is not
advice — it is how the repo stays trustworthy from commit one.

## Build discipline

- **One writer per repo.** A single implementation agent holds the pen at a time.
- **Slices ship behind flags** where feasible, so an unfinished path is dark, not broken.
- **Rollback is a flag flip or a `git revert`, never surgery.** If undoing a slice needs
  hand-editing, the slice was shaped wrong.
- **In-hook green commits — never bypass with `--no-verify`.** The pre-commit hook runs
  `pnpm verify`; a red tree does not get committed.
- **Typecheck coverage is total — `tsc -b` sees every `.ts`/`.tsx`, tests included.** App
  code, packages, and test suites are all reachable from the root `tsconfig.json`
  references. A source area the root build can't reach (a new app, a test tree outside a
  referenced project) is a defect: wire it in so a type error anywhere fails `pnpm verify`,
  never just `next build` or the editor. Narrow discriminated unions with type predicates,
  not casts — a test that reaches a member's payload proves the member, it doesn't assert it.
- **No implementation agent commits outside an authorizing brief.** If it isn't in the
  brief, it isn't in the commit.
- **Every slice ends with something a camera can see** (Bible §21.1).
- **Providers are named only inside `packages/adapters/`** (Bible §10, Roadmap §6). No provider
  name appears in a room, the fabric, or shared code.

## Citing the documents

Two documents govern this repository and their section numbers collide.

- **[Architecture Bible v1.1](docs/architecture/playroom-architecture-bible-v1.1.md)** is
  canonical. Cite as **`Bible §11`**.
- **[Master Roadmap v1.0](docs/roadmap/playroom-master-roadmap-v1.md)** is superseded but
  retained; where the Bible is silent its operational detail still stands. Cite as
  **`Roadmap §7`**.

**Never write a bare `§7`.** It resolves to latency budgets in one document and context
boundaries in the other. On 25 July a brief and a closeout each cited "§7" meaning a
different document, both were correct, and neither noticed. This applies to briefs,
commit messages, closeouts and ADRs as much as to code comments. Precedence is recorded
in [ADR-006](docs/decisions/ADR-006-terminology-and-document-precedence.md).

**`mandate`, never `permit`** (Bible terminology ruling). Prefix `mnd_`, directory
`mandates/`, field `effective_mandate_hash`. The superseded term survives only inside
historical documents, which are not edited.

## Closed unions vs. open strings

Both are house style; which one is correct depends on who controls the values.

- **Closed union** (`z.enum`, discriminated union) for anything you **dispatch on and
  control both ends of**: `event_type` at the point a reducer switches on it,
  `mandate_decision`, `screen_verdict`. If an unknown value would be a bug, close it.
- **Open string with a visible fallback** for anything that **will grow**: the `code`
  on `ServerErrorFrame`, `reason_code` on a decision, and any future taxonomy a later
  slice extends. Render the unknown value rather than dropping it.

The reason is A4-F1's failure mode, one layer up. A closed enum makes an older client
**fail to parse** a value added later, and a frame that fails to parse is a frame that
gets **dropped** — which is exactly the silent refusal the fabric exists to prevent.
An open string with a fallback degrades to "something happened that I do not have a
label for", which is honest and visible.

This is a convention, not a one-off exemption for one field. Do not "tidy" an open
`code` into an enum to match house style — house style is this paragraph.

## Provider names: source vs. config

Provider-name rule (Bible §10, Roadmap §6) applies to source code: the room, the fabric
and the data model never branch on a provider. Deployment config (`.env` keys,
`adapters.yaml`) is exempt.

**`adapters.yaml` has two consumers, not one** (corrects SUI-N2, which recorded that this
paragraph had become inaccurate):

1. **`packages/adapters/`** reads the provider fields — `provider`, `model`, prices,
   `max_output_tokens`. It is the §6-exempt boundary and the only place a provider is named.
2. **`apps/web`'s server layer** reads the _roster_ fields only — `id`, `display_name`,
   `principal`. It projects those four and **never** `provider` or `model`, so no provider
   name reaches a room even though the web app now reads that file. If a change makes the
   web layer able to see `provider`, that is the defect, not the read.

**Ownership of the roster is S1.1's decision.** Two filesystem readers of one config file is
a stopgap for the absence of a membership model, not a design. S1.1 lands principals,
members and the roster properly and should take the roster into the room-state payload,
retiring the second reader.

## Setup

Enable the checked-in git hooks once per clone:

```
git config core.hooksPath hooks
```

Then `pnpm install` and `pnpm verify` must both be green before you write anything.

## Database

The integration tests need Postgres. Copy `.env.example` to `.env` and set
`DATABASE_URL` / `TEST_DATABASE_URL` (a hosted Postgres, or a local one via
`infra/docker-compose.yml` once it exists). After Postgres is up, run `pnpm migrate`
once — it applies `infra/migrations/*.sql` to the dev and `playroom_test` databases.
Then `pnpm verify` runs the full suite, integration tests included. CI stands up a
`postgres:16` service and runs `pnpm migrate` before `pnpm verify`.

## Local verification tooling

Browser verification uses [`agent-browser`](https://github.com/vercel-labs/agent-browser),
pinned to `0.33.0`, installed **globally** and developer-local. It is **never** a repo
dependency and never appears in any `package.json`. All browser verification is
localhost-scoped (`--allowed-domains "localhost,127.0.0.1"`); its artifacts
(`agent-browser.json`, `*.har`) are gitignored and screenshots go outside the repo.

- **Scratch harnesses live outside the repo tree.** One-off measurement or exploration
  scripts (latency probes, load generators, corpus scratchers) are written to a scratch
  directory outside the working tree and never committed. If a harness earns a permanent
  home it graduates into `scripts/` deliberately, reviewed like any other code.
- **Export derived data before deleting a scratch harness.** When a throwaway harness
  produces numbers you will cite — a latency table, a measurement an ADR rests on —
  extract the results into the ADR or a committed artifact first. Once the harness is gone
  the raw run is gone; a claim must never outlive the evidence for it.
