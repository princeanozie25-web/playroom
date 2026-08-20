// ═══ THE SECRET SIGNATURES — what a credential leaving in outbound text looks like (ADR-018) ══════════
//
// Egress DLP asks the mirror question to inbound screening: not "is this trying to steer me?" but "does
// this outbound content carry a secret that must not leave?". These match the well-known SHAPES of
// credentials — a private-key block, a cloud/service token, a `key = <value>` assignment, a Bearer token, a
// connection-string password, and Playroom's own internal credential. A match is redacted before it is ever
// reported (egress.ts): a DLP scanner that echoed the secret it caught would be the leak it exists to stop.
//
// Every regex uses BOUNDED quantifiers (whitespace runs capped at {0,4}; no two adjacent unbounded `\s*`)
// so an adversarial input cannot cause super-linear backtracking. Patterns that capture the secret in a
// GROUP carry the `d` flag; egress.ts reads the exact group span from `match.indices[1]`, so a secret is
// redacted precisely wherever it sits in the match — not only when it is the trailing part.

/** The kind of secret a match represents. `severity` follows: a private key or an internal credential or a
 *  canary is CRITICAL (never legitimate in outbound content); a third-party token/assignment is ELEVATED. */
export type EgressSignal = 'private_key' | 'internal_credential' | 'secret' | 'canary';

export type EgressSeverity = 'elevated' | 'critical';

export interface SecretPattern {
  signal: EgressSignal;
  severity: EgressSeverity;
  /** Human-readable name of what matched, for the redacted finding ("GitHub token", "AWS access key"). */
  label: string;
  /** Global (+ `d` when it captures a group) so every occurrence is found; the value is redacted, never raw. */
  regex: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  // ── a private key block — never legitimate in a room's outbound content ────────────────────────────
  {
    signal: 'private_key',
    severity: 'critical',
    label: 'private key block',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },

  // ── Playroom's OWN credential — a member token leaving is an internal-credential exfiltration ───────
  {
    signal: 'internal_credential',
    severity: 'critical',
    label: 'Playroom credential token',
    regex: /\bprm_[A-Za-z0-9]{16,}\b/g,
  },

  // ── third-party service / cloud tokens (each a distinct, recognisable prefix shape) ────────────────
  {
    signal: 'secret',
    severity: 'elevated',
    label: 'AWS access key id',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    signal: 'secret',
    severity: 'elevated',
    label: 'GitHub token',
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/g,
  },
  {
    signal: 'secret',
    severity: 'elevated',
    label: 'Slack token',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    signal: 'secret',
    severity: 'elevated',
    label: 'Google API key',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    signal: 'secret',
    severity: 'elevated',
    label: 'Stripe key',
    regex: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  },
  {
    signal: 'secret',
    severity: 'elevated',
    label: 'AI provider key',
    regex: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    signal: 'secret',
    severity: 'elevated',
    label: 'JSON Web Token',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g,
  },
  // A `Authorization: Bearer <token>` header — the token is captured in group 1 so "Bearer" survives.
  {
    signal: 'secret',
    severity: 'elevated',
    label: 'bearer token',
    regex: /\bBearer\s{1,4}["']?([A-Za-z0-9._~+/=-]{16,})/dg,
  },
  // A connection string with an inline password: scheme://user:<password>@host. Group 1 is the password,
  // which is NOT the trailing part of the match — the `d` flag + indices[1] redact exactly it.
  {
    signal: 'secret',
    severity: 'elevated',
    label: 'connection string password',
    regex: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@]{1,64}:([^\s:/@]{6,})@/dgi,
  },

  // ── a `secret = <value>` assignment — the generic catch, requiring a secret-ish KEY next to a value ─
  // The value is a contiguous non-whitespace/quote run (so a dotted secret like a JWT or "abc.def" is
  // captured whole, not truncated at the first dot), captured in group 1 so only IT is redacted. Whitespace
  // is bounded ({0,4}) so the two runs around the optional quote cannot enumerate O(n²) splits.
  {
    signal: 'secret',
    severity: 'elevated',
    label: 'secret assignment',
    regex:
      /\b(?:api[_-]?key|secret|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\b\s{0,4}["']?\s{0,4}[:=]\s{0,4}["']?([^\s"'`]{16,})/dgi,
  },
];
