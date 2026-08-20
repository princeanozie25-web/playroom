import { describe, expect, it } from 'vitest';
import { scan, summarize } from './egress.js';

// ═══ EGRESS DLP — catch the secret, NEVER echo it (ADR-018) ═══════════════════════════════════════════
//
// The defining property: a finding carries no secret bytes, and the redacted text masks the secret in place.
// All test secrets are built by concatenation so no literal contiguous credential sits in this source — a
// private-key header or a real-looking token in a committed file would trip push protection and be, itself,
// the kind of leak this package exists to stop.

const PRIVATE_KEY = `-----BEGIN RSA PRIVATE ${'KEY'}-----\nMIIEpAIBAAKC...\n-----END RSA PRIVATE ${'KEY'}-----`;
const AWS_KEY = `AKIA${'ABCDEFGHIJKLMNOP'}`; // AKIA + 16 upper-alnum
const GH_TOKEN = `ghp_${'x'.repeat(36)}`;
const PRM = `prm_${'a1b2c3d4e5f6g7h8'}`; // Playroom credential
const OPENAI = `sk-${'A'.repeat(24)}`;

describe('detects secrets by shape, and grades severity', () => {
  it('a private key block is CRITICAL', () => {
    const r = scan(`here is the deploy key:\n${PRIVATE_KEY}\nthanks`);
    expect(r.risk).toBe('critical');
    expect(r.findings.some((f) => f.signal === 'private_key')).toBe(true);
    expect(r.clean).toBe(false);
  });

  it('a Playroom credential token is CRITICAL (internal credential)', () => {
    const r = scan(`use ${PRM} to authenticate`);
    expect(r.risk).toBe('critical');
    expect(r.findings.some((f) => f.signal === 'internal_credential')).toBe(true);
  });

  it('a third-party token is ELEVATED', () => {
    for (const secret of [AWS_KEY, GH_TOKEN, OPENAI]) {
      const r = scan(`token: ${secret}`);
      expect(r.risk, secret.slice(0, 4)).toBe('elevated');
      expect(r.findings.some((f) => f.signal === 'secret')).toBe(true);
    }
  });

  it('a `secret = <value>` assignment is caught, and only the VALUE is redacted', () => {
    const value = 'Zx9'.repeat(8); // 24 chars
    const r = scan(`config: api_key = ${value} # do not share`);
    expect(r.findings.some((f) => f.label === 'secret assignment')).toBe(true);
    expect(r.redacted).toContain('api_key ='); // the key word survives
    expect(r.redacted).not.toContain(value); // the value is gone
    expect(r.redacted).toContain('do not share'); // surrounding text survives
  });

  it('ordinary prose with no secret is clean — risk none, text unchanged', () => {
    const text = 'The deploy is green and the room is quiet. See you tomorrow.';
    const r = scan(text);
    expect(r.clean).toBe(true);
    expect(r.risk).toBe('none');
    expect(r.findings).toEqual([]);
    expect(r.redacted).toBe(text);
  });

  it('a bare word like "password" with no value is NOT a finding', () => {
    const r = scan('please reset your password on the settings page');
    expect(r.clean).toBe(true);
  });
});

describe('THE DISCIPLINE — a finding never carries the secret; the redacted text masks it', () => {
  it('no secret byte appears in any finding (evidence is label + length only)', () => {
    const secrets = [PRIVATE_KEY, AWS_KEY, GH_TOKEN, PRM, OPENAI];
    for (const secret of secrets) {
      const r = scan(`leaking: ${secret} !!`);
      const serialized = JSON.stringify(r.findings);
      // The whole secret, and any 8-char window of it, must be absent from the findings.
      expect(serialized).not.toContain(secret);
      for (let i = 0; i + 8 <= secret.length; i += 4) {
        expect(
          serialized.includes(secret.slice(i, i + 8)),
          `window@${i} of ${secret.slice(0, 4)}`,
        ).toBe(false);
      }
      // Evidence is the shape: "<label> · <n> chars".
      expect(r.findings[0].redactedEvidence).toMatch(/·\s\d+\schars$/);
    }
  });

  it('the redacted text replaces the secret with a labelled placeholder, keeping context', () => {
    const r = scan(`before ${GH_TOKEN} after`);
    expect(r.redacted).toBe('before «redacted:GitHub token» after');
    expect(r.redacted).not.toContain(GH_TOKEN);
  });
});

describe('canaries — a pre-seeded honeytoken leaving is critical', () => {
  const canary = 'CANARY-9f3a-do-not-emit';

  it('an occurrence of a canary is a critical finding, and the value is not echoed', () => {
    const r = scan(`the answer is ${canary} ok`, { canaries: [canary] });
    expect(r.risk).toBe('critical');
    expect(r.findings.some((f) => f.signal === 'canary')).toBe(true);
    expect(JSON.stringify(r.findings)).not.toContain(canary);
    expect(r.redacted).toBe('the answer is «redacted:canary token» ok');
  });

  it('no canary configured, no canary finding', () => {
    const r = scan(`the answer is ${canary} ok`);
    expect(r.findings.some((f) => f.signal === 'canary')).toBe(false);
  });

  it('an empty-string canary is ignored (never matches everywhere)', () => {
    const r = scan('hello world', { canaries: [''] });
    expect(r.clean).toBe(true);
  });
});

