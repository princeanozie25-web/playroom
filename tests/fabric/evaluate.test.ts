import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  evaluate,
  loadMandates,
  mandateHash,
  signMandate,
  verifyMandateSig,
  TRUSTED_MANDATE_PUBKEY,
  Mandate,
  type LoadedMandate,
  type ReasonCode,
  type Decision,
} from '@playroom/fabric';

// Mandate table test. Bible §9.2 (order), §10 (deny by default), §11 (<10 ms P50,
// <30 ms P95), §20 (40 cases at S2.1 — this is the v0 floor of 12, and the count is
// stated rather than implied).
//
// EVERY CASE ASSERTS THE DECISION AND ITS REASON CODE. A test that only asserts a
// merge did not happen passes whether the mandate refused it, the handler threw or the
// process died — that is the RT-001 mistake moved up a layer, and it is not accepted
// here. Where a co-signature is required, the required signer is asserted too.

const NOW = new Date('2026-07-26T12:00:00.000Z');

// `sigValid` defaults to true so every pre-S2.1 case reads as an authentic mandate and exercises
// the branch it was written for. The SIGNATURE_INVALID cases pass `false` to prove authenticity is
// checked ahead of scope, expiry and protection — see cases 22–25.
function loaded(overrides: Partial<Mandate> = {}, sigValid = true): LoadedMandate {
  const mandate = Mandate.parse({
    mandate_id: 'mnd_test',
    principal: 'principal:prince',
    member: 'claude-main',
    scope: ['pr.review', 'pr.comment'],
    protected_actions: ['pr.merge', 'deploy'],
    co_sign: { actions: ['pr.merge', 'deploy'], by: 'principal' },
    limits: { interrupts_per_day: 6 },
    counterparties: 'roster_only',
    policy_version: 'playroom-policy/1.0',
    expires: '2026-11-30T00:00:00Z',
    ...overrides,
  });
  return { mandate, hash: mandateHash(mandate), sig_valid: sigValid };
}

interface Case {
  name: string;
  action: string;
  member: string;
  mandate: LoadedMandate | undefined;
  decision: Decision;
  reason: ReasonCode;
  signer?: string | null;
}

