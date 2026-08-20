// @playroom/receipt — verify a Playroom commitment for yourself, without trusting the server.
//
// The audit chain (A3) is the server's tamper-evident record. This package is the OTHER half of that
// promise: the open algorithm and the detached-receipt shape a third party uses to re-derive every hash on
// their own machine. Two consumers share it — apps/api (to build a receipt and to keep ONE hashing
// algorithm) and scripts/verify-receipt.ts (the standalone tool). Runtime deps: @playroom/fabric's
// canonicalise and node:crypto, nothing else.

export { GENESIS, sha256, bodyHash, entryHash, type EntryMeta } from './hash.js';
export {
  verifyDetachedReceipt,
  type DetachedReceipt,
  type ChainLink,
  type ReceiptVerdict,
} from './receipt.js';
