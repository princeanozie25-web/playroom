// ═══ THE OUTBOUND WRITE SEAM — a room acts on the world, GOVERNED (ADR-020) ═══════════════════════════
//
// The mirror of @playroom/x-read, and deliberately a SEPARATE package: x-read's own header says posting back
// is "a governed WRITE that must travel the Execution Gate … it does not belong on the source that also holds
// the read credential." So a write backend is its own credential holder, provider-neutral over the medium
// (an X reply, a GitHub comment, an email), and reached ONLY after a human co-signed the exact content —
// never on the fabric's own initiative (RT-005). The Mock backend performs nothing real: it records the write
// and returns a synthetic ref, so the whole governed path is testable and safe offline.

/** The normalized write a co-signed decision authorizes. `medium` is the co-signed action (e.g. 'x.reply'),
 *  so the backend performs exactly what was ruled on. `idempotencyKey` (the decision id) lets a backend
 *  refuse to write the same thing twice even if the executor is somehow re-entered. */
export interface WriteRequest {
  medium: string;
  /** Where it goes — a post URL to reply to, a repo issue/PR, an email recipient. */
  target: string;
  /** The exact content a human co-signed. Public/outbound, and already egress-screened before co-sign. */
  body: string;
  idempotencyKey: string;
}

/** The outcome of a performed write. Carries a REF to what was written (never the body again), the backend
 *  that did it, and — on failure — a coded reason that never contains a credential. */
export interface WriteReceipt {
  ok: boolean;
  /** Which backend performed it: 'mock' | 'x' | 'github' | 'email' | … */
  backend: string;
  /** The id/URL of what was written, when ok (a tweet id, a comment URL). */
  ref?: string;
  /** A {@link WriteFailure} code, when not ok. Never the raw upstream error or any secret. */
  error?: WriteFailure;
}

/** Coded failures — safe to log and to put on a `write.performed` event; never leak a credential. */
export type WriteFailure = 'not_configured' | 'unsupported_medium' | 'rejected' | 'upstream_error';

export class WriteError extends Error {
  constructor(
    readonly code: WriteFailure,
    message: string,
  ) {
    super(message);
    this.name = 'WriteError';
  }
}

/**
 * A backend that can PERFORM a write. `media` is the set of mediums it handles (`['*']` = any). The apps/api
 * executor (`fireWrite`) holds one of these and calls `perform` exactly once per co-signed, APPROVED decision.
 */
export interface WriteBackend {
  readonly backend: string;
  readonly media: readonly string[];
  perform(req: WriteRequest): Promise<WriteReceipt>;
}
