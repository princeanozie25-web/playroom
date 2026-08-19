import type { XAuthor, XMention, XPost, XThread } from './types.js';
import { XReadError, type XReadCursor, type XReadSource } from './source.js';

// @playroom/x-read — the twitterapi.io backend (a managed read API; ~$0.15 / 1k reads, one API key, no
// X developer account, no cookies). It is the FIRST real backend behind the seam: the mock proves the
// interface, this proves the interface accommodates a live provider. Everything provider-specific — the
// endpoints, the camelCase tweet shape, the cursor keys — is confined to this file; `toXPost` is the one
// function a schema drift would touch.
//
// THE CREDENTIAL LIVES ONLY HERE. The key is read from the environment (or injected in a test) and put on
// an `X-API-Key` header; it is never returned, never logged, never placed on an `XPost`. A caller passes a
// handle and a query, never a secret.
//
// Two contract points the docs left unconfirmed are handled DEFENSIVELY, per the API research:
//   1. `createdAt` may be ISO-8601 or the classic `"Tue Dec 10 07:00:30 +0000 2024"` — `toIso` accepts both.
//   2. `user/last_tweets` may return `{tweets}` flat OR nested `{data:{tweets, pin_tweet}}` — `tweetsOf` reads both.
// Both are marked below; confirm them on the first live call before trusting them blindly.

export const BACKEND_TWITTERAPIIO = 'twitterapi.io';
const DEFAULT_BASE_URL = 'https://api.twitterapi.io';

/** The minimal shape of `fetch` this backend needs — so a test can inject a stub returning fixture JSON. */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface TwitterApiIoOptions {
  /** The API key. The factory reads it from `X_READ_TWITTERAPIIO_KEY`; a test passes a dummy. Never leaves this object. */
  apiKey: string;
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Overridable for a proxy/mirror; defaults to the documented base URL. */
  baseUrl?: string;
}