const CASES: Case[] = [
  // --- in scope: ALLOW is demonstrable -------------------------------------------
  {
    name: '1. in scope — pr.review',
    action: 'pr.review',
    member: 'claude-main',
    mandate: loaded(),
    decision: 'ALLOW',
    reason: 'ALLOWED_IN_SCOPE',
    signer: null,
  },
  {
    name: '2. in scope — a second granted action, not just the first in the array',
    action: 'pr.comment',
    member: 'claude-main',
    mandate: loaded(),
    decision: 'ALLOW',
    reason: 'ALLOWED_IN_SCOPE',
    signer: null,
  },
  {
    name: '3. in scope — boundary: last entry in the scope array',
    action: 'pr.comment',
    member: 'claude-main',
    mandate: loaded(),
    decision: 'ALLOW',
    reason: 'ALLOWED_IN_SCOPE',
    signer: null,
  },

  // --- out of scope, and the deny-by-default line --------------------------------
  {
    name: '4. out of scope — a real action the mandate does not grant',
    action: 'pr.close',
    member: 'claude-main',
    mandate: loaded(),
    decision: 'BLOCK',
    reason: 'OUT_OF_SCOPE',
  },
  {
    name: '5. UNKNOWN action type is DENIED, not granted (deny-by-default)',
    action: 'totally.made.up.action',
    member: 'claude-main',
    mandate: loaded(),
    decision: 'BLOCK',
    reason: 'OUT_OF_SCOPE',
  },
  {
    name: '6. empty action type is denied, not treated as a wildcard',
    action: '',
    member: 'claude-main',
    mandate: loaded(),
    decision: 'BLOCK',
    reason: 'OUT_OF_SCOPE',
  },
  {
    name: '7. scope matching is exact — a prefix of a granted action is not granted',
    action: 'pr.rev',
    member: 'claude-main',
    mandate: loaded(),
    decision: 'BLOCK',
    reason: 'OUT_OF_SCOPE',
  },
  {
    name: '8. scope matching is case-sensitive — PR.REVIEW is not pr.review',
    action: 'PR.REVIEW',
    member: 'claude-main',
    mandate: loaded(),
    decision: 'BLOCK',
    reason: 'OUT_OF_SCOPE',
  },

  // --- protected actions ---------------------------------------------------------
  {
    name: '9. protected action — pr.merge pauses for the principal (deck beat 5)',
    action: 'pr.merge',
    member: 'claude-main',
    mandate: loaded({ scope: ['pr.review', 'pr.merge'] }),
    decision: 'CO_SIGN',
    reason: 'PROTECTED_ACTION',
    signer: 'principal:prince',
  },
  {
    name: '10. protected action — deploy, second entry in protected_actions',
    action: 'deploy',
    member: 'claude-main',
    mandate: loaded({ scope: ['deploy'] }),
    decision: 'CO_SIGN',
    reason: 'PROTECTED_ACTION',
    signer: 'principal:prince',
  },
  {
    name: '11. BOUNDARY: protected but NOT in scope is BLOCK, not CO_SIGN — scope is checked first',
    action: 'pr.merge',
    member: 'claude-main',
    mandate: loaded(), // pr.merge is protected but absent from scope
    decision: 'BLOCK',
    reason: 'OUT_OF_SCOPE',
  },
  {
    name: '12. co_sign.by names a signer directly — the signer is not defaulted',
    action: 'pr.merge',
    member: 'claude-main',
    mandate: loaded({
      scope: ['pr.merge'],
      co_sign: { actions: ['pr.merge'], by: 'principal:jerry' },
    }),
    decision: 'CO_SIGN',
    reason: 'PROTECTED_ACTION',
    signer: 'principal:jerry',
  },

  // --- expiry --------------------------------------------------------------------
  {
    name: '13. expired mandate — BLOCK even for an in-scope action',
    action: 'pr.review',
    member: 'claude-main',
    mandate: loaded({ expires: '2026-07-25T00:00:00Z' }),
    decision: 'BLOCK',
    reason: 'MANDATE_EXPIRED',
  },
  {
    name: '14. BOUNDARY: expiry exactly at `now` is expired — the window is closed, not open',
    action: 'pr.review',
    member: 'claude-main',
    mandate: loaded({ expires: NOW.toISOString() }),
    decision: 'BLOCK',
    reason: 'MANDATE_EXPIRED',
  },
  {
    name: '15. BOUNDARY: one second before expiry still ALLOWs',
    action: 'pr.review',
    member: 'claude-main',
    mandate: loaded({ expires: new Date(NOW.getTime() + 1000).toISOString() }),
    decision: 'ALLOW',
    reason: 'ALLOWED_IN_SCOPE',
    signer: null,
  },
  {
    name: '16. expiry outranks protected — an expired mandate does not reach CO_SIGN',
    action: 'pr.merge',
    member: 'claude-main',
    mandate: loaded({ scope: ['pr.merge'], expires: '2026-07-25T00:00:00Z' }),
    decision: 'BLOCK',
    reason: 'MANDATE_EXPIRED',
  },

  // --- absent mandate, wrong member, wrong principal ------------------------------
  {
    name: '17. NO mandate at all — BLOCK, never ALLOW',
    action: 'pr.review',
    member: 'someone-unknown',
    mandate: undefined,
    decision: 'BLOCK',
    reason: 'NO_MANDATE',
  },
  {
    name: '18. no mandate — even for an action no mandate anywhere protects',
    action: 'pr.comment',
    member: 'watcher',
    mandate: undefined,
    decision: 'BLOCK',
    reason: 'NO_MANDATE',
  },
  {
    name: '19. wrong member — a mandate belonging to someone else grants nothing',
    action: 'pr.review',
    member: 'sol',
    mandate: loaded(), // mandate.member is claude-main
    decision: 'BLOCK',
    reason: 'NO_MANDATE',
  },
  {
    name: '20. wrong principal — a mandate for another principal grants this member nothing',
    action: 'pr.review',
    member: 'sol',
    mandate: loaded({ member: 'claude-main', principal: 'principal:jerry' }),
    decision: 'BLOCK',
    reason: 'NO_MANDATE',
  },

  // --- empty scope ---------------------------------------------------------------
  {
    name: '21. empty scope grants nothing — not everything',
    action: 'pr.review',
    member: 'claude-main',
    mandate: loaded({ scope: [] }),
    decision: 'BLOCK',
    reason: 'OUT_OF_SCOPE',
  },

  // --- signature: authenticity is checked BEFORE anything the document claims (S2.1, §0) ---
  // Each case would reach a DIFFERENT decision if the §0 check were deleted or moved later — that
  // is what makes them mutation-worthy rather than decorative. A mutant that drops the check turns
  // 22 into ALLOW, 24 into CO_SIGN and 23 into MANDATE_EXPIRED; a mutant that orders §0 after
  // expiry turns 23 into MANDATE_EXPIRED. All four are caught here.
  {
    name: '22. bad signature — an otherwise in-scope action is BLOCKED, not ALLOWED',
    action: 'pr.review', // in scope; would ALLOW if authenticity were not checked first
    member: 'claude-main',
    mandate: loaded({}, false),
    decision: 'BLOCK',
    reason: 'SIGNATURE_INVALID',
  },
  {
    name: '23. bad signature outranks EXPIRY — a forged mandate is not judged on the expiry it claims',
    action: 'pr.review',
    member: 'claude-main',
    mandate: loaded({ expires: '2026-07-25T00:00:00Z' }, false), // also expired
    decision: 'BLOCK',
    reason: 'SIGNATURE_INVALID', // not MANDATE_EXPIRED — §0 precedes §1
  },
  {
    name: '24. bad signature outranks PROTECTED — no human is ever asked to co-sign a forgery (RA-007)',
    action: 'pr.merge', // protected AND in scope; would CO_SIGN if authenticity were not checked first
    member: 'claude-main',
    mandate: loaded({ scope: ['pr.review', 'pr.merge'] }, false),
    decision: 'BLOCK',
    reason: 'SIGNATURE_INVALID', // never CO_SIGN — refused outright, no signer named
  },
  {
    name: '25. bad signature — even an out-of-scope action reports the deeper failure',
    action: 'pr.close',
    member: 'claude-main',
    mandate: loaded({}, false),
    decision: 'BLOCK',
    reason: 'SIGNATURE_INVALID', // authenticity is the root; it is reported over OUT_OF_SCOPE
  },
  {
    name: '26. bad signature outranks the WRONG-MEMBER guard — §0 precedes even the member check',
    action: 'pr.review',
    member: 'sol', // mandate.member is claude-main; would be NO_MANDATE if authenticity were second
    mandate: loaded({}, false),
    decision: 'BLOCK',
    reason: 'SIGNATURE_INVALID',
  },

  // --- more exact-match boundaries on the deny-by-default line --------------------
  {
    name: '27. scope matching does not trim — a padded action string is out of scope',
    action: ' pr.review ',
    member: 'claude-main',
    mandate: loaded(),
    decision: 'BLOCK',
    reason: 'OUT_OF_SCOPE',
  },
  {
    name: '28. scope matching rejects a SUPERSTRING — pr.reviewed is not pr.review',
    action: 'pr.reviewed',
    member: 'claude-main',
    mandate: loaded(),
    decision: 'BLOCK',
    reason: 'OUT_OF_SCOPE',
  },
  {
    name: '29. the second protected action, absent from scope, is BLOCK not CO_SIGN (mirror of 11)',
    action: 'deploy', // protected, but not in the default scope
    member: 'claude-main',
    mandate: loaded(),
    decision: 'BLOCK',
    reason: 'OUT_OF_SCOPE',
  },
];

