import { Writable } from 'node:stream';
import { inspect } from 'node:util';

// ── THE LOG SCRUBBER (S-SCRUB, SLIVE-N3) ─────────────────────────────────────────────────────
//
// SCRUB THE PAYLOAD, NOT THE FIELD. SLIVE-N3: a provider key rode into Fly's logs inside an error
// object nobody named, past the path-based `redact` (which lists field paths). The lesson is that a
// secret can arrive anywhere — a nested error's `.message`, a stack frame, a `cause` chain — and any
// scrubber keyed on FIELD NAMES will miss the one field nobody thought to name.
//
// So this operates at the SINK, on the whole SERIALIZED line. By the time pino hands a line to the
// destination, message, stack, nested error and cause chain are ALL text — one pass over that text
// cannot be evaded by nesting or by a field name. Over-redaction is the safe direction: a redacted
// hash costs a log line; a leaked key costs a credential. The one thing this may never do is let an
// unscrubbed line through, which is why the sink wrapper below is fail-closed.

const MARKER = '\u0000REDACTED\u0000'; // an internal placeholder no real payload contains; stamped with a count at the end

// SECRET SHAPES. Specific prefixes first. Each is a plain character class — no `.*` lookaheads — so
// none can backtrack pathologically on a crafted line (no ReDoS).
const SHAPE_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{6,}/g, // 'sk-ant-' prefixed vendor key
  /sk-proj-[A-Za-z0-9_-]{6,}/g, // 'sk-proj-' prefixed vendor key
  /sk-[A-Za-z0-9]{20,}/g, // bare 'sk-' + 20 char vendor key
  /plr_cnry_[A-Za-z0-9]+/g, // the canary — a tripwire and the tests' handle
  /prm_[A-Za-z0-9]{16,}/g, // Playroom member credential
];

// The GENERAL long-opaque-token net: 40+ chars of token alphabet. A simple class (ReDoS-free); the
// "is this actually a secret" judgement lives in the replace callback below, not in the regex.
const GENERAL_TOKEN = /[A-Za-z0-9_-]{40,}/g;

/** All-lowercase-hex is a hash or an id (sha256, prompt_hash, event ids) — safe to log, and the
 *  telemetry depends on it. A real secret carries mixed case, a digit-and-letter mix, or a prefix. */
function isBenignToken(t: string): boolean {
  return /^[0-9a-f]+$/.test(t); // pure lowercase hex → keep
}

/** Escape a literal secret value for use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The exact VALUES of credential-shaped env vars, snapshotted ONCE at process start. This is the
 * precise net: it redacts the ACTUAL secrets — the real keys, the `DATABASE_URL` with its password —
 * by value, with zero false positives, no matter what shape they are or where they land. `process.env`
 * does not change under us, so reading it per line would be waste; and a value shorter than 8 chars is
 * not treated as a secret (it would redact half the log).
 */
export function snapshotEnvSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  // The SAME secret-name definition pino's path redaction uses (server.ts:146). Two nets with two
  // different ideas of "which env name is a secret" is precisely the disagreement that let SLIVE-N3
  // through; this snapshot must be no narrower than the redaction it backstops. `_KEY` (not just
  // `_API_KEY`), `PASSWORD` and `CONNECTION_STRING` join, in the safe over-redaction direction.
  const nameLooksSecret = /(_KEY|_TOKEN|_SECRET|PASSWORD|DATABASE_URL|CONNECTION_STRING)$/i;
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (v && v.length >= 8 && nameLooksSecret.test(k)) out.push(v);
  }
  // Longest first, so a value that contains another (a URL embedding a token) redacts whole.
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}

export interface Scrubber {
  scrub(line: string): { text: string; count: number };
}

/**
 * Build a scrubber. `envSecrets` is injected (default: the process snapshot) so tests seed synthetic
 * values and never a real one. Env values run first (exact), then the shape prefixes, then the general
 * net — and the count accumulates across all, so the marker can report HOW MUCH fired.
 */
