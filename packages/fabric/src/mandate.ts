import { readFileSync, readdirSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';

// Mandate loading, hashing, signing and verification. Bible §9.1 (document), §9.2 (the
// sig_valid() branch), §9.5 (mandates as code), §4.1 (Ed25519, custodial keys in v1).
//
// This is the whole of the fabric today, and that is deliberate: S2.1 replaced the INTERNALS
// of this package — signatures and their enforcement — rather than introducing a package. The
// same reasoning the Bible gives for packages/hosts/ existing at P2 with one occupant (§13).

// ── THE TRUST ROOT (Bible §4.1) ──
//
// The one public key every reader verifies against — Ed25519, SPKI, DER, base64. Committing the
// PUBLIC half is the whole point: runtime, CI and tests establish a mandate's authenticity with
// NO secret, so a forged or edited mandate fails `verifyMandateSig` on every machine, and prod
// enforces authenticity with nothing but this constant and the signed files it ships with.
//
// The PRIVATE half signs, and lives NOWHERE in this tree: a local `.env` for the signing script
// (scripts/sign-mandates.ts) and, for CI re-signing, a secret. This is a custodial BOOTSTRAP key
// (§4.1: "custodial keys in v1"); mandates/README.md records how Prince rotates it for
// production — generate a new pair, replace this constant, re-sign, deploy. Because the runtime
// only ever VERIFIES, rotation touches this line and the signatures, never the running servers'
// secrets.
export const TRUSTED_MANDATE_PUBKEY =
  'MCowBQYDK2VwAyEAZmJL35FBiszAjTkkW5ffqGPQA2dnnGSSiZZR7lBAqGU=';

/**
 * The public key `loadMandates` actually verifies against: the committed
 * {@link TRUSTED_MANDATE_PUBKEY} unless `PLAYROOM_MANDATE_PUBKEY` overrides it.
 *
 * The override is an OPERATOR affordance on exactly the same footing as `PLAYROOM_MANDATES_DIR`:
 * whoever can set the environment already decides WHICH mandates load at all, so trusting them to
 * name the key those mandates were signed with adds no reachable attack surface. What it buys is
 * real: key ROTATION becomes a config change (publish the new public key, ship re-signed mandates
 * — no rebuild, §4.1), and a test can verify re-signed mandates under a throwaway key. The
 * DEFAULT — env unset — is the whole point of S2.1: authenticity established from the committed
 * tree alone, with no secret anywhere near a serving machine.
 */
function trustedMandatePubKey(): string {
  return process.env.PLAYROOM_MANDATE_PUBKEY || TRUSTED_MANDATE_PUBKEY;
}

// The `sig` field is a SIBLING of the mandate payload, never a field of it. `loadMandates`
// splits it off before the strict parse below, so three things stay true at once: the schema
// remains the ten fields it understands; `mandateHash` stays over the payload, so every hash
// ever recorded is still stable; and a `sig` smuggled INTO the payload is rejected by
// `.strict()` rather than silently covered by the hash or mistaken for authenticity. A mandate
// is signed over the SAME canonical bytes the hash is taken over — the payload, keys sorted,
// without the signature that does not yet exist when those bytes are computed. (Before S2.1 the
// field was OMITTED entirely; the ban on a placeholder `ed25519:` string still holds — a
// document either carries a real signature or none, never a fake one.)
export const Mandate = z
  .object({
    mandate_id: z.string().regex(/^mnd_/, 'mandate_id must carry the mnd_ prefix'),
    principal: z.string().min(1),
    member: z.string().min(1),
    /**
     * Granted action types.
     *
     * EVERY ENTRY MUST BE AN ACTION THE EVALUATOR ACTUALLY RECEIVES. An entry nothing
     * dispatches is not harmless: it is text inside an authority document that reads as
     * a granted power, and the next person to look will trust it. `room.post` sat here
     * until S0.4 and was never evaluated — the same failure shape as `mandate_label`,
     * which described authority without being it.
     *
     * Before adding an entry, check that some code path calls evaluate() with it.
     */
    scope: z.array(z.string().min(1)),
    protected_actions: z.array(z.string().min(1)),
    co_sign: z.object({ actions: z.array(z.string().min(1)), by: z.string().min(1) }),
    /**
     * THE EXECUTION GATE'S RESOURCE-SCOPED HOST GRANTS (C1, ADR-012). OPTIONAL, and its absence is
     * load-bearing: a mandate with no host policy grants NO host operation — every `fs.*`/`git.*`/`shell.*`
     * action BLOCKs by default (deny-by-default at the host layer). Because `canonicalise` drops undefined
     * fields, omitting these two leaves every existing mandate's canonical bytes — and therefore its
     * signature — completely unchanged, which is why host policy can be added to the schema without
     * re-signing a single shipped mandate.
     *
     * Each entry pairs a host action `type` with a RESOURCE GLOB. Unlike `scope`, which matches the action
     * TYPE only, the gate matches `action.resource` against these patterns (`**` = any run of characters
     * including `/`; `*` = within a single path segment): `fs.write` is confined to the paths it lists,
     * `git.push` to the refs it lists, `shell.exec` to the commands it lists. A member with no matching
     * pattern under a granted type is refused (fs/git) or escalated to a human (shell — see the evaluator).
     *
     * `requires` (C3, ADR-014) is the TEMPORAL condition: a list of fact keys that must ALL hold for the
     * grant to apply. The caller assembles the facts from the event log and passes them to `evaluate` — so
     * "may push to `main` only after tests pass" is expressible as `requires: ["tests_passed"]`, and a
     * matched grant whose facts are unmet is BLOCKed with `CONDITION_UNMET` rather than silently ignored.
     * Absent `requires` = unconditional (the C1 behaviour, unchanged).
     */
    host_scope: z
      .array(
        z
          .object({
            action: z.string().min(1),
            resource: z.string().min(1),
            requires: z.array(z.string().min(1)).optional(),
          })
          .strict(),
      )
      .optional(),
    /**
     * The host grants that require a human co-signature EVEN WHEN allowed — e.g. a push to `main`. A
     * resource matching a `host_protected` pattern is CO_SIGN (signer = `co_sign.by`), taking precedence
     * over any `host_scope` match. The host-op counterpart of `protected_actions`. Also carries `requires`
     * (C3): a protected grant whose facts are unmet is BLOCKed, not co-signed — the condition gates first.
     */
    host_protected: z
      .array(
        z
          .object({
            action: z.string().min(1),
            resource: z.string().min(1),
            requires: z.array(z.string().min(1)).optional(),
          })
          .strict(),
      )
      .optional(),
    limits: z.record(z.number()),
    counterparties: z.string().min(1),
    policy_version: z.string().min(1),
    expires: z.string().datetime(),
  })
  .strict(); // an unknown field is a mandate we do not understand — reject it
export type Mandate = z.infer<typeof Mandate>;

/** A mandate, the hash of the document it was loaded from, and whether its signature verified. */
export interface LoadedMandate {
  mandate: Mandate;
  /** sha256 over canonically-serialised JSON, prefixed `sha256:` per Bible §9.3. */
  hash: string;
  /**
   * Did this document's `sig` verify against {@link TRUSTED_MANDATE_PUBKEY}? The evaluator
   * BLOCKs a mandate with `sig_valid: false` before any other check (evaluate.ts §0): an
   * unsigned, tampered or wrongly-keyed document carries no authority, whatever it claims about
   * scope or expiry. Established at LOAD, from the file on disk — never carried over a wire and
   * never trusted from a caller.
   */
  sig_valid: boolean;
}

// Canonical serialisation: keys sorted at every level, no incidental whitespace. Two
// files that differ only in key order or formatting must hash identically, or the hash
// records the editor rather than the authority. The signature is taken over these same bytes,
// so signing and hashing agree by construction — one serialiser, not two that could drift.
//
// Exported because the audit chain (S2.3) hashes event bodies over the SAME canonical form:
// a JSONB payload has no stable key order or whitespace, so a body_hash needs this exact
// discipline, and a second canonicaliser is a second place for the chain and the log to
// disagree about what "the body" is.
export function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`;
}

export function mandateHash(mandate: Mandate): string {
  return `sha256:${createHash('sha256').update(canonicalise(mandate)).digest('hex')}`;
}

/**
 * Sign a mandate payload with an Ed25519 private key (PKCS8 DER, base64), returning the
 * `ed25519:<base64>` string that becomes the document's `sig`.
 *
 * The SIGNING counterpart of {@link verifyMandateSig}: the two share {@link canonicalise}, so
 * the bytes signed here are exactly the bytes checked there — signing and verification cannot
 * disagree about what "the document" is. Used by scripts/sign-mandates.ts; the RUNTIME never
 * signs, it only verifies, which is why the private key need not exist on a serving machine.
 */
export function signMandate(mandate: Mandate, privateKeyB64: string): string {
  const key = createPrivateKey({
    key: Buffer.from(privateKeyB64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const signature = sign(null, Buffer.from(canonicalise(mandate), 'utf8'), key);
  return `ed25519:${signature.toString('base64')}`;
}

/**
 * Verify a mandate's `sig` against a trusted public key (SPKI DER, base64; the committed
 * {@link TRUSTED_MANDATE_PUBKEY} by default).
 *
 * Returns a boolean and NEVER throws. A wrong prefix, a malformed signature, a malformed key —
 * all resolve to `false`, because a document that CANNOT be checked is exactly as unauthentic as
 * one that fails the check, and a verifier that threw would turn a forged mandate into a crashed
 * loader (a denial of service in place of a clean BLOCK). Deny-by-default extends to the failure
 * of verification itself.
 */
export function verifyMandateSig(
  mandate: Mandate,
  sig: string,
  pub: string = TRUSTED_MANDATE_PUBKEY,
): boolean {
  if (!sig.startsWith('ed25519:')) return false;
  try {
    const sigBytes = Buffer.from(sig.slice('ed25519:'.length), 'base64');
    const key = createPublicKey({ key: Buffer.from(pub, 'base64'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(canonicalise(mandate), 'utf8'), key, sigBytes);
  } catch {
    return false;
  }
}

// mandates/ lives at the repo root. Resolved from cwd against a candidate list rather
// than `new URL('../../../mandates/', import.meta.url)`: a bundler reads that as a
// module specifier and fails the build, and this package is imported by apps/web, whose
// server code webpack compiles. PLAYROOM_MANDATES_DIR overrides for a deployment whose
// layout differs.
function defaultMandatesDir(): string {
  const fromEnv = process.env.PLAYROOM_MANDATES_DIR;
  if (fromEnv) return fromEnv;
  const candidates = [
    resolve(process.cwd(), 'mandates'), // repo root (api, tests)
    resolve(process.cwd(), '../../mandates'), // apps/web, apps/api
    resolve(process.cwd(), '../mandates'),
  ];
  for (const c of candidates) {
    try {
      readdirSync(c);
      return c;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`mandates/ not found (looked in: ${candidates.join(', ')})`);
}

/**
 * Split a raw parsed document into its signature and the payload the schema validates.
 *
 * A mandate file is `{ ...payload, sig }`. The `sig` is peeled off HERE, before the strict
 * parse, so the schema never sees it and the hash never covers it. A non-object (a JSON `null`,
 * array or scalar) is passed through untouched for the strict parse to reject with its own
 * precise message, rather than crashing a destructure.
 */
function splitSignature(raw: unknown): { sig: string | undefined; payload: unknown } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { sig: undefined, payload: raw };
  }
  const { sig, ...payload } = raw as Record<string, unknown>;
  return { sig: typeof sig === 'string' ? sig : undefined, payload };
}

/**
 * Load every mandate under `mandates/`, keyed by member id.
 *
 * A malformed document THROWS rather than being skipped. A skipped mandate is an
 * absent mandate, an absent mandate evaluates to BLOCK, and a member silently losing
 * all authority because a comma moved is a failure mode nobody would debug. Loud at
 * boot beats mysterious at runtime.
 *
 * An INVALID or ABSENT signature, by contrast, does NOT throw — it is recorded as
 * `sig_valid: false`. Refusing to load an unauthentic mandate would mean the evaluator never
 * receives one, which makes its SIGNATURE_INVALID branch dead code: a fail-closed check nothing
 * can reach is untestable and unfalsifiable. The loader's job is to report authenticity; the
 * evaluator's job is to refuse on it (deny-by-default, per member, per action).
 */
export function loadMandates(dir: string = defaultMandatesDir()): Map<string, LoadedMandate> {
  const out = new Map<string, LoadedMandate>();
  const pub = trustedMandatePubKey(); // resolved once — the trust root does not change per file
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const raw: unknown = JSON.parse(readFileSync(resolve(dir, file), 'utf8'));
    const { sig, payload } = splitSignature(raw);
    const parsed = Mandate.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`mandates/${file} is not a valid mandate: ${parsed.error.message}`);
    }
    const sig_valid = sig !== undefined && verifyMandateSig(parsed.data, sig, pub);
    out.set(parsed.data.member, {
      mandate: parsed.data,
      hash: mandateHash(parsed.data),
      sig_valid,
    });
  }
  return out;
}
