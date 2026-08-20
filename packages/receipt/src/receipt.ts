import { bodyHash, entryHash, type EntryMeta } from './hash.js';

// ═══ THE DETACHED RECEIPT — VERIFY IT YOURSELF, WITHOUT TRUSTING US ═══════════════════════════════════
//
// A commitment (a co-signed decision, its resolution) is folded into the append-only audit chain (A3). The
// server can already answer "here is the receipt" — but a server telling you its own record is intact is not
// a proof, it is a claim. A DETACHED receipt is the proof: it carries the RAW source payload, the chain
// metadata and hashes for the entry, the anchored root it belongs to, and the inclusion path from the entry
// to that root. Hand it to anyone with `verifyDetachedReceipt` (open code, no server) and they re-derive
// every hash for themselves. The only thing that must come from OUTSIDE the server is the root: principals
// receive the day's root out of band (Bible §17), so a wholesale rewrite cannot reproduce a root already
// sent. This module proves a receipt is internally consistent AND reaches a stated root; comparing that root
// to the independently-anchored one is the last, human step — and it is the step that needs no trust in us.

/** One entry on the inclusion path — a chain row from the receipt's own entry up to the root, in order. */
export interface ChainLink {
  prev_hash: string;
  body_hash: string;
  entry_hash: string;
  meta: EntryMeta;
}

/** Everything needed to verify a commitment without the server. */
export interface DetachedReceipt {
  decision_id: string;
  resolution?: 'APPROVED' | 'DENIED';
  signed_by?: string;
  /** The raw source event payload the body_hash is taken over — re-hashed by the verifier, never trusted. */
  source_payload: unknown;
  meta: EntryMeta;
  body_hash: string;
  prev_hash: string;
  entry_hash: string;
  chained_at?: string;
  /** The chain root (its newest entry_hash) this receipt claims inclusion in — compare to the anchored root. */
  root: string;
  /** The chain entries from this receipt's own entry (first) to the root (last), each linking to the next. */
  path: ChainLink[];
}

export interface ReceiptVerdict {
  ok: boolean;
  checks: {
    /** Re-hashing source_payload equals body_hash — the recorded body is the real one, unedited. */
    body: boolean;
    /** entry_hash recomputes from prev_hash + body_hash + meta — this entry was not edited. */
    entry: boolean;
    /** The path links entry → … → root with every link intact — the entry is in the chain that made root. */
    chain: boolean;
    /** The displayed outcome (decision_id / resolution / signed_by) equals what the payload COMMITS to. */
    outcome: boolean;
  };
  /** The VERIFIED outcome, read from the hashed source_payload — present only when `ok`. Display THIS, never
   *  the raw top-level fields, which a lying server could flip while leaving every hash honest. */
  outcome?: { decision_id?: string; resolution?: 'APPROVED' | 'DENIED'; signed_by?: string };
  /** The root the path resolves to — the value a verifier compares against the independently-anchored root. */
  root: string;
  /** Present when `ok` is false: what broke, in a sentence. */
  reason?: string;
}

/**
 * Verify a detached receipt with open code and no server call. Three independent checks, mirroring the three
 * ways to tamper (see A3's verifyAuditChain, server-side): the BODY (re-hash the raw payload → body_hash),
 * the ENTRY (recompute entry_hash from its stored parts), and the CHAIN (walk the inclusion path so the
 * entry provably links forward to `root`). Pure: same input, same verdict, on anyone's machine.
 */
export function verifyDetachedReceipt(receipt: DetachedReceipt): ReceiptVerdict {
  const checks = { body: false, entry: false, chain: false, outcome: false };

  // A malformed receipt (hostile or truncated JSON) is a clean FALSE, never a crash — a third party runs
  // this on arbitrary input, so a missing field must not throw.
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    typeof receipt.body_hash !== 'string' ||
    typeof receipt.entry_hash !== 'string' ||
    typeof receipt.prev_hash !== 'string' ||
    typeof receipt.root !== 'string' ||
    !receipt.meta ||
    typeof receipt.meta !== 'object' ||
    !Array.isArray(receipt.path)
  ) {
    return {
      ok: false,
      checks,
      root: typeof receipt?.root === 'string' ? receipt.root : '',
      reason: 'malformed receipt — a required field is missing or the wrong type',
    };
  }
  const fail = (reason: string): ReceiptVerdict => ({
    ok: false,
    checks,
    root: receipt.root,
    reason,
  });

  // 1. THE BODY. Re-hash the raw payload the receipt carries; it must equal the recorded body_hash. A server
  //    that edited the decision after the fact cannot make this line pass.
  checks.body = bodyHash(receipt.source_payload) === receipt.body_hash;
  if (!checks.body) {
    return fail(
      'the source payload does not hash to body_hash — the recorded body was tampered with',
    );
  }

  // 2. THE ENTRY. Recompute entry_hash from prev_hash + body_hash + meta. An edit to who committed, the room,
  //    the type, or the link breaks this.
  checks.entry =
    entryHash(receipt.prev_hash, receipt.body_hash, receipt.meta) === receipt.entry_hash;
  if (!checks.entry) {
    return fail('entry_hash does not recompute from its parts — this receipt entry was edited');
  }

  // 3. THE CHAIN. The inclusion path must start at THIS entry and link, hash by hash, to the claimed root.
  if (receipt.path.length === 0 || receipt.path[0]?.entry_hash !== receipt.entry_hash) {
    return fail('the inclusion path does not start at this receipt entry');
  }
  let prev = receipt.path[0].prev_hash;
  let last = '';
  for (const link of receipt.path) {
    if (link.prev_hash !== prev) {
      return fail('a link in the inclusion path is broken — an entry was inserted or removed');
    }
    if (entryHash(link.prev_hash, link.body_hash, link.meta) !== link.entry_hash) {
      return fail('an entry in the inclusion path does not recompute');
    }
    prev = link.entry_hash;
    last = link.entry_hash;
  }
  if (last !== receipt.root) {
    return fail('the inclusion path does not end at the claimed root');
  }
  checks.chain = true;

  // 4. THE OUTCOME. The human-meaningful fields a reader is SHOWN — decision_id, resolution, signed_by —
  //    must be the ones the payload COMMITS to, not free-floating top-level copies a lying server could flip
  //    while leaving every hash honest (the body/entry/chain checks above only bind source_payload). Bind
  //    them to source_payload, and hand back the VERIFIED value for display, so what you read is what was
  //    verified — not a caption the server was free to write.
  const sp = (receipt.source_payload ?? {}) as {
    decision_id?: string;
    resolution?: 'APPROVED' | 'DENIED';
    signed_by?: string;
  };
  if (
    receipt.decision_id !== sp.decision_id ||
    receipt.resolution !== sp.resolution ||
    receipt.signed_by !== sp.signed_by
  ) {
    return fail(
      'the displayed outcome does not match the committed payload — a top-level receipt field was tampered with',
    );
  }
  checks.outcome = true;

  return {
    ok: true,
    checks,
    root: receipt.root,
    outcome: { decision_id: sp.decision_id, resolution: sp.resolution, signed_by: sp.signed_by },
  };
}
