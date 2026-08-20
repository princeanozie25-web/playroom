import { SIGNATURES, type ScreenSignal, type ScreenSeverity } from './patterns.js';

// ═══ INBOUND SCREENING — one seam every external text passes before it can steer an agent (ADR-017) ════
//
// Untrusted text — an X mention, an uploaded document, a bridged payload — enters a room as DATA, never as
// a directive. This is the single point that (1) NEUTRALISES it into inert, quoted text a model may be shown
// (control chars → spaces, invisible/bidi dropped, whitespace collapsed, length capped — behaviour-compatible
// with the original grokbot `screenExternalText`), and (2) CLASSIFIES any attempt to steer the agent into
// structured findings that ride WITH the proposal (grokbot's ProposedReply) and onto the room-visible event
// (a document's `document.added`), so a reader sees what the input tried to do. (Binding a finding into the
// tamper-evident receipt/decision is a further, separately-reviewed step — see ADR-017's honest limits.)
//
// It is defence-in-depth and audit context — NOT an authorisation boundary. It blocks nothing. A finding is
// heuristic; the mandate + co-signature remain the real guard (RT-005: the fabric decides and executes on the
// governed action, not on a regex verdict). Coupling screening risk to authorisation is a deliberate,
// separately-reviewed step (surface it as a governed fact) — this seam only produces the fact.

/** Zero-width and word-joiner code points: invisible, and a classic way to smuggle or split tokens. */
const INVISIBLE = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad]);
/** Bidirectional-override code points: can visually reorder text so what a human reads differs from bytes. */
const BIDI = new Set([0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]);

/** At most this many findings are reported; beyond it the text is already damning and the list stays bounded. */
const MAX_FINDINGS = 24;

export type { ScreenSignal, ScreenSeverity } from './patterns.js';

export interface ScreenFinding {
  signal: ScreenSignal;
  severity: ScreenSeverity;
  /** A short, single-line excerpt of the matched span, safe to show a human reviewer. */
  evidence: string;
  /** UTF-16 code-unit offset of the match within the detection-normalised text (lower-cased,
   *  whitespace-collapsed). Used to order findings for display; not a byte or code-point index. */
  at: number;
}

export interface ScreenResult {
  /** The neutralised text a model may be shown: inert, quoted DATA. Never a directive. */
  safe: string;
  /** Classified attempts to steer the agent, found in the raw text. Empty when nothing matched. */
  findings: ScreenFinding[];
  /** The highest severity present — one value a receipt or a governed fact can key on. */
  risk: 'none' | 'low' | 'elevated';
  /** What the neutralisation changed, for the audit trail. */
  neutralized: {
    originalLength: number;
    controlCharsReplaced: number;
    /** Count of invisible (zero-width/word-joiner/BOM) AND bidi-override code points dropped. */
    invisibleCharsStripped: number;
    truncated: boolean;
  };
}

export interface ScreenOptions {
  /** Cap the neutralised text length (default 600, matching the original screenExternalText). */
  maxLen?: number;
}

const DEFAULT_MAX_LEN = 600;

/** Tab, newline, carriage return — the C0 control chars that are ordinary formatting, not obfuscation. */
const WHITESPACE_CONTROL = new Set([0x09, 0x0a, 0x0d]);

interface Cleaned {
  /** control chars → space, invisible/bidi DROPPED, whitespace collapsed, trimmed. Not lower-cased, not capped. */
  collapsed: string;
  /** every C0/DEL char replaced by a space (includes newlines/tabs) — what neutralisation changed. */
  controlChars: number;
  /** the SUSPICIOUS subset: C0/DEL that is NOT tab/newline/CR. A long document has many newlines and zero of
   *  these, so this — not the raw control count — is what signals deliberate obfuscation. */
  suspiciousControl: number;
  invisible: number;
  bidi: number;
}

/** One pass over the raw text. Both the model-facing `safe` and the detection form derive from this, so
 *  what a model sees and what the signatures run against never disagree about which characters are present. */
function clean(text: string): Cleaned {
  let out = '';
  let controlChars = 0;
  let suspiciousControl = 0;
  let invisible = 0;
  let bidi = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (INVISIBLE.has(code)) {
      invisible += 1;
      continue; // drop it — invisible glue is never content, and "ze​roing" must read as "zeroing"
    }
    if (BIDI.has(code)) {
      bidi += 1;
      continue; // drop it — a visual reorder is never content a model should honour
    }
    if (code < 0x20 || code === 0x7f) {
      out += ' ';
      controlChars += 1;
      if (!WHITESPACE_CONTROL.has(code)) suspiciousControl += 1;
    } else {
      out += ch;
    }
  }
  return {
    collapsed: out.replace(/\s+/g, ' ').trim(),
    controlChars,
    suspiciousControl,
    invisible,
    bidi,
  };
}

/** A short, single-line excerpt for a human reviewer — the match itself, capped. */
function evidenceOf(match: string): string {
  const oneLine = match.replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}

/**
 * Screen one piece of untrusted external text. Pure and deterministic: same input, same result, on any
 * machine. Returns the neutralised text to show a model, the classified findings, and an aggregate risk.
 */