export function makeScrubber(envSecrets: string[] = snapshotEnvSecrets()): Scrubber {
  const envPatterns = envSecrets.map((v) => new RegExp(escapeRe(v), 'g'));
  return {
    scrub(line: string): { text: string; count: number } {
      let count = 0;
      let text = line;
      const bump = (): string => {
        count += 1;
        return MARKER;
      };
      for (const re of envPatterns) text = text.replace(re, bump);
      for (const re of SHAPE_PATTERNS) text = text.replace(re, bump);
      text = text.replace(GENERAL_TOKEN, (m) => (isBenignToken(m) ? m : bump()));
      // Stamp the count onto every marker, so an operator sees THAT scrubbing fired and how much.
      if (count > 0) text = text.split(MARKER).join(`[REDACTED:${count}]`);
      return { text, count };
    },
  };
}

export interface ScrubStreamStats {
  scrub_errors: number;
}

/**
 * THE SINK WRAPPER, FAIL-CLOSED. Every serialized line is scrubbed before it reaches `dest`. If the
 * scrubber itself throws, the line is DROPPED — never written raw — and a PAYLOAD-FREE marker is
 * written in its place plus a `scrub_errors` counter bumped, so "the scrubber broke" is a visible,
 * evented fact (Bible §14 shape) and is distinguishable from "nothing needed scrubbing". An
 * unscrubbed line must never be the fallback: that is the whole point of a scrubber.
 */
export function makeScrubStream(
  dest: NodeJS.WritableStream,
  scrubber: Scrubber = makeScrubber(),
): { stream: Writable; stats: ScrubStreamStats } {
  const stats: ScrubStreamStats = { scrub_errors: 0 };
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb): void {
      const raw = chunk.toString();
      try {
        dest.write(scrubber.scrub(raw).text);
      } catch {
        stats.scrub_errors += 1;
        dest.write(
          JSON.stringify({
            level: 50,
            msg: 'log line dropped: scrub_error',
            scrub_errors: stats.scrub_errors,
          }) + '\n',
        );
      }
      cb();
    },
  });
  return { stream, stats };
}

/**
 * Serialize a thrown value the way stderr would render it — stack AND every enumerable own-property —
 * then scrub the whole payload. The own-properties matter: an ERR_INVALID_URL carries the entire
 * connection string on its `.input`, a field NOBODY NAMED, exactly the SLIVE-N3 shape. `inspect` runs
 * inside the try, so even a hostile getter cannot leak: fail-closed returns a payload-free string,
 * never the raw serialization.
 */
export function scrubError(err: unknown, scrubber: Scrubber = makeScrubber()): string {
  try {
    return scrubber.scrub(inspect(err, { depth: 4 })).text;
  } catch {
    return 'error (scrub failed, payload dropped)';
  }
}

/**
 * THE OTHER SINK, FAIL-CLOSED. `makeScrubStream` wraps pino's destination — but an error can reach the
 * process's stderr WITHOUT passing through pino: a synchronous throw on the boot path (a malformed
 * DATABASE_URL makes `new URL()` throw an ERR_INVALID_URL whose `.input` is the whole connection
 * string), an unhandled rejection, or Node's own default handler. Left alone, Node prints any of these
 * RAW to fd 2 → Fly logs. These handlers serialize + scrub the whole payload first, then fail the
 * process (an unhandled error is not survivable). This closes the SLIVE-N3 threat model — a secret
 * inside an error nobody named — at the sink the stream wrapper cannot reach.
 */
export function installProcessScrubGuards(
  scrubber: Scrubber = makeScrubber(),
  stderr: NodeJS.WritableStream = process.stderr,
): void {
  const fail = (label: string, err: unknown): void => {
    stderr.write(`${label}: ${scrubError(err, scrubber)}\n`);
    process.exit(1);
  };
  process.on('uncaughtException', (err) => fail('uncaughtException', err));
  process.on('unhandledRejection', (reason) => fail('unhandledRejection', reason));
}
