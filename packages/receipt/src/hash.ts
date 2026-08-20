import { createHash } from 'node:crypto';
import { canonicalise } from '@playroom/fabric';

// THE OPEN ALGORITHM behind the tamper-evident audit chain (A3, Bible §17) — the exact functions the server
// uses to build the chain, factored out here so they are PORTABLE. A third party who is handed a detached
// receipt runs these same three lines and confirms the commitment for themselves; nothing about the proof
// depends on the server's word. `canonicalise` is fabric's (one serialiser, so hashing here and on the
// server cannot disagree about what "the body" is); the rest is node:crypto, present wherever Node runs.

/** The first entry's prev_hash. A named marker, so a chain with one row still has a well-defined link. */
export const GENESIS = 'sha256:genesis';

/** The metadata a chain entry commits to, alongside its body and the previous link. */
export interface EntryMeta {
  room_id: string;
  actor_id: string;
  event: string;
  source_seq: number;
}

/** sha256 of a UTF-8 string, prefixed so the algorithm is named in the value rather than inferred by length. */
export function sha256(input: string): string {
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

/** The hash of a source event's body — over the CANONICAL payload, so key order or whitespace cannot change it. */
export function bodyHash(payload: unknown): string {
  return sha256(canonicalise(payload));
}

/** The chain link: H(prev_hash ⏎ body_hash ⏎ canonicalise(meta)). Recomputable from stored columns alone. */
export function entryHash(prevHash: string, body: string, meta: EntryMeta): string {
  return sha256(`${prevHash}\n${body}\n${canonicalise(meta)}`);
}