export function screen(text: string, opts: ScreenOptions = {}): ScreenResult {
  const maxLen = opts.maxLen ?? DEFAULT_MAX_LEN;
  const { collapsed, controlChars, suspiciousControl, invisible, bidi } = clean(text);
  // Cap by CODE POINT, not code unit, so a boundary landing mid-surrogate-pair never leaves a lone surrogate
  // (a replacement-char blot) at the end of the reviewer-facing text. `truncated` uses the same unit as the
  // slice, so the ellipsis is appended only when text was actually dropped.
  const points = [...collapsed];
  const truncated = points.length > maxLen;
  const safe = truncated ? `${points.slice(0, maxLen).join('')}…` : collapsed;
  const normalized = collapsed.toLowerCase(); // detection runs over the FULL text, never the truncated safe copy

  // Collect raw matches with their span [at, end). Several signatures overlap by design (a phrase with both
  // a reference word and an instruction-noun trips more than one), so the same textual threat can match twice.
  const raw: (ScreenFinding & { end: number })[] = [];
  for (const sig of SIGNATURES) {
    // Fresh lastIndex per call: a global regex is stateful, and this function must be reentrant.
    sig.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = sig.regex.exec(normalized)) !== null) {
      raw.push({
        signal: sig.signal,
        severity: sig.severity,
        evidence: evidenceOf(m[0]),
        at: m.index,
        end: m.index + m[0].length,
      });
      if (m.index === sig.regex.lastIndex) sig.regex.lastIndex += 1; // guard a zero-width match
      if (raw.length >= MAX_FINDINGS) break;
    }
    if (raw.length >= MAX_FINDINGS) break;
  }

  // Dedupe overlapping matches of the SAME signal so one threat is counted once, not once per rule that fired
  // on it. Longest span wins on a tie (it is the most informative evidence). Different signals never suppress
  // each other — "ignore … I am the admin" is two distinct findings.
  raw.sort((a, b) => a.at - b.at || b.end - a.end);
  const findings: ScreenFinding[] = [];
  const keptSpans: (ScreenFinding & { end: number })[] = [];
  for (const f of raw) {
    const overlaps = keptSpans.some((k) => k.signal === f.signal && f.at < k.end && k.at < f.end);
    if (overlaps) continue;
    keptSpans.push(f);
    findings.push({ signal: f.signal, severity: f.severity, evidence: f.evidence, at: f.at });
  }

  // Hidden-text: invisible/bidi characters, or NON-whitespace control chars (NUL, BEL, escape…), signal
  // deliberate obfuscation. Newlines and tabs do NOT count — a long document is full of them and is not
  // hiding anything. Low on its own (it hides, it does not itself direct) — but it lifts the aggregate risk.
  if (findings.length < MAX_FINDINGS && (invisible > 0 || bidi > 0 || suspiciousControl > 0)) {
    const parts: string[] = [];
    if (invisible > 0) parts.push(`${invisible} invisible`);
    if (bidi > 0) parts.push(`${bidi} bidi-override`);
    if (suspiciousControl > 0) parts.push(`${suspiciousControl} control`);
    findings.push({
      signal: 'hidden_text',
      severity: 'low',
      evidence: `${parts.join(', ')} character(s) stripped`,
      at: 0,
    });
  }

  findings.sort((a, b) => a.at - b.at);

  const risk: ScreenResult['risk'] = findings.some((f) => f.severity === 'elevated')
    ? 'elevated'
    : findings.length > 0
      ? 'low'
      : 'none';

  return {
    safe,
    findings,
    risk,
    neutralized: {
      originalLength: [...text].length,
      controlCharsReplaced: controlChars,
      invisibleCharsStripped: invisible + bidi,
      truncated,
    },
  };
}

/**
 * Back-compat: the neutralised text only — a drop-in for the original `screenExternalText(text, maxLen)`.
 * Prefer {@link screen} where the findings and risk matter (a governed cycle, a document ingest).
 */
export function neutralize(text: string, maxLen = DEFAULT_MAX_LEN): string {
  return screen(text, { maxLen }).safe;
}

/** A compact roll-up of one or more screened texts — small enough to ride in an event payload or a
 *  receipt. `signals` is the DISTINCT set of what the text(s) tried to do; `findings` is the total count. */
export interface ScreeningSummary {
  risk: 'none' | 'low' | 'elevated';
  signals: ScreenSignal[];
  findings: number;
}

/**
 * Roll several {@link ScreenResult}s (e.g. a mention plus every post in its thread, or one document) into a
 * single summary. The aggregate risk is the highest of any part — one steer shape anywhere lifts the whole.
 */
export function summarize(results: readonly ScreenResult[]): ScreeningSummary {
  const findings = results.flatMap((r) => r.findings);
  const signals = [...new Set(findings.map((f) => f.signal))];
  const risk: ScreeningSummary['risk'] = findings.some((f) => f.severity === 'elevated')
    ? 'elevated'
    : findings.length > 0
      ? 'low'
      : 'none';
  return { risk, signals, findings: findings.length };
}
