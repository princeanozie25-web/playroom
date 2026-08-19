import { describe, expect, it } from 'vitest';
import { MockXSource, DEFAULT_MOCK_POSTS, XReadError, type XPost } from './index.js';

// The seam, exercised through the mock. These are the properties every backend must hold — a real backend
// (twitterapi.io, the official API) is correct when it passes the same shapes: mentions are the exact-handle
// posts newest-first, a thread reconstructs from any post in it, search and user-posts filter as named, and
// every post carries its backend as provenance. The mock is the executable spec of the interface.

const WATCHED = 'playroom_ai';

describe('MockXSource — the X read seam (default fixture)', () => {
  const src = new MockXSource();

  it('getMentions returns the posts that @-mention the watched handle, newest first', async () => {
    const mentions = await src.getMentions(WATCHED);
    // x4 (10:00), x3 (09:10), x1 (09:00) mention @playroom_ai; x2 and x5 are BY it, x6 is noise.
    expect(mentions.map((m) => m.id)).toEqual(['x4', 'x3', 'x1']);
    for (const m of mentions) expect(m.text.toLowerCase()).toContain(`@${WATCHED}`);
  });

  it('getMentions matches the EXACT handle — a superstring handle is not a mention', async () => {
    const posts: XPost[] = [
      {
        id: 'a',
        author: { id: 'u', handle: 'someone', displayName: 'S' },
        text: 'ping @playroom_ai here',
        createdAt: '2026-08-19T09:00:00.000Z',
        conversationId: 'a',
        inReplyToId: null,
        url: 'https://x.com/someone/status/a',
        backend: 'mock',
      },
      {
        id: 'b',
        author: { id: 'u', handle: 'someone', displayName: 'S' },
        text: 'but @playroom_ai_bot is a different account',
        createdAt: '2026-08-19T09:01:00.000Z',
        conversationId: 'b',
        inReplyToId: null,
        url: 'https://x.com/someone/status/b',
        backend: 'mock',
      },
    ];
    const only = new MockXSource(posts);
    expect((await only.getMentions('playroom_ai')).map((m) => m.id)).toEqual(['a']);
  });

  it('getMentions honours sinceId — only what is newer than the last-seen post', async () => {
    const fresh = await src.getMentions(WATCHED, { sinceId: 'x3' });
    // Only x4 is newer than x3 among the mentions.
    expect(fresh.map((m) => m.id)).toEqual(['x4']);
  });

  it('getMentions honours maxResults', async () => {
    expect((await src.getMentions(WATCHED, { maxResults: 1 })).map((m) => m.id)).toEqual(['x4']);
    expect(await src.getMentions(WATCHED, { maxResults: 0 })).toEqual([]);
  });

  it('getThread reconstructs a conversation from its root, replies oldest-first', async () => {
    const thread = await src.getThread('x1');
    expect(thread.root.id).toBe('x1');
    expect(thread.replies.map((r) => r.id)).toEqual(['x2', 'x3']);
  });

  it('getThread works from ANY post in the thread, not only the root', async () => {
    const fromReply = await src.getThread('x3');
    expect(fromReply.root.id).toBe('x1');
    expect(fromReply.replies.map((r) => r.id)).toEqual(['x2', 'x3']);
  });

  it('getThread throws not_found for an unknown id', async () => {
    await expect(src.getThread('nope')).rejects.toBeInstanceOf(XReadError);
    await expect(src.getThread('nope')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('search matches text, case-insensitively, newest first', async () => {
    expect((await src.search('governed')).map((p) => p.id)).toEqual(['x4']);
    expect((await src.search('EXECUTION')).map((p) => p.id)).toEqual(['x5']);
    expect(await src.search('nothing-here')).toEqual([]);
  });

  it('getUserPosts returns an account’s own posts, newest first', async () => {
    expect((await src.getUserPosts(WATCHED)).map((p) => p.id)).toEqual(['x5', 'x2']);
  });

  it('every returned post carries its backend as provenance', async () => {
    const all = [
      ...(await src.getMentions(WATCHED)),
      ...(await src.search('the')),
      (await src.getThread('x1')).root,
    ];
    for (const p of all) expect(p.backend).toBe('mock');
    expect(DEFAULT_MOCK_POSTS.every((p) => p.backend === 'mock')).toBe(true);
  });
});
