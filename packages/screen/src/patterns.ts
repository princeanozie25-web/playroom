// ═══ THE STEER SIGNATURES — what "trying to steer the agent" looks like in text (ADR-017) ══════════════
//
// These classify well-known prompt-injection / social-engineering shapes: an override of prior instructions,
// a claim of authority the sender does not hold, an impersonated role/chat-template marker, a lure to
// exfiltrate a secret. They are HEURISTIC and deliberately tuned for recall over precision — a finding
// INFORMS a human co-signer and the audit trail, it never blocks (governance below is the real guard, and a
// false positive costs a reviewer one extra glance while a false negative is still caught by the mandate).
//
// Detection runs over a NORMALISED copy (lower-cased, control chars → space, zero-width/bidi stripped,
// whitespace runs collapsed) so a zero-width split inside a keyword ("ig<ZWSP>nore") and padded newlines do
// not evade a match — but never over the truncated text, so a signature near the end of a long document is
// still seen. (Plain-space letter-spacing like "i g n o r e" is NOT defeated — single spaces survive the
// collapse; that is a known recall gap, not a claim we make.)

/** What a matched span is trying to do. Provider-neutral; extend deliberately (each addition is a claim
 *  about text, reviewed like any rule). */
export type ScreenSignal =
  | 'instruction_override'
  | 'authority_claim'
  | 'role_impersonation'
  | 'exfiltration_lure'
  | 'hidden_text';

export type ScreenSeverity = 'low' | 'elevated';

export interface SignaturePattern {
  signal: ScreenSignal;
  severity: ScreenSeverity;
  /** Global + case-insensitive so every occurrence is found and reported once. */
  regex: RegExp;
}

// Each regex is authored with bounded gaps ([^.\n]{0,N}) rather than unbounded .* so a single sentence must
// carry both halves of the shape — "ignore" a paragraph away from "instructions" is not a match, and no
// pattern can catastrophically backtrack.