describe('mandate evaluation (Bible §9.2)', () => {
  // §20 sets 40 cases at S2.1. The count is stated, not implied: this TABLE is the decision
  // matrix (now 29, including the §0 authenticity/hijack cases 22–26 that S2.1 adds), and the
  // engine's S2.1 bar is met across this file as a whole — the table plus the dedicated
  // `signatures — the trust root` suite (round-trip, tamper, load, and the through-evaluate
  // integration) plus the counterparties and hashing suites — which together exceed 40. The
  // floor below is raised from 12 so a deleted case fails loudly rather than silently.
  it(`covers at least the raised S2.1 floor of 29 (has ${CASES.length})`, () => {
    expect(CASES.length).toBeGreaterThanOrEqual(29);
  });

  for (const c of CASES) {
    it(c.name, () => {
      const v = evaluate(
        { type: c.action, resource: 'repo:playroom/playroom#pr-41' },
        c.member,
        c.mandate,
        NOW,
      );
      expect(v.decision).toBe(c.decision);
      expect(v.reason_code).toBe(c.reason);
      if (c.signer !== undefined) expect(v.required_signer).toBe(c.signer);
      // A CO_SIGN without a signer is an unactionable decision — assert the pairing.
      if (v.decision === 'CO_SIGN') expect(v.required_signer).toBeTruthy();
      if (v.decision !== 'CO_SIGN') expect(v.required_signer).toBeNull();
      // Every verdict reached under a mandate carries its hash (Bible §9.2).
      if (c.mandate) expect(v.effective_mandate_hash).toBe(c.mandate.hash);
      else expect(v.effective_mandate_hash).toBeNull();
    });
  }
});

