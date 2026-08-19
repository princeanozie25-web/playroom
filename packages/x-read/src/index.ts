// @playroom/x-read — the provider-neutral X/Twitter READ seam (grokbot-parity reads, governed).
//
// The goal is grokbot's read surface — read the mentions, read the thread, answer — but provider-neutral
// (swap the backend) and behind the fabric (the source is the ONLY holder of the X credential; mandates and
// receipts attach a layer up). This package is that seam and nothing more: a normalized model, one
// interface, and the backends that implement it. Posting back to X is a governed WRITE for the Execution
// Gate (C1), deliberately NOT here.

export type { XAuthor, XMetrics, XPost, XMention, XThread } from './types.js';
export { XReadError, type XReadCursor, type XReadFailure, type XReadSource } from './source.js';
export { MockXSource, BACKEND_MOCK, DEFAULT_MOCK_POSTS } from './mock.js';
export {
  TwitterApiIoSource,
  BACKEND_TWITTERAPIIO,
  toXPost,
  type FetchLike,
  type TwitterApiIoOptions,
} from './twitterapiio.js';
export { createXReadSource, X_READ_BACKENDS, type XReadBackend } from './factory.js';
