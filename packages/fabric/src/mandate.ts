import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';

// Mandate loading and hashing. Bible §9.1 (document), §9.5 (mandates as code).
//
// This is the whole of the fabric today, and that is deliberate: S2.1 replaces the
// INTERNALS of this package — signatures, replay protection, the counterparties and
// limits branches — rather than introducing a package. The same reasoning the Bible
// gives for packages/hosts/ existing at P2 with one occupant (§13).

// NO `sig` FIELD. Mandates are unsigned in v0 and the field is OMITTED, not stubbed
// with a fake `ed25519:` string. A placeholder signature is worse than none: it makes
// a document look verified, and every reader downstream — including a future
// sig_valid() — has to know it is a lie. Omit, never stub. Bible §9.2's first branch
// (`not mandate.sig_valid()`) therefore has nothing to check yet and is absent rather
// than faked; S2.1 adds signing and the branch together.
export const Mandate = z
  .object({
    mandate_id: z.string().regex(/^mnd_/, 'mandate_id must carry the mnd_ prefix'),
    principal: z.string().min(1),
    member: z.string().min(1),
    scope: z.array(z.string().min(1)),
    protected_actions: z.array(z.string().min(1)),
    co_sign: z.object({ actions: z.array(z.string().min(1)), by: z.string().min(1) }),
    limits: z.record(z.number()),
    counterparties: z.string().min(1),
    policy_version: z.string().min(1),
    expires: z.string().datetime(),
  })
  .strict(); // an unknown field is a mandate we do not understand — reject it
export type Mandate = z.infer<typeof Mandate>;

/** A mandate plus the hash of the document it was loaded from. */
export interface LoadedMandate {
  mandate: Mandate;
  /** sha256 over canonically-serialised JSON, prefixed `sha256:` per Bible §9.3. */
  hash: string;
}

// Canonical serialisation: keys sorted at every level, no incidental whitespace. Two
// files that differ only in key order or formatting must hash identically, or the hash
// records the editor rather than the authority.
function canonicalise(value: unknown): string {
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
 * Load every mandate under `mandates/`, keyed by member id.
 *
 * A malformed document THROWS rather than being skipped. A skipped mandate is an
 * absent mandate, an absent mandate evaluates to BLOCK, and a member silently losing
 * all authority because a comma moved is a failure mode nobody would debug. Loud at
 * boot beats mysterious at runtime.
 */
export function loadMandates(dir: string = defaultMandatesDir()): Map<string, LoadedMandate> {
  const out = new Map<string, LoadedMandate>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const raw: unknown = JSON.parse(readFileSync(resolve(dir, file), 'utf8'));
    const parsed = Mandate.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`mandates/${file} is not a valid mandate: ${parsed.error.message}`);
    }
    out.set(parsed.data.member, { mandate: parsed.data, hash: mandateHash(parsed.data) });
  }
  return out;
}