// --- normalisation: the provider's JSON → our XPost. The one seam a schema change would touch. ---

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}
function optId(v: unknown): string | null {
  const s = str(v);
  return s === '' ? null : s;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

/**
 * `createdAt` → ISO-8601. Accepts both the classic Twitter format and an already-ISO string (JS `Date`
 * parses both); an unparseable value is passed through verbatim rather than becoming an "Invalid Date".
 */
function toIso(raw: unknown): string {
  const s = str(raw);
  if (s === '') return '';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

function toAuthor(raw: unknown): XAuthor {
  const a = (raw ?? {}) as Record<string, unknown>;
  return {
    id: str(a.id),
    handle: str(a.userName), // confirmed: the handle is `author.userName`, no leading `@`
    displayName: str(a.name) || str(a.userName),
  };
}

/** Map one provider tweet to the normalized shape. Field names are the confirmed camelCase schema. */
export function toXPost(raw: unknown): XPost {
  const t = (raw ?? {}) as Record<string, unknown>;
  return {
    id: str(t.id),
    author: toAuthor(t.author),
    text: str(t.text),
    createdAt: toIso(t.createdAt),
    conversationId: optId(t.conversationId),
    inReplyToId: optId(t.inReplyToId),
    url: str(t.url), // confirmed: a ready-made permalink at the top level
    metrics: {
      likes: num(t.likeCount),
      reposts: num(t.retweetCount),
      replies: num(t.replyCount),
    },
    backend: BACKEND_TWITTERAPIIO,
  };
}

/** Read the tweet array from a response, tolerating both `{tweets}` and the nested `{data:{tweets}}` form. */
function tweetsOf(body: unknown): unknown[] {
  const b = (body ?? {}) as Record<string, unknown>;
  if (Array.isArray(b.tweets)) return b.tweets;
  if (Array.isArray(b.replies)) return b.replies; // replies/thread_context endpoints key the array `replies`
  const data = (b.data ?? {}) as Record<string, unknown>;
  if (Array.isArray(data.tweets)) return data.tweets; // the last_tweets nested form
  return [];
}

/** Take posts newest-first up to `maxResults`, stopping when `sinceId` is reached (drain-since-last-seen). */
function untilSeen(posts: XPost[], cursor: XReadCursor | undefined): XPost[] {
  const cap = cursor?.maxResults;
  const out: XPost[] = [];
  for (const p of posts) {
    if (cursor?.sinceId && p.id === cursor.sinceId) break;
    out.push(p);
    if (cap !== undefined && out.length >= cap) break;
  }
  return out;
}

export class TwitterApiIoSource implements XReadSource {
  readonly backend = BACKEND_TWITTERAPIIO;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(opts: TwitterApiIoOptions) {
    if (!opts.apiKey) throw new XReadError('not_configured', 'twitterapi.io: no API key');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  }

  /** One authenticated GET. The key rides an `X-API-Key` header — never a query param, never logged. */
  private async get(path: string, params: Record<string, string | undefined>): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
    let res: { ok: boolean; status: number; json: () => Promise<unknown> };
    try {
      res = await this.fetchImpl(url.toString(), { headers: { 'X-API-Key': this.apiKey } });
    } catch {
      // A network failure is an upstream error to the caller — the reason, never the key or the URL params.
      throw new XReadError('upstream_error', `twitterapi.io: request to ${path} failed`);
    }
    if (res.status === 429) throw new XReadError('rate_limited', 'twitterapi.io: rate limited');
    if (!res.ok)
      throw new XReadError('upstream_error', `twitterapi.io: ${path} returned ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    if (body && body.status === 'error') {
      throw new XReadError('upstream_error', `twitterapi.io: ${str(body.message) || 'error'}`);
    }
    return body;
  }

  async getMentions(handle: string, cursor?: XReadCursor): Promise<XMention[]> {
    const body = await this.get('/twitter/user/mentions', { userName: handle, cursor: '' });
    return untilSeen(tweetsOf(body).map(toXPost), cursor);
  }

  async getThread(postId: string): Promise<XThread> {
    // thread_context reconstructs the whole conversation from ANY tweet in it. The array is keyed `replies`.
    const body = await this.get('/twitter/tweet/thread_context', { tweetId: postId, cursor: '' });
    const posts = tweetsOf(body).map(toXPost);
    if (posts.length === 0) {
      // No context returned — hydrate the seed alone so a caller still gets the post it asked about.
      const seed = tweetsOf(await this.get('/twitter/tweets', { tweet_ids: postId })).map(toXPost);
      if (seed.length === 0) throw new XReadError('not_found', `twitterapi.io: no tweet ${postId}`);
      return { root: seed[0], replies: [] };
    }
    // The root is the post whose conversationId points at itself (or, failing that, the first with no parent).
    const rootId = posts[0].conversationId ?? postId;
    let root = posts.find((p) => p.id === rootId) ?? posts.find((p) => p.inReplyToId === null);
    if (!root) {
      const hydrated = tweetsOf(await this.get('/twitter/tweets', { tweet_ids: rootId })).map(
        toXPost,
      );
      root = hydrated[0] ?? posts[0];
    }
    const rootRef = root;
    const replies = posts
      .filter((p) => p.id !== rootRef.id)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return { root: rootRef, replies };
  }

  async search(query: string, cursor?: XReadCursor): Promise<XPost[]> {
    const body = await this.get('/twitter/tweet/advanced_search', {
      query,
      queryType: 'Latest',
      cursor: '',
    });
    return untilSeen(tweetsOf(body).map(toXPost), cursor);
  }

  async getUserPosts(handle: string, cursor?: XReadCursor): Promise<XPost[]> {
    const body = await this.get('/twitter/user/last_tweets', { userName: handle, cursor: '' });
    return untilSeen(tweetsOf(body).map(toXPost), cursor);
  }
}
