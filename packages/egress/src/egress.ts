import { SECRET_PATTERNS, type EgressSignal, type EgressSeverity } from './patterns.js';

// ═══ EGRESS DLP — nothing leaves without passing this (ADR-018) ═══════════════════════════════════════
//
// The mirror of inbound screening: that seam asks whether text ENTERING tries to steer the agent; this one
// asks whether text LEAVING carries a secret. `scan(text, {canaries})` finds credentials by shape (private
// keys, cloud/service tokens, a `key = <value>` assignment, Playroom's own `prm_` credential) and any
// pre-seeded canary, and returns (a) findings that carry NO secret bytes — only a label and a length — and
// (b) a `redacted` copy of the text with every secret masked in place, safe to log, show, or receipt.
//
// The one discipline that makes a DLP scanner trustworthy: it must never echo the secret it caught. A finding
// that quoted the matched token would be the leak it exists to prevent. So evidence here is `<label> · <n>
// chars`, and the full-text output is masked — the human sees WHERE and WHAT KIND, never the value.
//
// Like inbound screening it INFORMS and RECORDS; it is not itself the gate. A grokbot reply is already
// co-signed by a human, and the egress summary rides to that co-signer so they decline a draft that leaks.
// A canary or a private key leaving is a CRITICAL signal a reviewer should never approve — but making the
// fabric hard-BLOCK on it is a mandate/fact change (ADR-018 honest limits), deliberately deferred.

export type { EgressSignal, EgressSeverity } from './patterns.js';

export interface EgressFinding {
  signal: EgressSignal;
  severity: EgressSeverity;
  /** What kind of secret matched, e.g. "GitHub token". Safe to show — carries no secret bytes. */
  label: string;
  /** Redacted evidence: the label and the secret's length ONLY. Never any character of the secret itself. */
  redactedEvidence: string;
  /** UTF-16 code-unit offset of the secret within the input. Orders findings; not a byte/code-point index. */
  at: number;
}

export interface EgressResult {
  findings: EgressFinding[];
  /** Highest severity present. `none` means nothing matched. */
  risk: 'none' | 'elevated' | 'critical';
  /** The input with every detected secret replaced by «redacted:<label>» — safe to log, show, or receipt. */
  redacted: string;
  /** True iff nothing was detected — the convenience answer to "is this clean to send?". */
  clean: boolean;
}

export interface EgressOptions {
  /** Exact secret strings pre-seeded as canaries. Any occurrence is a CRITICAL exfiltration signal — a
   *  canary is a value that has no legitimate reason to ever appear in outbound content. */
  canaries?: readonly string[];
}

/** At most this many findings are REPORTED in the list; redaction and risk always cover EVERY detected
 *  secret regardless of this cap (a cap that limited redaction would leave secrets in the "safe" text). */
const MAX_FINDINGS = 200;

interface Span {
  start: number;
  end: number;
  signal: EgressSignal;
  severity: EgressSeverity;
  label: string;
}

/** A match carrying `RegExpIndicesArray` when the pattern used the `d` flag. Typed defensively so the code
 *  does not depend on the lib exposing `RegExpExecArray.indices`. */
type MatchWithIndices = RegExpExecArray & { indices?: Array<[number, number] | undefined> };

const RANK: Record<EgressSeverity, number> = { elevated: 1, critical: 2 };

/** The exact span of the secret in the match. If the pattern captured a group (the `d` flag gives its exact
 *  offsets via `indices[1]`), redact ONLY that — so "password = <value>" masks the value, not the keyword,
 *  and a group that is not the match's suffix (a connection-string password) is still masked precisely.
 *  Otherwise the whole match is the secret. */
function secretSpan(m: RegExpExecArray): { start: number; end: number } {
  const gi = (m as MatchWithIndices).indices?.[1];
  if (gi) return { start: gi[0], end: gi[1] };
  return { start: m.index, end: m.index + m[0].length };
}

