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
- **Every slice ends with something a camera can see** (roadmap §11.1).
- **Providers are named only inside `packages/adapters/`** (roadmap §2, §6). No provider
  name appears in a room, the fabric, or shared code.

## Provider names: source vs. config

Provider-name rule (§6) applies to source code: the room, fabric, and data model
never branch on a provider. Deployment config (.env keys, adapters.yaml) is
exempt and is consumed only by packages/adapters/.

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