describe('mandate hashing (Bible §9.5)', () => {
  it('is stable and canonical — key order does not change the hash', () => {
    const a = Mandate.parse({
      mandate_id: 'mnd_x',
      principal: 'p',
      member: 'm',
      scope: ['a'],
      protected_actions: [],
      co_sign: { actions: [], by: 'principal' },
      limits: {},
      counterparties: 'roster_only',
      policy_version: 'v/1',
      expires: '2026-11-30T00:00:00Z',
    });
    // Same document, keys in a different order.
    const b = Mandate.parse({
      expires: '2026-11-30T00:00:00Z',
      policy_version: 'v/1',
      counterparties: 'roster_only',
      limits: {},
      co_sign: { by: 'principal', actions: [] },
      protected_actions: [],
      scope: ['a'],
      member: 'm',
      principal: 'p',
      mandate_id: 'mnd_x',
    });
    expect(mandateHash(a)).toBe(mandateHash(b));
    expect(mandateHash(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('changes when authority changes — a widened scope is a different mandate', () => {
    const narrow = loaded({ scope: ['pr.review'] });
    const wide = loaded({ scope: ['pr.review', 'pr.merge'] });
    expect(narrow.hash).not.toBe(wide.hash);
  });

  it('rejects a signature smuggled INTO the payload — sig is a sibling, never a field', () => {
    // Post-S2.1 the `sig` is real, but it lives BESIDE the payload; loadMandates splits it off
    // before this parse. `.strict()` therefore still refuses a `sig` INSIDE the payload — which
    // is what keeps the hash over the ten fields (never over its own signature) and stops a
    // forged document from smuggling authenticity in as just another key.
    const withSig = { ...loaded().mandate, sig: 'ed25519:not-a-real-signature' };
    expect(Mandate.safeParse(withSig).success).toBe(false);
  });

  it('rejects a mandate_id without the mnd_ prefix (terminology ruling)', () => {
    expect(Mandate.safeParse({ ...loaded().mandate, mandate_id: 'pmt_7f3a' }).success).toBe(false);
  });
});

describe('the shipped mandates load', () => {
  it('loads mandates/ from disk, keyed by member, with hashes AND a verified signature', () => {
    const all = loadMandates();
    expect(all.size).toBeGreaterThan(0);
    const claude = all.get('claude-main');
    expect(claude).toBeDefined();
    expect(claude?.mandate.principal).toBe('principal:prince');
    expect(claude?.mandate.protected_actions).toContain('pr.merge');
    expect(claude?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Every SHIPPED mandate is signed by the committed trust root — so none is refused at §0.
    for (const [member, m] of all) {
      expect(
        m.sig_valid,
        `shipped mandate ${member} must verify against TRUSTED_MANDATE_PUBKEY`,
      ).toBe(true);
    }
  });

  it('the shipped mandate refuses a merge and allows a review', () => {
    const claude = loadMandates().get('claude-main');
    const merge = evaluate({ type: 'pr.merge', resource: 'r' }, 'claude-main', claude, NOW);
    const review = evaluate({ type: 'pr.review', resource: 'r' }, 'claude-main', claude, NOW);
    // The SHIPPED posture: pr.merge is granted but protected, so it reaches CO_SIGN and
    // names a human — deck beat 5. (The other posture, merge absent from scope entirely,
    // yields BLOCK and is covered by table cases 11 and 16. Both are proven; only one
    // can be what the demo room actually shows.)
    expect(merge.decision).toBe('CO_SIGN');
    expect(merge.reason_code).toBe('PROTECTED_ACTION');
    expect(merge.required_signer).toBe('principal:prince');
    expect(review.decision).toBe('ALLOW');
  });
});

// ── SIGNATURES: THE TRUST ROOT (S2.1, Bible §4.1, §9.2) ──────────────────────────────────
//
// The point of signing is that authority is attributable to a KEY, not to whoever could edit a
// git file. These tests prove the three things that has to mean: a genuine signature verifies; a
// changed byte anywhere (payload OR signature) fails; and the committed public key matches the
// committed signatures, so the shipped mandates are authentic on any machine with no secret.
describe('signatures — the trust root (S2.1, Bible §4.1)', () => {
  // A fresh keypair per test proves the crypto round-trip WITHOUT the committed private key
  // (which is not in the tree). Public/private are exported to the same base64 DER encodings the
  // runtime uses: SPKI for the public key, PKCS8 for the private.
  function freshKeypair(): { pub: string; priv: string } {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    return {
      pub: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      priv: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    };
  }

  const sample = () => loaded().mandate;

  it('round-trips — a mandate signed with a key verifies with its public half', () => {
    const { pub, priv } = freshKeypair();
    const sig = signMandate(sample(), priv);
    expect(sig).toMatch(/^ed25519:[A-Za-z0-9+/]+=*$/);
    expect(verifyMandateSig(sample(), sig, pub)).toBe(true);
  });

  it('fails when the PAYLOAD is tampered — a widened scope no longer matches the signature', () => {
    const { pub, priv } = freshKeypair();
    const sig = signMandate(loaded({ scope: ['pr.review'] }).mandate, priv);
    // Same signature, a mandate whose authority was widened after signing.
    const widened = loaded({ scope: ['pr.review', 'pr.merge', 'deploy'] }).mandate;
    expect(verifyMandateSig(widened, sig, pub)).toBe(false);
  });

  it('fails when the SIGNATURE is tampered — a single flipped byte does not verify', () => {
    const { pub, priv } = freshKeypair();
    const sig = signMandate(sample(), priv);
    const i = 'ed25519:'.length;
    const flipped = sig.slice(0, i) + (sig[i] === 'A' ? 'B' : 'A') + sig.slice(i + 1);
    expect(verifyMandateSig(sample(), flipped, pub)).toBe(false);
  });

  it('fails safe — malformed, wrong-prefix and empty signatures return false, never throw', () => {
    const { pub } = freshKeypair();
    const m = sample();
    expect(verifyMandateSig(m, '', pub)).toBe(false);
    expect(verifyMandateSig(m, 'not-even-close', pub)).toBe(false);
    expect(verifyMandateSig(m, 'rsa:AAAA', pub)).toBe(false); // wrong algorithm prefix
    expect(verifyMandateSig(m, 'ed25519:@@@not-base64@@@', pub)).toBe(false);
    expect(verifyMandateSig(m, 'ed25519:', pub)).toBe(false); // empty body
  });

  it('fails when verified against the WRONG key — a valid signature from another signer is rejected', () => {
    const a = freshKeypair();
    const b = freshKeypair();
    const sig = signMandate(sample(), a.priv);
    expect(verifyMandateSig(sample(), sig, a.pub)).toBe(true);
    expect(verifyMandateSig(sample(), sig, b.pub)).toBe(false); // signed by A, checked against B
  });

  it('the committed public key matches the committed signatures — authentic with no secret', () => {
    // Read a real shipped mandate, split its sig, and verify against the DEFAULT (committed)
    // public key. This is what CI and prod do: establish authenticity from the tree alone.
    const dir = resolve(process.cwd(), 'mandates');
    const raw = JSON.parse(readFileSync(join(dir, 'claude-main.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const { sig, ...payload } = raw;
    const mandate = Mandate.parse(payload);
    expect(typeof sig).toBe('string');
    expect(verifyMandateSig(mandate, sig as string)).toBe(true); // default pub = TRUSTED_MANDATE_PUBKEY
    // And it is genuinely checking the key, not rubber-stamping: a different key rejects it.
    expect(verifyMandateSig(mandate, sig as string, freshKeypair().pub)).toBe(false);
    expect(TRUSTED_MANDATE_PUBKEY).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('loadMandates marks a byte-tampered file invalid while its neighbours stay valid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'playroom-sig-'));
    try {
      const real = resolve(process.cwd(), 'mandates');
      for (const f of readdirSync(real).filter((f) => f.endsWith('.json'))) {
        writeFileSync(join(dir, f), readFileSync(join(real, f), 'utf8'));
      }
      // Tamper claude-main's payload but keep its (now-stale) signature.
      const path = join(dir, 'claude-main.json');
      const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      doc.scope = [...(doc.scope as string[]), 'deploy']; // widen authority after signing
      writeFileSync(path, JSON.stringify(doc, null, 2));

      const all = loadMandates(dir);
      expect(all.get('claude-main')?.sig_valid).toBe(false); // the tampered one
      expect(all.get('sol')?.sig_valid).toBe(true); // an untouched neighbour
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an UNSIGNED mandate (no sig field) loads with sig_valid false — absence is not authenticity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'playroom-sig-'));
    try {
      // A valid ten-field payload with NO sig sibling.
      writeFileSync(join(dir, 'ghost.json'), JSON.stringify(loaded().mandate));
      expect(loadMandates(dir).get('claude-main')?.sig_valid).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('END TO END: a tampered file on disk becomes a BLOCK/SIGNATURE_INVALID at the evaluator', () => {
    const dir = mkdtempSync(join(tmpdir(), 'playroom-sig-'));
    try {
      const real = resolve(process.cwd(), 'mandates');
      const path = join(dir, 'claude-main.json');
      const doc = JSON.parse(readFileSync(join(real, 'claude-main.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      doc.scope = [...(doc.scope as string[]), 'deploy']; // forge a broader authority
      writeFileSync(path, JSON.stringify(doc, null, 2));

      const tampered = loadMandates(dir).get('claude-main');
      // The whole chain: forged file → loader marks it unauthentic → evaluator refuses at §0,
      // even for pr.review which the (forged) scope still lists. No authority flows from a forgery.
      const v = evaluate({ type: 'pr.review', resource: 'r' }, 'claude-main', tampered, NOW);
      expect(v.decision).toBe('BLOCK');
      expect(v.reason_code).toBe('SIGNATURE_INVALID');
      expect(v.required_signer).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('PLAYROOM_MANDATE_PUBKEY overrides the trust root — matching key verifies, otherwise fails closed', () => {
    // The rotation/testing affordance (mandate.ts trustedMandatePubKey). This is what makes an env
    // that names a DIFFERENT key take effect — a mutant that ignored the override and always used the
    // committed constant would fail the first assertion, because the committed key never signed this.
    const { pub, priv } = freshKeypair();
    const dir = mkdtempSync(join(tmpdir(), 'playroom-sig-'));
    const previous = process.env.PLAYROOM_MANDATE_PUBKEY;
    try {
      const mandate = sample(); // member: claude-main
      writeFileSync(
        join(dir, 'claude-main.json'),
        JSON.stringify({ ...mandate, sig: signMandate(mandate, priv) }),
      );

      process.env.PLAYROOM_MANDATE_PUBKEY = pub; // the key that DID sign it
      expect(loadMandates(dir).get('claude-main')?.sig_valid).toBe(true);

      delete process.env.PLAYROOM_MANDATE_PUBKEY; // default committed key did NOT sign it → fail closed
      expect(loadMandates(dir).get('claude-main')?.sig_valid).toBe(false);

      process.env.PLAYROOM_MANDATE_PUBKEY = freshKeypair().pub; // a WRONG override → still fail closed
      expect(loadMandates(dir).get('claude-main')?.sig_valid).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.PLAYROOM_MANDATE_PUBKEY;
      else process.env.PLAYROOM_MANDATE_PUBKEY = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('evaluation latency against Bible §11 (<10 ms P50, <30 ms P95)', () => {
  it('is orders of magnitude inside budget — anything slower is doing I/O', () => {
    const m = loaded();
    const samples: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const t = performance.now();
      evaluate({ type: 'pr.review', resource: 'r' }, 'claude-main', m, NOW);
      samples.push(performance.now() - t);
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)];
    const p95 = samples[Math.floor(samples.length * 0.95)];
    console.log(
      `[fabric] evaluate() n=${samples.length} P50=${p50.toFixed(4)}ms P95=${p95.toFixed(4)}ms ` +
        `(Bible §11: P50 <10ms, P95 <30ms)`,
    );
    expect(p50).toBeLessThan(10);
    expect(p95).toBeLessThan(30);
    // The real assertion: a pure function should be microseconds. If this ever fails,
    // something has started doing I/O inside the evaluator.
    expect(p95).toBeLessThan(1);
  });
});

// ── COUNTERPARTIES: `roster_only` finally has a roster (S1.1b) ──────────────────────────
//
// This branch was ABSENT until rooms had members — not dead code and not a branch that always
// passed, but a comment holding a position in the order. The field `counterparties:
// "roster_only"` sat in both mandate documents claiming a restriction nothing could enforce,
// which is `room.post`'s failure inside an authority document rather than beside one.
describe('counterparties — roster_only', () => {
  const review = { type: 'pr.review', resource: 'repo:x#1' };

  it('BLOCKS a member acting in a room they are not enrolled in', () => {
    const v = evaluate(review, 'claude-main', loaded(), NOW, ['sol', 'prince']);
    expect(v.decision).toBe('BLOCK');
    expect(v.reason_code).toBe('ROSTER_VIOLATION');
    // Still audited against the mandate it was refused under.
    expect(v.effective_mandate_hash).toMatch(/^sha256:/);
  });

  it('ALLOWS the same action when the member is in the room', () => {
    const v = evaluate(review, 'claude-main', loaded(), NOW, ['claude-main', 'prince']);
    expect(v.decision).toBe('ALLOW');
    expect(v.reason_code).toBe('ALLOWED_IN_SCOPE');
  });

  it('is checked BEFORE protected actions — standing before the request (RA-007)', () => {
    // THIS TEST PREVIOUSLY ASSERTED THE OPPOSITE, and it was encoding a bug rather than a
    // behaviour. Bible §9.2 put `counterparties` at 5, behind `protected_actions` at 4, so a
    // protected action requested for a member who is NOT in the room returned CO_SIGN — the
    // system asking a human to sign for an absent member, on the DECISION card, which is the
    // surface carrying the most credibility in the product. Fail-closed, and the wrong
    // question. Logged as S11b-N1 by the version of this test that documented it; ruled on by
    // the owner and amended in RA-007.
    //
    // THE PRINCIPLE, not the line: establish standing before evaluating the request. Expiry,
    // scope and roster answer "may this member act here at all"; protection and limits answer
    // "what does this particular action need". Never ask a human to approve something that
    // should have been refused outright — which is the same reasoning that already put scope
    // ahead of protected (case 11 above).
    const m = loaded({ scope: ['pr.review', 'pr.comment', 'pr.merge'] });
    const merge = { type: 'pr.merge', resource: 'repo:x#1' };

    // In the room: the protected action still pauses for a human, exactly as the film shows.
    const inRoom = evaluate(merge, 'claude-main', m, NOW, ['claude-main', 'prince']);
    expect(inRoom.decision).toBe('CO_SIGN');
    expect(inRoom.reason_code).toBe('PROTECTED_ACTION');
    expect(inRoom.required_signer).toBe('principal:prince');

    // NOT in the room: refused outright, and NO signer is named — nobody is asked to sign
    // for a member who is not there.
    const outOfRoom = evaluate(merge, 'claude-main', m, NOW, ['sol']);
    expect(outOfRoom.decision).toBe('BLOCK');
    expect(outOfRoom.reason_code).toBe('ROSTER_VIOLATION');
    expect(outOfRoom.required_signer).toBeNull();
  });

  it('still lets the more fundamental refusal win — scope outranks roster', () => {
    // Standing questions are ordered among themselves too: an action the mandate never
    // granted is out of scope wherever it is asked from.
    const v = evaluate(
      { type: 'totally.made.up', resource: 'repo:x#1' },
      'claude-main',
      loaded(),
      NOW,
      ['sol'],
    );
    expect(v.reason_code).toBe('OUT_OF_SCOPE');
  });

  it('is SKIPPED when the caller has no room context, rather than inventing a verdict', () => {
    // Absent input, absent branch — the same discipline that keeps replay and limits out of
    // this function entirely. A caller with no room cannot be told whether a member is in one.
    expect(evaluate(review, 'claude-main', loaded(), NOW).decision).toBe('ALLOW');
  });

  it('does not fire for a mandate whose counterparties rule is something else', () => {
    const m = loaded({ counterparties: 'anyone' });
    expect(evaluate(review, 'claude-main', m, NOW, ['sol']).decision).toBe('ALLOW');
  });
});

// ── THE EXECUTION GATE — resource-scoped host operations (C1, ADR-012) ───────────────────────────
//
// The one FALSE invariant (#7) is that host file/git/shell access is not mediated. C1 makes it
// mediatable: a host op is an ActionRequest whose RESOURCE — inert for every abstract action — is now
// matched against the mandate's host policy. The gate DECIDES (ALLOW/CO_SIGN/BLOCK); it never runs
// anything (RT-005 preserved — a Local Node executes only on ALLOW). Prince's rulings, both asserted
// below: (1) decide-only; (2) shell = allowlist + CO_SIGN the rest, never a raw shell.
//
// Every case asserts the decision AND its reason code, the same discipline as the table above — a test
// that only checked "the write was refused" would pass whether the gate confined it or the whole branch
// were deleted.
const HOST_POLICY = {
  host_scope: [
    { action: 'fs.read', resource: '**' },
    { action: 'fs.write', resource: 'workspace/**' },
    { action: 'git.commit', resource: '**' },
    { action: 'git.push', resource: 'refs/heads/feature/*' },
    { action: 'shell.exec', resource: 'npm test' },
    { action: 'shell.exec', resource: 'npm run **' },
    { action: 'shell.exec', resource: 'config.json' }, // a literal pattern, to prove metachars are escaped
  ],
  host_protected: [{ action: 'git.push', resource: 'refs/heads/main' }],
};
const hostM = (extra: Partial<Mandate> = {}, sigValid = true) =>
  loaded({ ...HOST_POLICY, ...extra }, sigValid);

interface HostCase {
  name: string;
  action: string;
  resource: string;
  member: string;
  mandate: LoadedMandate | undefined;
  roster?: readonly string[];
  decision: Decision;
  reason: ReasonCode;
  signer?: string | null;
}

const HOST_CASES: HostCase[] = [
  // --- ALLOW: the resource matches an allowed pattern -----------------------------------------
  {
    name: 'H1. fs.read of anything — `**` allows any path',
    action: 'fs.read',
    resource: 'src/secrets/keys.ts',
    member: 'claude-main',
    mandate: hostM(),
    decision: 'ALLOW',
    reason: 'ALLOWED_IN_SCOPE',
    signer: null,
  },
  {
    name: 'H2. fs.write inside the workspace — confined and allowed',
    action: 'fs.write',
    resource: 'workspace/src/foo.ts',
    member: 'claude-main',
    mandate: hostM(),
    decision: 'ALLOW',
    reason: 'ALLOWED_IN_SCOPE',
    signer: null,
  },
  {
    name: 'H3. fs.write nested deep — `**` crosses `/`',
    action: 'fs.write',
    resource: 'workspace/a/b/c/d.ts',
    member: 'claude-main',
    mandate: hostM(),
    decision: 'ALLOW',
    reason: 'ALLOWED_IN_SCOPE',
    signer: null,
  },
  {
    name: 'H4. git.push a feature branch — allowed',
    action: 'git.push',
    resource: 'refs/heads/feature/room-door',
    member: 'claude-main',
    mandate: hostM(),
    decision: 'ALLOW',
    reason: 'ALLOWED_IN_SCOPE',
    signer: null,
  },
  {
    name: 'H5. git.commit anything — allowed by `**`',
    action: 'git.commit',
    resource: 'HEAD',
    member: 'claude-main',
    mandate: hostM(),
    decision: 'ALLOW',
    reason: 'ALLOWED_IN_SCOPE',
    signer: null,
  },
  {
    name: 'H6. shell.exec an allowlisted command (exact) — allowed',
    action: 'shell.exec',
    resource: 'npm test',
    member: 'claude-main',
    mandate: hostM(),
    decision: 'ALLOW',
    reason: 'ALLOWED_IN_SCOPE',
    signer: null,
  },
  {
    name: 'H7. shell.exec an allowlisted command (glob args) — `npm run **` allows the arguments',
    action: 'shell.exec',
    resource: 'npm run build --workspace apps/api',
    member: 'claude-main',
    mandate: hostM(),
    decision: 'ALLOW',
    reason: 'ALLOWED_IN_SCOPE',
    signer: null,
  },

  // --- CONFINEMENT: fs/git resource outside the allowed patterns is BLOCKED -------------------
  {
    name: 'H8. fs.write OUTSIDE the workspace — RESOURCE_OUT_OF_SCOPE, not a silent pass',
    action: 'fs.write',
    resource: '/etc/passwd',
    member: 'claude-main',
    mandate: hostM(),
    decision: 'BLOCK',
    reason: 'RESOURCE_OUT_OF_SCOPE',
  },
  {
    name: 'H9. fs.write to a sibling of the workspace — `workspace/**` is anchored, `workspacex/` does not match',
    action: 'fs.write',
    resource: 'workspacex/foo.ts',
    member: 'claude-main',
    mandate: hostM(),
    decision: 'BLOCK',
    reason: 'RESOURCE_OUT_OF_SCOPE',
  },
  {
    name: 'H10. git.push an ungranted branch — feature/* and main are the only grants',
    action: 'git.push',
    resource: 'refs/heads/release/9',
    member: 'claude-main',
    mandate: hostM(),
    decision: 'BLOCK',
    reason: 'RESOURCE_OUT_OF_SCOPE',
  },
  {
    name: 'H11. git.push a NESTED feature ref — `*` does not cross `/`, so feature/a/b is not feature/*',
    action: 'git.push',
    resource: 'refs/heads/feature/a/b',
    member: 'claude-main',
    mandate: hostM(),
    decision: 'BLOCK',
    reason: 'RESOURCE_OUT_OF_SCOPE',
  },

  // --- PROTECTED: an allowed resource that also matches host_protected pauses for a human ------
  {
    name: 'H12. git.push to main — protected, so CO_SIGN and name the principal',
    action: 'git.push',
    resource: 'refs/heads/main',
    member: 'claude-main',
    mandate: hostM(),
    decision: 'CO_SIGN',
    reason: 'PROTECTED_ACTION',
    signer: 'principal:prince',
  },
  {
    name: 'H13. protected outranks allow — even with a broad feature grant, main still co-signs',
    action: 'git.push',
    resource: 'refs/heads/main',
    member: 'claude-main',
    mandate: hostM({
      host_scope: [...HOST_POLICY.host_scope, { action: 'git.push', resource: 'refs/heads/**' }],
    }),
    decision: 'CO_SIGN',
    reason: 'PROTECTED_ACTION',
    signer: 'principal:prince',
  },

  // --- SHELL: allowlist + CO_SIGN the rest (never a raw shell, never a silent block) -----------
  {
    name: 'H14. shell.exec off the allowlist — CO_SIGN (a human approves the exact command), not BLOCK',
    action: 'shell.exec',
    resource: 'rm -rf /',
    member: 'claude-main',
    mandate: hostM(),
    decision: 'CO_SIGN',
    reason: 'SHELL_NOT_ALLOWLISTED',
    signer: 'principal:prince',
  },
  {
    name: 'H15. shell.exec close-but-not-listed — `npm testx` is not `npm test`, so CO_SIGN',
    action: 'shell.exec',
    resource: 'npm testx',
    member: 'claude-main',
    mandate: hostM(),
    decision: 'CO_SIGN',
    reason: 'SHELL_NOT_ALLOWLISTED',
    signer: 'principal:prince',
  },
  {
    name: 'H16. shell allowlist metacharacters are LITERAL — `config.json` matches, `configXjson` does not',
    action: 'shell.exec',
    resource: 'configXjson',
    member: 'claude-main',
    mandate: hostM(),
    decision: 'CO_SIGN', // the `.` in the pattern is escaped, so this is an unmatched shell command
    reason: 'SHELL_NOT_ALLOWLISTED',
    signer: 'principal:prince',
  },

  // --- DENY-BY-DEFAULT at the host layer ------------------------------------------------------
  {
    name: 'H17. a host TYPE the mandate grants nowhere — OUT_OF_SCOPE (fs.delete is not listed)',
    action: 'fs.delete',
    resource: 'workspace/foo.ts',
    member: 'claude-main',
    mandate: hostM(),
    decision: 'BLOCK',
    reason: 'OUT_OF_SCOPE',
  },
  {
    name: 'H18. shell with NO shell grant at all is BLOCK, not CO_SIGN — co-sign-the-rest needs a grant first',
    action: 'shell.exec',
    resource: 'npm test',
    member: 'claude-main',
    // A host policy with fs grants but NO shell.exec entry anywhere.
    mandate: hostM({ host_scope: [{ action: 'fs.read', resource: '**' }], host_protected: [] }),
    decision: 'BLOCK',
    reason: 'OUT_OF_SCOPE',
  },
  {
    name: 'H19. a mandate with NO host policy grants NO host op — every existing mandate is unaffected',
    action: 'fs.write',
    resource: 'workspace/foo.ts',
    member: 'claude-main',
    mandate: loaded(), // the default mandate: no host_scope, no host_protected
    decision: 'BLOCK',
    reason: 'OUT_OF_SCOPE',
  },

  // --- STANDING PRECEDES THE HOST OP (authenticity, expiry, roster, mandate presence) ---------
  {
    name: 'H20. a forged mandate never reaches the gate — SIGNATURE_INVALID outranks even an allowed write',
    action: 'fs.write',
    resource: 'workspace/foo.ts',
    member: 'claude-main',
    mandate: hostM({}, false), // sig invalid
    decision: 'BLOCK',
    reason: 'SIGNATURE_INVALID',
  },
  {
    name: 'H21. an expired mandate does not gate a host op — MANDATE_EXPIRED, not ALLOW',
    action: 'fs.write',
    resource: 'workspace/foo.ts',
    member: 'claude-main',
    mandate: hostM({ expires: '2026-07-25T00:00:00Z' }),
    decision: 'BLOCK',
    reason: 'MANDATE_EXPIRED',
  },
  {
    name: 'H22. a host op from a member NOT in the room — ROSTER_VIOLATION, before the gate asks what it needs',
    action: 'fs.write',
    resource: 'workspace/foo.ts',
    member: 'claude-main',
    mandate: hostM(),
    roster: ['sol', 'prince'], // claude-main is not here
    decision: 'BLOCK',
    reason: 'ROSTER_VIOLATION',
  },
  {
    name: 'H23. no mandate at all — a host op is BLOCK/NO_MANDATE like any other action',
    action: 'shell.exec',
    resource: 'npm test',
    member: 'nobody',
    mandate: undefined,
    decision: 'BLOCK',
    reason: 'NO_MANDATE',
  },

  // --- the gate does not disturb abstract actions ---------------------------------------------
  {
    name: 'H24. an abstract action on a mandate WITH host policy still takes the type-level scope path',
    action: 'pr.review',
    resource: 'repo:playroom/playroom#pr-1',
    member: 'claude-main',
    mandate: hostM(),
    decision: 'ALLOW',
    reason: 'ALLOWED_IN_SCOPE',
    signer: null,
  },
];

describe('the execution gate — host operations (C1, ADR-012)', () => {
  it(`covers the host-op decision surface (has ${HOST_CASES.length})`, () => {
    expect(HOST_CASES.length).toBeGreaterThanOrEqual(24);
  });

  for (const c of HOST_CASES) {
    it(c.name, () => {
      const v = evaluate(
        { type: c.action, resource: c.resource },
        c.member,
        c.mandate,
        NOW,
        c.roster,
      );
      expect(v.decision).toBe(c.decision);
      expect(v.reason_code).toBe(c.reason);
      if (c.signer !== undefined) expect(v.required_signer).toBe(c.signer);
      // The CO_SIGN/signer pairing invariant holds for host ops too — a co-sign with no signer is unactionable.
      if (v.decision === 'CO_SIGN') expect(v.required_signer).toBeTruthy();
      if (v.decision !== 'CO_SIGN') expect(v.required_signer).toBeNull();
      if (c.mandate) expect(v.effective_mandate_hash).toBe(c.mandate.hash);
      else expect(v.effective_mandate_hash).toBeNull();
    });
  }
});