/**
 * Scan outbound text for secrets. Pure and deterministic. Returns findings that carry no secret bytes and a
 * redacted copy of the text. `opts.canaries` adds exact-match honeytokens as critical findings.
 *
 * Correctness rests on one rule: redaction and risk cover the UNION of every detected secret. Overlapping
 * matches are MERGED (not one dropped), so a secret's tail can never survive past a kept span; the reported
 * `findings` list is the only thing the cap bounds.
 */
export function scan(text: string, opts: EgressOptions = {}): EgressResult {
  const spans: Span[] = [];

  // Signature matches.
  for (const p of SECRET_PATTERNS) {
    p.regex.lastIndex = 0; // reentrancy: a global regex is stateful; reset before every use
    let m: RegExpExecArray | null;
    while ((m = p.regex.exec(text)) !== null) {
      const { start, end } = secretSpan(m);
      if (end > start)
        spans.push({ start, end, signal: p.signal, severity: p.severity, label: p.label });
      if (m.index === p.regex.lastIndex) p.regex.lastIndex += 1; // guard a zero-width match
    }
  }

  // Canaries — exact substring matches. A canary leaving is categorically critical. Advance by ONE so a
  // self-overlapping canary is fully covered once the spans below are merged.
  for (const canary of opts.canaries ?? []) {
    if (!canary) continue; // an empty canary would "match" everywhere; ignore it
    let idx = text.indexOf(canary);
    while (idx !== -1) {
      spans.push({
        start: idx,
        end: idx + canary.length,
        signal: 'canary',
        severity: 'critical',
        label: 'canary token',
      });
      idx = text.indexOf(canary, idx + 1);
    }
  }

  // Merge overlapping spans into their UNION so redaction covers every secret byte — the whole point. The
  // merged span takes the most severe component's signal/label (so a canary inside a token still reads
  // critical). Adjacent-but-not-overlapping spans stay separate (no gap to leak).
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start < last.end) {
      if (s.end > last.end) last.end = s.end;
      if (RANK[s.severity] > RANK[last.severity]) {
        last.severity = s.severity;
        last.signal = s.signal;
        last.label = s.label;
      }
    } else {
      merged.push({ ...s });
    }
  }

  // One forward pass: redact EVERY merged span; report the first MAX_FINDINGS of them (redaction and risk
  // are exhaustive — only the reported list is bounded). Findings carry no secret bytes.
  const findings: EgressFinding[] = [];
  let redacted = '';
  let cursor = 0;
  for (const s of merged) {
    if (findings.length < MAX_FINDINGS) {
      findings.push({
        signal: s.signal,
        severity: s.severity,
        label: s.label,
        redactedEvidence: `${s.label} · ${s.end - s.start} chars`,
        at: s.start,
      });
    }
    redacted += text.slice(cursor, s.start) + `«redacted:${s.label}»`;
    cursor = s.end;
  }
  redacted += text.slice(cursor);

  const risk: EgressResult['risk'] = merged.some((s) => s.severity === 'critical')
    ? 'critical'
    : merged.length > 0
      ? 'elevated'
      : 'none';

  return { findings, risk, redacted: merged.length ? redacted : text, clean: merged.length === 0 };
}

/** A compact roll-up of one or more egress scans — small enough for an event payload or a receipt. Carries
 *  the aggregate risk, the distinct labels seen, and the total count. No secret bytes, by construction. */
export interface EgressSummary {
  risk: 'none' | 'elevated' | 'critical';
  labels: string[];
  findings: number;
}

export function summarize(results: readonly EgressResult[]): EgressSummary {
  const findings = results.flatMap((r) => r.findings);
  const labels = [...new Set(findings.map((f) => f.label))];
  const risk: EgressSummary['risk'] = findings.some((f) => f.severity === 'critical')
    ? 'critical'
    : findings.length > 0
      ? 'elevated'
      : 'none';
  return { risk, labels, findings: findings.length };
}
