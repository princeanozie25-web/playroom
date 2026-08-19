import type { XMention, XPost, XThread } from './types.js';
import { XReadError, type XReadCursor, type XReadSource } from './source.js';

// @playroom/x-read — the mock backend.
//
// A deterministic in-memory source: no network, no credential, no clock. It exists for two jobs — it is the
// backend CI runs against (so the seam is tested without a live X account or a paid key), and it powers the
// offline demo of the whole read surface. A caller swaps it for a real backend by changing one env var; the
// four methods behave identically, so a green mock is real evidence the seam is wired right.
//
// The default fixture is a small Playroom conversation. A test may pass its own posts to exercise an edge.

export const BACKEND_MOCK = 'mock';

function post(p: Omit<XPost, 'backend'>): XPost {
  return { ...p, backend: BACKEND_MOCK };
}

/** A seeded conversation: two mentions in one thread, one standalone mention, two of our own posts, one noise. */
export const DEFAULT_MOCK_POSTS: readonly XPost[] = [
  post({
    id: 'x1',
    author: { id: 'u_dev', handle: 'curious_dev', displayName: 'Ada (curious dev)' },
    text: 'Hey @playroom_ai — how do you stop one agent reading another agent’s private context?',
    createdAt: '2026-08-19T09:00:00.000Z',
    conversationId: 'x1',
    inReplyToId: null,
    url: 'https://x.com/curious_dev/status/x1',
    metrics: { likes: 12, reposts: 2, replies: 3 },
  }),
  post({
    id: 'x2',
    author: { id: 'u_pr', handle: 'playroom_ai', displayName: 'Playroom' },
    text: 'Each agent’s private store is structurally out of reach — a room shares only promoted common ground.',
    createdAt: '2026-08-19T09:05:00.000Z',
    conversationId: 'x1',
    inReplyToId: 'x1',
    url: 'https://x.com/playroom_ai/status/x2',
    metrics: { likes: 40, reposts: 6, replies: 1 },
  }),
  post({
    id: 'x3',
    author: { id: 'u_dev', handle: 'curious_dev', displayName: 'Ada (curious dev)' },
    text: 'nice. and @playroom_ai who approves a risky action before it runs?',
    createdAt: '2026-08-19T09:10:00.000Z',
    conversationId: 'x1',
    inReplyToId: 'x2',
    url: 'https://x.com/curious_dev/status/x3',
    metrics: { likes: 5 },
  }),
  post({
    id: 'x4',
    author: { id: 'u_fan', handle: 'agent_watcher', displayName: 'Sol Watcher' },
    text: 'loving the governed-agents idea from @playroom_ai — receipts on every action is the part grok is missing',
    createdAt: '2026-08-19T10:00:00.000Z',
    conversationId: 'x4',
    inReplyToId: null,
    url: 'https://x.com/agent_watcher/status/x4',
    metrics: { likes: 88, reposts: 14, replies: 4 },
  }),
  post({
    id: 'x5',
    author: { id: 'u_pr', handle: 'playroom_ai', displayName: 'Playroom' },
    text: 'Shipping the Execution Gate today: host file/git/shell ops pass a policy check before they run.',
    createdAt: '2026-08-19T11:00:00.000Z',
    conversationId: 'x5',
    inReplyToId: null,
    url: 'https://x.com/playroom_ai/status/x5',
    metrics: { likes: 120, reposts: 30, replies: 9 },
  }),
  post({
    id: 'x6',
    author: { id: 'u_rand', handle: 'noise_account', displayName: 'Just Here' },
    text: 'unrelated post about cats and coffee',
    createdAt: '2026-08-19T11:30:00.000Z',
    conversationId: 'x6',
    inReplyToId: null,
    url: 'https://x.com/noise_account/status/x6',
  }),
];

/** Newest-first by createdAt; ties broken by id descending so the order is total and stable. */
function newestFirst(a: XPost, b: XPost): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

/** Keep only posts strictly newer than `sinceId` (by the newest-first order), then cap to `maxResults`. */
function applyCursor(posts: XPost[], cursor: XReadCursor | undefined): XPost[] {
  let out = posts;
  if (cursor?.sinceId) {
    const idx = out.findIndex((p) => p.id === cursor.sinceId);
    // Everything BEFORE the sinceId in newest-first order is newer than it — that is the drain-since-last-seen.
    if (idx >= 0) out = out.slice(0, idx);
  }
  if (cursor?.maxResults !== undefined) out = out.slice(0, Math.max(0, cursor.maxResults));
  return out;
}

export class MockXSource implements XReadSource {
  readonly backend = BACKEND_MOCK;
  private readonly posts: XPost[];

  constructor(posts: readonly XPost[] = DEFAULT_MOCK_POSTS) {
    this.posts = [...posts];
  }

  async getMentions(handle: string, cursor?: XReadCursor): Promise<XMention[]> {
    // Match the EXACT handle: `@playroom_ai` is a mention, `@playroom_ai_bot` is not.
    const at = new RegExp(`@${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const hits = this.posts.filter((p) => at.test(p.text)).sort(newestFirst);
    return applyCursor(hits, cursor);
  }

  async getThread(postId: string): Promise<XThread> {
    const seed = this.posts.find((p) => p.id === postId);
    if (!seed) throw new XReadError('not_found', `no post with id ${postId}`);
    // The thread key is the conversation root — so getThread works from ANY post in the thread, not just its root.
    const rootId = seed.conversationId ?? seed.id;
    const root = this.posts.find((p) => p.id === rootId) ?? seed;
    const replies = this.posts
      .filter((p) => p.id !== root.id && (p.conversationId ?? p.id) === root.id)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return { root, replies };
  }

  async search(query: string, cursor?: XReadCursor): Promise<XPost[]> {
    const q = query.toLowerCase();
    const hits = this.posts.filter((p) => p.text.toLowerCase().includes(q)).sort(newestFirst);
    return applyCursor(hits, cursor);
  }

  async getUserPosts(handle: string, cursor?: XReadCursor): Promise<XPost[]> {
    const hits = this.posts
      .filter((p) => p.author.handle.toLowerCase() === handle.toLowerCase())
      .sort(newestFirst);
    return applyCursor(hits, cursor);
  }
}