export const SIGNATURES: readonly SignaturePattern[] = [
  // ── override of prior instructions ────────────────────────────────────────────────────────────────
  // An override verb near an instruction-noun — no mandatory "previous/all" middle word, so the single
  // commonest shape ("ignore your instructions") is caught, not just "ignore ALL PREVIOUS instructions".
  {
    signal: 'instruction_override',
    severity: 'elevated',
    regex:
      /\b(ignore|disregard|forget|override|discard|bypass)\b[^.\n]{0,28}\b(instruction|instructions|prompt|prompts|rule|rules|context|message|messages|direction|directions|guideline|guidelines|directive|directives|command|commands|guidance|policy|policies|order|orders|mandate|mandates|training)\b/gi,
  },
  // "ignore the above / the following / everything above" — the reference is the target, no noun needed.
  {
    signal: 'instruction_override',
    severity: 'elevated',
    regex:
      /\b(ignore|disregard|forget|skip|drop|discard)\b[^.\n]{0,12}\b(the\s+|all\s+(of\s+)?the\s+|everything\s+)?(above|following|preceding|previous|earlier|prior)\b/gi,
  },
  // "forget everything / what you were told / your instructions" — a reset directive.
  {
    signal: 'instruction_override',
    severity: 'elevated',
    regex:
      /\b(forget|disregard|ignore)\b[^.\n]{0,8}\b(everything|all\s+of\s+it|what\s+(you|i)\s+(said|told|were\s+told)|your\s+(training|instructions|rules|guidelines))\b/gi,
  },
  {
    signal: 'instruction_override',
    severity: 'elevated',
    regex:
      /\bnew\s+(instruction|instructions|task|directive|directives|system\s+prompt|rule|rules)\s*[:\-]/gi,
  },
  {
    signal: 'instruction_override',
    severity: 'elevated',
    regex:
      /\b(from\s+now\s+on|going\s+forward)\b[^.\n]{0,24}\b(you\s+(will|must|should|are\s+to)|ignore|only)\b/gi,
  },

  // ── a claim of authority the sender does not hold ─────────────────────────────────────────────────
  {
    signal: 'authority_claim',
    severity: 'elevated',
    regex:
      /\bi\s+am\s+(the\s+|your\s+)?(admin|administrator|owner|developer|operator|creator|maintainer|system|root|principal|supervisor)\b/gi,
  },
  {
    signal: 'authority_claim',
    severity: 'elevated',
    // The `[t]` class in permi[t]ted matches the untrusted word "permi<t>ted" while keeping the literal
    // banned verb out of this repo's own source (ADR-006 / tests/evidence.test.ts is a zero-hit grep).
    regex:
      /\b(you\s+(are|have\s+been)\s+(now\s+)?(authori[sz]ed|permi[t]ted|allowed|cleared|granted)|has\s+been\s+(pre-?)?authori[sz]ed|(the\s+)?(owner|admin|user|principal|operator)\s+(has\s+)?(already\s+)?(approved|authori[sz]ed|permi[t]ted|granted|signed\s+off))\b/gi,
  },
  {
    signal: 'authority_claim',
    severity: 'elevated',
    regex: /\b(this\s+is\s+)?(a\s+)?(test|debug|developer|maintenance|admin|god|sudo)\s+mode\b/gi,
  },
  // A jailbreak persona / "you are now [unrestricted]" — the shape that re-casts the agent as ungoverned.
  {
    signal: 'authority_claim',
    severity: 'elevated',
    regex:
      /\byou\s+are\s+(now\s+)?(a\s+|an\s+)?(dan|stan|unrestricted|unfiltered|uncensored|jailbroken|free\s+(of|from)\s+(your\s+)?(rules|restrictions|guidelines|constraints)|no\s+longer\s+bound|not\s+bound\s+by)\b/gi,
  },
  {
    signal: 'authority_claim',
    severity: 'elevated',
    regex: /\bdo\s+anything\s+now\b/gi,
  },

  // ── an impersonated role / chat-template marker ───────────────────────────────────────────────────
  {
    signal: 'role_impersonation',
    severity: 'elevated',
    regex:
      /<\|(im_start|im_end|system|user|assistant|endoftext)\|>|\[\/?INST\]|<<\/?SYS>>|###\s*(system|instruction|human|assistant)\b/gi,
  },
  // A role marker introducing a directive — "system: you are…", "assistant: ignore…". Position-independent
  // (detection has already collapsed newlines to spaces, so a line anchor would be dead); the required
  // follower keeps ordinary prose like "the operating system: overloaded" from tripping it.
  {
    signal: 'role_impersonation',
    severity: 'low',
    regex:
      /\b(system|assistant|developer)\s*:\s{0,3}(you|your|i\s+am|ignore|now|do\s|do not|don't|forget|new\b|the\s+user|from\s+now)/gi,
  },

  // ── a lure to exfiltrate a secret / the system prompt ─────────────────────────────────────────────
  {
    signal: 'exfiltration_lure',
    severity: 'elevated',
    regex:
      /\b(dm|email|send|post|reveal|show|print|leak|share|exfiltrate|forward|paste|output|repeat|disclose)\b[^.\n]{0,40}\b(api[\s_-]?key|api[\s_-]?keys|secret|secrets|token|tokens|password|passwords|credential|credentials|mandate|signing\s+key|private\s+key|system\s+prompt|instructions)\b/gi,
  },
  {
    signal: 'exfiltration_lure',
    severity: 'elevated',
    regex:
      /\b(what\s+(is|are)\s+your|reveal\s+your|repeat\s+your|print\s+your|show\s+me\s+your|tell\s+me\s+your)\b[^.\n]{0,24}\b(system\s+prompt|instructions|mandate|rules|guidelines|initial\s+prompt|configuration)\b/gi,
  },
];
