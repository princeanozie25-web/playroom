// scripts/sign-mandates.ts — sign every mandate under mandates/ with the Ed25519 private key.
//
//   PLAYROOM_MANDATE_SIGNING_KEY=<pkcs8-der-base64> pnpm tsx scripts/sign-mandates.ts
//   pnpm tsx scripts/sign-mandates.ts --check     # verify committed signatures; write nothing, need no key
//
// THE PRIVATE KEY SIGNS AND LIVES IN THE ENVIRONMENT, NEVER IN THE TREE — a local .env or a CI
// secret (mandates/README.md records how it is held and rotated). Each file gains a
// `sig: "ed25519:<b64>"` sibling of its payload, signed over the SAME canonical bytes the hash is
// taken over (packages/fabric/src/mandate.ts owns the one serialiser). After signing, every
// freshly-written signature is VERIFIED before the file is written: a signing key that does not
// match the trust root fails LOUDLY here, rather than silently at runtime as a
// BLOCK/SIGNATURE_INVALID on a mandate that looks fine on disk.
//
// The verification key is the one `loadMandates` itself uses — the committed TRUSTED_MANDATE_PUBKEY
// unless `PLAYROOM_MANDATE_PUBKEY` overrides it — so ROTATION works end to end: set the override to
// the NEW public key and sign with the NEW private key, and this guard accepts them exactly as the
// runtime will. Verifying against the hard-coded constant would reject a correct rotation.
//
// Structured as main() rather than top-level await, matching migrate.ts: this directory is
// transformed to CJS, where top-level await does not compile.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Mandate,
  signMandate,
  verifyMandateSig,
  TRUSTED_MANDATE_PUBKEY,
} from '../packages/fabric/src/index.js';

try {
  process.loadEnvFile();
} catch {
  /* no .env — rely on the environment */
}

function main(): void {
  const check = process.argv.includes('--check');
  const key = process.env.PLAYROOM_MANDATE_SIGNING_KEY;
  if (!check && !key) {
    throw new Error(
      'PLAYROOM_MANDATE_SIGNING_KEY is not set. The private key (Ed25519, PKCS8 DER, base64) signs ' +
        'the mandates; it lives in a local .env or a CI secret, never in the tree. Use --check to ' +
        'verify the committed signatures without a key.',
    );
  }

  // The public key to verify against: the same resolution loadMandates uses (override, else committed).
  const pub = process.env.PLAYROOM_MANDATE_PUBKEY || TRUSTED_MANDATE_PUBKEY;

  const dir = resolve(process.cwd(), 'mandates');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) throw new Error(`no mandates found under ${dir}`);

  let ok = 0;
  for (const file of files) {
    const path = resolve(dir, file);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    // Peel any existing signature off before parsing — the schema is the ten fields, `sig` is a
    // sibling. `.parse` (not `safeParse`) so a malformed mandate throws: only valid ones are signed.
    const { sig: _existing, ...payload } = raw;
    const mandate = Mandate.parse(payload);

    if (check) {
      const current = typeof raw.sig === 'string' ? raw.sig : '';
      const valid = verifyMandateSig(mandate, current, pub);
      console.log(`${valid ? 'OK  ' : 'BAD '} ${file}`);
      if (valid) ok++;
      continue;
    }

    const sig = signMandate(mandate, key!);
    if (!verifyMandateSig(mandate, sig, pub)) {
      throw new Error(
        `${file}: the freshly-signed signature does NOT verify against the trust root — the signing ` +
          `key does not match the public key in use (PLAYROOM_MANDATE_PUBKEY, else the committed ` +
          `TRUSTED_MANDATE_PUBKEY). No files written.`,
      );
    }
    // `sig` last, payload keys in their original order. Whitespace is cosmetic: the signature and
    // hash are over the canonical payload, so `prettier --write` afterwards cannot invalidate them.
    writeFileSync(path, JSON.stringify({ ...payload, sig }, null, 2) + '\n');
    console.log(`signed ${file}`);
    ok++;
  }

  if (check) {
    console.log(`\n${ok}/${files.length} mandates verify against the trust root in use.`);
    if (ok !== files.length) {
      throw new Error('some mandates do not verify against the trust root — re-sign them.');
    }
  } else {
    console.log(
      `\nsigned ${ok} mandate(s); each verified against the trust root in use before writing.`,
    );
  }
}

main();
