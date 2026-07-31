import { afterEach, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { buildServer } from '../src/server.js';
import {
  installProcessScrubGuards,
  makeScrubber,
  makeScrubStream,
  scrubError,
  snapshotEnvSecrets,
  type Scrubber,
} from '../src/scrub.js';

/**
 * ═══ S-SCRUB / SLIVE-N3 — the log scrubber, asserted as a MECHANISM ═══
 *
 * SCRUB THE PAYLOAD, NOT THE FIELD. A provider key rode into the logs inside an error field nobody
 * named, past the path-based redaction. These tests assert the mechanism that stops that: every secret
 * SHAPE, in every error-path SHAPE, comes out marked and counted and never raw — and if the scrubber
 * itself throws, the line is dropped rather than leaked.
 *
 * NO REAL SECRET APPEARS HERE. Every seeded value is synthetic, carrying "SYNTH" so it can never be
 * confused for a live key. A zero-leak assertion reports its denominator: N seeded values × M error
 * paths, below.
 */

// N = 7 synthetic secrets, one per pattern category the scrubber covers. Each carries "SYNTH".
const SECRETS: Record<string, string> = {
  anthropic: 'sk-ant-SYNTHwwwwwwwwwwwwwwwwwwww',
  openaiProject: 'sk-proj-SYNTHwwwwwwwwwwwwwwwwwww',
  openaiLegacy: 'sk-SYNTHETICLEGACYKEYwwwwwwwwww', // sk- + 20+
  canary: 'plr_cnry_SYNTH0000',
  memberCredential: 'prm_SYNTHmemberCredwwwwww', // prm_ + 16+
  generalOpaqueToken: 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2Mm3Nn4Oo5', // 45, mixed case+digit, not hex
  envValueByExactMatch: 'synthetic-env-value-not-a-real-secret-1234567890ABC',
};
const N = Object.keys(SECRETS).length;

// M = 5 error-path SHAPES a secret can hide in, as pino would serialize them. Each puts the secret in
// a different structural place: the message, a nested object field (the warm-up shape), an Error's
// serialized message, a stack frame, and a cause chain.
function shapes(secret: string): Record<string, string> {
  return {
    bareMessage: JSON.stringify({ level: 30, msg: `key ${secret} was rejected` }),
    nestedObjectField: JSON.stringify({
      level: 40,
      failed: [{ target: 'claude-main', error: secret }],
    }),
    errorMessage: JSON.stringify({
      level: 50,
      err: { type: 'TypeError', message: `Headers.append ${secret}` },
    }),
    stackFrame: JSON.stringify({
      level: 50,
      err: { stack: `Error: x\n    at fn (${secret}:1:1)` },
    }),
    causeChain: JSON.stringify({
      level: 50,
      err: { message: 'outer', cause: { message: `inner ${secret}` } },
    }),
  };
}
const M = Object.keys(shapes('x')).length;

// The scrubber for the corpus test: the env value is INJECTED (never read from a real process.env).
const scrubber: Scrubber = makeScrubber([SECRETS.envValueByExactMatch]);

describe('the scrubber redacts every secret shape in every error-path shape', () => {
  it(`no seeded secret survives, and the marker carries the count — corpus N=${N} × M=${M}`, () => {
    let placements = 0;
    for (const secret of Object.values(SECRETS)) {
      for (const line of Object.values(shapes(secret))) {
        placements += 1;
        const { text, count } = scrubber.scrub(line);
        // (b) the seeded value appears ZERO times in the sink output, over this placement.
        expect(text, `secret survived in: ${line.slice(0, 40)}`).not.toContain(secret);
        // Belt-and-braces: even a SYNTH substring must not leak (catches a partial redaction).
        expect(text).not.toContain('SYNTH');
        // (a) the marker fired, carrying a count — exactly one secret per line here.
        expect(text).toContain('[REDACTED:1]');
        expect(count).toBe(1);
      }
    }
    expect(placements, 'denominator').toBe(N * M); // 7 × 5 = 35 seeded placements, all scrubbed
  });

  it('the count IS the number redacted — three secrets in one line → [REDACTED:3]', () => {
    const line = JSON.stringify({
      a: SECRETS.anthropic,
      b: SECRETS.openaiProject,
      c: SECRETS.canary,
    });
    const { text, count } = scrubber.scrub(line);
    expect(count).toBe(3);
    expect(text).toContain('[REDACTED:3]');
    expect(text).not.toContain('SYNTH');
  });

  it('a lowercase-hex hash is KEPT — the telemetry (prompt_hash) must survive', () => {
    const hash = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2'; // 64 hex
    const { text, count } = scrubber.scrub(JSON.stringify({ prompt_hash: hash }));
    expect(count).toBe(0);
    expect(text).toContain(hash);
  });
});

describe('the wired sink scrubs real pino output (server.ts logger)', () => {
  function capture(): { lines: string[]; stream: Writable } {
    const lines: string[] = [];
    const stream = new Writable({
      write(c: Buffer | string, _e, cb): void {
        lines.push(c.toString());
        cb();
      },
    });
    return { lines, stream };
  }
  const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

  it('scrubs a warm-up-shaped object, an Error+stack, and a cause chain through the real logger', async () => {
    const { lines, stream } = capture();
    const app = buildServer({ loggerStream: stream }); // no DB; only the logger is exercised
    try {
      // The exact shape SLIVE-N3 leaked through: a structured warm-up failure with the key in `error`.
      app.log.warn(
        { failed: [{ target: 'claude-main', error: `Headers.append ${SECRETS.anthropic}` }] },
        'warm-up incomplete',
      );
      // A real Error (pino serializes message + stack) carrying a secret in its message.
      app.log.error({ err: new Error(`boom ${SECRETS.openaiProject}`) }, 'send failed');
      await flush();
      const out = lines.join('');
      expect(out, 'a secret survived the real sink').not.toContain('SYNTH');
      expect(out).toContain('[REDACTED:'); // the marker fired at the real sink
    } finally {
      await app.close();
    }
  });
});

describe('fail-closed: if the scrubber throws, the line is dropped, never leaked', () => {
  it('a throwing scrubber → payload-free marker + counter, and the raw line never reaches the sink', () => {
    const throwing: Scrubber = {
      scrub() {
        throw new Error('scrubber boom'); // engineered throw; a >512MB line would be the natural trigger
      },
    };
    const lines: string[] = [];
    const dest = new Writable({
      write(c: Buffer | string, _e, cb): void {
        lines.push(c.toString());
        cb();
      },
    });
    const { stream, stats } = makeScrubStream(dest, throwing);
    stream.write(
      JSON.stringify({ secret: SECRETS.anthropic, msg: 'this must never appear raw' }) + '\n',
    );

    const out = lines.join('');
    expect(out, 'the raw secret leaked on scrubber failure').not.toContain('SYNTH');
    expect(out, 'no payload survived the drop').not.toContain('this must never appear raw');
    expect(out).toContain('scrub_error'); // the drop is its own evented fact
    expect(stats.scrub_errors).toBe(1); // and it is counted, distinguishably
  });
});

describe('scrubError closes the OTHER sink — an error nobody named, reaching stderr', () => {
  it('an ERR_INVALID_URL whose .input is a connection string is scrubbed whole', () => {
    // The exact vector all three review angles confirmed: a malformed DATABASE_URL makes `new URL()`
    // throw, and the thrown error carries the WHOLE connection string on its enumerable `.input`. No
    // named field — pino's path redaction cannot see it; the whole-payload scrub of the serialized
    // error must. The env snapshot holds the same value the boot path would (exact match).
    const synthDbUrl = 'postgres://neondb_owner:npg_SYNTHpw000000000@ep-x.neon.tech:5432/db';
    let urlErr: unknown;
    try {
      new URL('has a space ' + synthDbUrl); // invalid → throws ERR_INVALID_URL with .input set
    } catch (e) {
      urlErr = e;
    }
    const out = scrubError(urlErr, makeScrubber([synthDbUrl]));
    expect(out, 'the connection string survived on .input').not.toContain('SYNTH');
    expect(out).toContain('[REDACTED:');
  });

  it('fail-closed: if the scrubber throws, the raw error is dropped, never returned', () => {
    const throwing: Scrubber = {
      scrub() {
        throw new Error('scrubber boom');
      },
    };
    const err = new Error(`boom ${SECRETS.anthropic}`);
    const out = scrubError(err, throwing);
    expect(out, 'the raw error leaked on scrub failure').not.toContain('SYNTH');
    expect(out, 'the error message leaked on scrub failure').not.toContain('boom');
  });
});

describe('installProcessScrubGuards registers a scrubbed handler at each stderr-bound sink', () => {
  it('adds one uncaughtException and one unhandledRejection listener', () => {
    const ueBefore = process.listenerCount('uncaughtException');
    const urBefore = process.listenerCount('unhandledRejection');
    installProcessScrubGuards(makeScrubber([SECRETS.envValueByExactMatch]));
    // Grab exactly the two we just added so we can remove them — the handlers call process.exit,
    // and a leftover would kill the suite on the next stray rejection.
    const ueAdded = process.listeners('uncaughtException').at(-1) as (...a: unknown[]) => void;
    const urAdded = process.listeners('unhandledRejection').at(-1) as (...a: unknown[]) => void;
    try {
      expect(process.listenerCount('uncaughtException')).toBe(ueBefore + 1);
      expect(process.listenerCount('unhandledRejection')).toBe(urBefore + 1);
    } finally {
      process.removeListener('uncaughtException', ueAdded);
      process.removeListener('unhandledRejection', urAdded);
    }
  });
});

describe('the env snapshot is no narrower than pino’s secret-name redaction (server.ts:146)', () => {
  it('snapshots *PASSWORD, *CONNECTION_STRING and *_KEY values, not just *_API_KEY', () => {
    const secrets = snapshotEnvSecrets({
      DB_PASSWORD: 'synthetic-password-value-1234',
      APP_CONNECTION_STRING: 'postgres://synthetic-conn-string-value-xyz',
      SIGNING_KEY: 'synthetic-signing-key-value-5678', // *_KEY, not *_API_KEY
      PATH: '/usr/bin', // not secret-named → never snapshotted
    } as unknown as NodeJS.ProcessEnv);
    expect(secrets).toContain('synthetic-password-value-1234');
    expect(secrets).toContain('postgres://synthetic-conn-string-value-xyz');
    expect(secrets).toContain('synthetic-signing-key-value-5678');
    expect(secrets).not.toContain('/usr/bin');
  });
});

afterEach(() => {
  /* no shared state */
});
