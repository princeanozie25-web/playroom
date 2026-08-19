import type { XMention, XPost, XThread } from './types.js';

// @playroom/x-read — the read seam.
//
// A single interface every backend implements, so the fabric holds a provider-neutral `XReadSource` and
// never a Twitter client. The seam is READ-ONLY on purpose: posting back to X is a governed WRITE that must
// travel the Execution Gate (C1) like any other host op — it does not belong on the source that also holds
// the read credential. And this interface is the ONLY place an X credential is used: a caller passes a
// handle and a query, never a key or a cookie, so a leak has one location to audit, not many.

/** Paging + freshness hints. `sinceId` fetches only what is newer than a post already seen (the mentions poll). */
export interface XReadCursor {
  /** Return only posts newer than this id — the drain-since-last-seen the mentions trigger needs. */
  sinceId?: string;
  /** A soft cap on how many posts to return. A backend may return fewer; it must not exceed this. */
  maxResults?: number;
}

/**
 * A provider-neutral reader over X/Twitter. Four capabilities, the grokbot read surface:
 *   - `getMentions` — the trigger: posts that @-mention the watched account, newest first.
 *   - `getThread`   — the context: a post and the replies beneath it.
 *   - `search`      — recent posts matching a query.
 *   - `getUserPosts`— a specific account's recent posts.
 *
 * Every method returns the normalized {@link XPost} shape. A backend translates its own JSON; nothing above
 * this seam knows which one answered — only `post.backend` records it, for the receipt.
 */
export interface XReadSource {
  /** Which backend this is (`mock`, `twitterapi.io`, `x-api-v2`, …) — stamped onto every post's provenance. */
  readonly backend: string;

  /** Posts that @-mention `handle` (without the leading `@`), newest first. The grokbot trigger. */
  getMentions(handle: string, cursor?: XReadCursor): Promise<XMention[]>;

  /** A post and the replies under it (oldest-first), by post id — the context a reply is written against. */
  getThread(postId: string): Promise<XThread>;

  /** Recent posts matching a query string (the backend's own search syntax). */
  search(query: string, cursor?: XReadCursor): Promise<XPost[]>;

  /** An account's recent posts, by handle (without the leading `@`). */
  getUserPosts(handle: string, cursor?: XReadCursor): Promise<XPost[]>;
}

/** The reason an X read failed, as a code the caller can branch on without parsing a message. */
export type XReadFailure =
  | 'not_configured' // the backend needs a credential/base URL the environment did not provide
  | 'not_found' // no post/thread by that id
  | 'rate_limited' // the provider throttled us
  | 'upstream_error'; // the provider answered with an error or an unparseable body

/** A read error carrying a {@link XReadFailure} code. Never leaks the credential or the raw upstream body. */
export class XReadError extends Error {
  constructor(
    readonly code: XReadFailure,
    message: string,
  ) {
    super(message);
    this.name = 'XReadError';
  }
}
