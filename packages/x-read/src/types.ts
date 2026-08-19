// @playroom/x-read — the normalized model.
//
// One provider-agnostic shape for a post, whatever backend produced it (a managed read API, the official
// X API v2, or a scraper). Every backend maps its own JSON into these types, so the room, the governance
// layer and the receipts downstream never learn which source was used — the same provider-neutrality the
// model adapters hold (ADR-011). Normalising HERE is what keeps a backend swap a one-file change.

/** The author of a post — a stable id plus the handle the fabric addresses and renders. */
export interface XAuthor {
  /** The provider's stable user id. Opaque; never rendered. */
  id: string;
  /** The `@handle`, WITHOUT the leading `@`. This is what a mention names and what the UI shows. */
  handle: string;
  /** The human-facing display name. */
  displayName: string;
}

/** Engagement counts, when a backend supplies them. Optional — a scraper may omit them. */
export interface XMetrics {
  likes?: number;
  reposts?: number;
  replies?: number;
}

/**
 * One post (a "tweet"), normalized. The linkage fields are what make a THREAD reconstructable:
 * `conversationId` is the id of the post at the root of the thread, and `inReplyToId` is the post this
 * one directly answers. Both are null for a standalone top-level post.
 */
export interface XPost {
  /** The provider's stable post id. */
  id: string;
  author: XAuthor;
  /** The post's text, as delivered. Untrusted external content — the caller screens it before a model sees it. */
  text: string;
  /** ISO 8601 timestamp of creation. */
  createdAt: string;
  /** The thread root's id, or null for a standalone post. */
  conversationId: string | null;
  /** The id of the post this one replies to, or null. */
  inReplyToId: string | null;
  /** The canonical URL of the post. */
  url: string;
  metrics?: XMetrics;
  /**
   * WHICH BACKEND produced this post — provenance carried on every record. The governance layer stamps it
   * onto a receipt so an answer traces to the source that fed it, and a backend swap is auditable.
   */
  backend: string;
}

/**
 * A post that @-mentions the watched account — the grokbot trigger. Structurally an `XPost`; the distinct
 * name marks intent at the call site (a mention wakes a governed cycle; a search hit does not).
 */
export type XMention = XPost;

/** A post together with the replies under it, oldest-first — the context a reply needs. */
export interface XThread {
  root: XPost;
  replies: XPost[];
}