describe('multiple secrets, overlap, and summarize', () => {
  it('finds several distinct secrets and redacts each', () => {
    const r = scan(`a=${GH_TOKEN} and b=${AWS_KEY}`);
    expect(r.findings.length).toBe(2);
    expect(r.redacted).not.toContain(GH_TOKEN);
    expect(r.redacted).not.toContain(AWS_KEY);
  });

  it('a canary that coincides with a token span counts once (no double-splice)', () => {
    // The canary IS the github token here; overlap dedup keeps one span.
    const r = scan(`x ${GH_TOKEN} y`, { canaries: [GH_TOKEN] });
    expect(r.findings.length).toBe(1);
    expect((r.redacted.match(/«redacted:/g) ?? []).length).toBe(1);
  });

  it('summarize rolls up to the highest risk with distinct labels and a count', () => {
    const s = summarize([scan(`k=${GH_TOKEN}`), scan(PRIVATE_KEY), scan('nothing here')]);
    expect(s.risk).toBe('critical');
    expect(s.labels).toEqual(expect.arrayContaining(['GitHub token', 'private key block']));
    expect(s.findings).toBe(2);
  });

  it('all-clean parts summarise to none', () => {
    expect(summarize([scan('hi'), scan('bye')])).toEqual({ risk: 'none', labels: [], findings: 0 });
  });

  it('an empty scan is clean and does not crash', () => {
    const r = scan('');
    expect(r).toEqual({ findings: [], risk: 'none', redacted: '', clean: true });
  });
});

describe('purity — same input, same result across calls', () => {
  it('repeated scans on a matching input are identical (global-regex lastIndex reset)', () => {
    const input = `token ${GH_TOKEN}`;
    expect(scan(input)).toEqual(scan(input));
  });
});

// ─── the redaction-leak defects an adversarial review found (ADR-018), each pinned so it cannot regress ───
describe('redaction is EXHAUSTIVE — the union of every secret is masked, always', () => {
  it('every secret past the findings-report cap is still redacted, and a late canary is still caught (F1)', () => {
    // The report cap must bound only the findings LIST, never redaction or risk. 250 distinct AWS-shaped
    // keys then a canary: an attacker who prepends many token-shaped strings must not starve the canary.
    const key = (i: number) => `AKIA${String(i).padStart(16, '0')}`; // AKIA + 16 digits, distinct per i
    const canary = 'CANARY-late-do-not-emit';
    const many = Array.from({ length: 250 }, (_, i) => key(i)).join(' ');
    const r = scan(`${many} then ${canary}`, { canaries: [canary] });
    for (let i = 0; i < 250; i += 1) expect(r.redacted, `key ${i}`).not.toContain(key(i));
    expect(r.risk).toBe('critical'); // the canary lifted risk despite 250 prior matches
    expect(r.redacted).not.toContain(canary);
    expect(r.findings.length).toBe(200); // the REPORT is bounded, the redaction is not
  });

  it('an assignment value containing a dotted JWT is masked WHOLE — no post-dot tail leaks (F2/F3)', () => {
    const jwt = `eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(8)}`;
    const r = scan(`password=${jwt} rest`);
    expect(r.redacted).not.toContain(jwt);
    expect(r.redacted).not.toContain(`.${'b'.repeat(12)}`); // the dotted tail does not survive
    expect(r.redacted).toContain('rest'); // surrounding prose survives
  });

  it('a canary overlapping a token span masks the UNION, leaking nothing between (F2)', () => {
    // The canary shares its head with the AWS key's tail; the union of the two must be fully masked.
    const key = `AKIA${'0'.repeat(16)}`;
    const canary = `${'0'.repeat(8)}-secret-tail-xyz`;
    const r = scan(`${key}${canary.slice(8)}`, { canaries: [canary] });
    expect(r.redacted).not.toContain('secret-tail-xyz');
  });

  it('the assignment regex does not blow up on a long whitespace run (F4 — bounded, no quadratic)', () => {
    // "password" + 60k spaces + no delimiter. The bounded {0,4} whitespace means this returns promptly.
    const r = scan(`password${' '.repeat(60000)}end`);
    expect(r.clean).toBe(true); // no `:=`, so no assignment — and crucially, it returns
  });
});

describe('recall adds — bearer tokens and connection-string passwords', () => {
  it('a Bearer token is caught, and only the token (not the word Bearer) is masked', () => {
    const token = `${'A'.repeat(20)}.${'B'.repeat(10)}`;
    const r = scan(`Authorization: Bearer ${token}`);
    expect(r.findings.some((f) => f.label === 'bearer token')).toBe(true);
    expect(r.redacted).toContain('Bearer «redacted:bearer token»');
    expect(r.redacted).not.toContain(token);
  });

  it('a connection-string password is caught, and the host survives', () => {
    const pw = 'S3cretPassw0rd';
    const r = scan(`DATABASE_URL=postgres://admin:${pw}@db.internal:5432/app`);
    expect(r.findings.some((f) => f.label === 'connection string password')).toBe(true);
    expect(r.redacted).not.toContain(pw);
    expect(r.redacted).toContain('@db.internal'); // the host is not a secret
  });
});
