# mandates/

Mandate documents, one per member, versioned in git exactly like prompts (Bible §9.5).
Every evaluation logs the hash of the document it decided under, so a behavioural change
is answered with a diff and a revert rather than archaeology.

Shape: Bible §9.1. Every mandate now carries a **real Ed25519 signature** as a `sig` field
(S2.1). Authority is attributable to a KEY, not to whoever could edit a git file: a forged or
edited document fails verification and the evaluator refuses it at §0 (`SIGNATURE_INVALID`) before
reading a word it claims. The old rule still holds in a stronger form — a placeholder `ed25519:`
string is never acceptable: a document carries a genuine signature or none, and a `sig` inside the
payload (rather than beside it) is rejected by the strict schema.

Also omitted, and for the same reason placeholders are: `room` (mandates are per-member, not
per-room, until S1.1 has rooms with membership) and `route_constraints` (route selection does not
exist until S1.1).

## Signing — the trust root (S2.1, Bible §4.1)

The `sig` is signed over the **canonical payload** (the ten fields, keys sorted — the exact bytes
`mandateHash` covers, so adding a signature never changes a mandate's hash). It is a **sibling** of
the payload: `loadMandates` splits it off before the schema parse, which is why the hash stays over
the payload and the schema stays the ten fields it understands.

- **Public key — COMMITTED.** `TRUSTED_MANDATE_PUBKEY` in `packages/fabric/src/mandate.ts` (Ed25519,
  SPKI DER, base64). Runtime, CI and tests establish authenticity from the tree alone, **with no
  secret** — a serving machine needs only this constant and the signed files.
- **Private key — NEVER in the tree.** It signs, and lives in a local `.env` (or a CI secret) as
  `PLAYROOM_MANDATE_SIGNING_KEY` (Ed25519, PKCS8 DER, base64). This is a **custodial bootstrap key**
  (§4.1: "custodial keys in v1"); Prince holds it and rotates it for production.

Re-sign after editing any mandate, or the evaluator will refuse it:

```
PLAYROOM_MANDATE_SIGNING_KEY=<pkcs8-der-base64> pnpm tsx scripts/sign-mandates.ts
pnpm tsx scripts/sign-mandates.ts --check     # verify committed signatures; needs no key
```

**Rotation.** Generate a new keypair; either replace `TRUSTED_MANDATE_PUBKEY` and redeploy, or set
`PLAYROOM_MANDATE_PUBKEY` (an operator override on the same footing as `PLAYROOM_MANDATES_DIR`, with
the committed constant as its default) — then re-sign the mandates with the new private key and ship
them. Because the runtime only ever VERIFIES, rotation never puts a secret on a serving machine.

`scope` and `protected_actions` are drawn from the **command layer** — the action surface
`executeCommand` already dispatches on — not from a wishlist. `pr.merge` is listed as
protected because it is beat 5 of the demo; **nothing executes it, and nothing needs to.**
The refusal happens before any executor exists, which is the architecture working.

## `claude-code` — the connected member (SCC-2), and the line the JSON still cannot carry

`claude-code.json` now grants authority over its REQUESTS, not its work — Prince's ruling (SCC-2),
transcribed, not a value a slice chose: `scope` grants `pr.open` / `pr.review` / `pr.comment` outright,
and `pr.merge` / `deploy` under co-signature by `principal:prince`; `interrupts_per_day: 6`. Each
protected action is in BOTH `scope` and `protected_actions` on purpose — `evaluate` checks scope before
protection (RA-007), so a protected action absent from scope would BLOCK as out-of-scope rather than
co-sign. The scope was empty until SCC-2 for a reason that has now been answered: an agent's consequential
ASK can travel the command layer the evaluator sees — in-process (S2.1a) and from a laptop through the
authenticated door (S2.1b) — so a mandate that governs those asks is finally enforceable rather than
decorative.

**What is STILL bridged, and this is the line that matters: its WORK.** claude-code invokes a coding
agent whose side effects are real — files written, commands run, commits made — in a scratch workspace,
OUTSIDE the fabric. The mandate governs its **participation and its requests** (it authenticates as a
member, reads and speaks, asks before a protected action and waits, and — since SCC-3 — raises a bare
hand when it needs a human but has nothing to ask for, priced by the same `interrupts_per_day` budget as
any other claim on a person's attention); it does NOT govern its **workspace work**, because that work
does not travel the command layer. Nothing stops it running `pr.merge` in its
own shell and narrating it afterwards — the fabric refuses that only when it is ASKED through the door.
That residual is RT-005 (`docs/security/red-team-log.md`), and SCC-2 does not close it. The one sentence
every surface rendering this member must honour, per ADR-004: **participation and requests governed;
work bridged.** A posted closeout is a message, not a receipt.

## `host_scope` / `host_protected` — the Execution Gate's grants (C1, ADR-012)

Two OPTIONAL fields let a mandate govern HOST operations (`fs.*` / `git.*` / `shell.*`) the way `scope`
governs abstract ones — except they match the action's **resource**, not just its type. Each is a list of
`{ "action": "...", "resource": "<glob>" }`, where the glob is `**` (any run of characters, including `/`)
and `*` (within a single path segment). `evaluate` resolves a host op against them: a type granted nowhere
is BLOCK (`OUT_OF_SCOPE`); a `host_protected` match is CO_SIGN (signer = `co_sign.by`) and outranks an
allow; a `host_scope` match is ALLOW; an unmatched resource under a granted type is BLOCK
(`RESOURCE_OUT_OF_SCOPE`) for `fs.*`/`git.*` but CO_SIGN (`SHELL_NOT_ALLOWLISTED`) for `shell.*` —
allowlist + co-sign the rest, never a raw shell.

**The gate DECIDES; it never executes (ADR-012, RT-005).** A Local Node (C2) runs an op only on an ALLOW,
under a revocable lease. Omitting both fields grants NO host op — which is why every existing mandate,
carrying neither, is unchanged (and `canonicalise` drops undefined fields, so no signature moved).

**TO ACTIVATE for `claude-code` in production (a re-sign step, not a code change):** add the block below to
`claude-code.json` and re-sign with `PLAYROOM_MANDATE_SIGNING_KEY=<key> pnpm tsx scripts/sign-mandates.ts`.
Until then C1's capability ships INERT for prod — the shipped mandate carries no host policy, so every host
op claude-code asks for is refused `OUT_OF_SCOPE`, asserted in `apps/api/test/execution-gate.test.ts`.

```json
"host_scope": [
  { "action": "fs.read",   "resource": "**" },
  { "action": "fs.write",  "resource": "workspace/**" },
  { "action": "git.commit","resource": "**" },
  { "action": "git.push",  "resource": "refs/heads/feature/*" },
  { "action": "shell.exec","resource": "npm test" },
  { "action": "shell.exec","resource": "npm run **" },
  { "action": "shell.exec","resource": "git status" }
],
"host_protected": [
  { "action": "git.push", "resource": "refs/heads/main" }
]
```

Tune the block to the real workspace before signing — it is the literal policy the gate will enforce.

Changes ship under a `feat/mandate` prefix (Bible §9.5).
