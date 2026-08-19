import { describe, expect, it } from 'vitest';
import {
  TwitterApiIoSource,
  toXPost,
  createXReadSource,
  XReadError,
  type FetchLike,
} from './index.js';

// The managed backend, verified against FIXTURE responses in twitterapi.io's documented shape — no live
// call, no key in CI. The two things proven here are the two things that break an API client: request
// SHAPING (right path, right params, key on the header not the URL) and response MAPPING (their camelCase
// tweet → our XPost, including the two defensively-handled contract points). A green run means the seam
// will hold the moment a real key is dropped in.

interface Call {
  url: string;
  headers?: Record<string, string>;
}

/** A stub `fetch` that records calls and answers each URL from a handler. */
function stub(
  handler: (url: string) => { status?: number; body: unknown },
): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers });
    const r = handler(url);
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => r.body };
  }) as FetchLike & { calls: Call[] };
  f.calls = calls;
  return f;
}

/** A tweet in twitterapi.io's confirmed camelCase shape. */
function rawTweet(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'tweet',
    id: '1900',
    url: 'https://x.com/curious_dev/status/1900',
    text: 'hey @playroom_ai how do receipts work?',
    createdAt: 'Tue Aug 19 09:00:00 +0000 2026', // classic format — NOT ISO, the documented default
    conversationId: '1800',
    inReplyToId: '1850',
    likeCount: 12,
    retweetCount: 3,
    replyCount: 1,
    author: { type: 'user', id: 'u1', userName: 'curious_dev', name: 'Ada' },
    ...over,
  };
}

describe('toXPost — the provider→normalized mapping', () => {
  it('maps the confirmed camelCase fields, and normalizes the classic date to ISO', () => {
    const p = toXPost(rawTweet());
    expect(p.id).toBe('1900');
    expect(p.author).toEqual({ id: 'u1', handle: 'curious_dev', displayName: 'Ada' });
    expect(p.text).toContain('@playroom_ai');
    expect(p.url).toBe('https://x.com/curious_dev/status/1900');
    expect(p.conversationId).toBe('1800');
    expect(p.inReplyToId).toBe('1850');
    expect(p.metrics).toEqual({ likes: 12, reposts: 3, replies: 1 });
    expect(p.backend).toBe('twitterapi.io');
    // classic "Tue Aug 19 09:00:00 +0000 2026" → ISO
    expect(p.createdAt).toBe('2026-08-19T09:00:00.000Z');
  });

  it('accepts an already-ISO createdAt too, and null linkage for a top-level post', () => {
    const p = toXPost(
      rawTweet({ createdAt: '2026-08-19T09:00:00.000Z', conversationId: '', inReplyToId: '' }),
    );
    expect(p.createdAt).toBe('2026-08-19T09:00:00.000Z');
    expect(p.conversationId).toBeNull();
    expect(p.inReplyToId).toBeNull();
  });

  it('passes an unparseable date through rather than emitting "Invalid Date"', () => {
    expect(toXPost(rawTweet({ createdAt: 'not-a-date' })).createdAt).toBe('not-a-date');
  });
});

describe('TwitterApiIoSource — request shaping + credential isolation', () => {
  it('getMentions calls /twitter/user/mentions with the handle, and the key rides the HEADER not the URL', async () => {
    const fetchImpl = stub(() => ({
      body: { tweets: [rawTweet()], has_next_page: false, next_cursor: '' },
    }));
    const src = new TwitterApiIoSource({ apiKey: 'secret-key-123', fetchImpl });
    const mentions = await src.getMentions('playroom_ai');

    expect(mentions.map((m) => m.id)).toEqual(['1900']);
    const call = fetchImpl.calls[0];
    expect(call.url).toContain('/twitter/user/mentions');
    expect(call.url).toContain('userName=playroom_ai');
    // Credential isolation: the key is on the X-API-Key header and NOWHERE in the URL.
    expect(call.headers?.['X-API-Key']).toBe('secret-key-123');
    expect(call.url).not.toContain('secret-key-123');
    // And it never rides on a returned post.
    expect(JSON.stringify(mentions)).not.toContain('secret-key-123');
  });

  it('honours sinceId (stop) and maxResults (cap)', async () => {
    const tweets = [rawTweet({ id: '30' }), rawTweet({ id: '20' }), rawTweet({ id: '10' })];
    const fetchImpl = stub(() => ({ body: { tweets } }));
    const src = new TwitterApiIoSource({ apiKey: 'k', fetchImpl });
    expect((await src.getMentions('h', { sinceId: '20' })).map((m) => m.id)).toEqual(['30']);
    expect((await src.getMentions('h', { maxResults: 2 })).map((m) => m.id)).toEqual(['30', '20']);
  });

  it('getUserPosts reads the NESTED {data:{tweets}} form as well as the flat one', async () => {
    const flat = stub(() => ({ body: { tweets: [rawTweet({ id: 'A' })] } }));
    const nested = stub(() => ({
      body: { data: { pin_tweet: null, tweets: [rawTweet({ id: 'B' })] } },
    }));
    expect(
      (await new TwitterApiIoSource({ apiKey: 'k', fetchImpl: flat }).getUserPosts('h')).map(
        (p) => p.id,
      ),
    ).toEqual(['A']);
    expect(
      (await new TwitterApiIoSource({ apiKey: 'k', fetchImpl: nested }).getUserPosts('h')).map(
        (p) => p.id,
      ),
    ).toEqual(['B']);
  });

  it('getThread reads the `replies` array and splits root from replies (root first by conversationId)', async () => {
    const body = {
      replies: [
        rawTweet({
          id: '1800',
          conversationId: '1800',
          inReplyToId: '',
          createdAt: 'Tue Aug 19 09:00:00 +0000 2026',
        }),
        rawTweet({
          id: '1850',
          conversationId: '1800',
          inReplyToId: '1800',
          createdAt: 'Tue Aug 19 09:05:00 +0000 2026',
        }),
        rawTweet({
          id: '1900',
          conversationId: '1800',
          inReplyToId: '1850',
          createdAt: 'Tue Aug 19 09:10:00 +0000 2026',
        }),
      ],
    };
    const src = new TwitterApiIoSource({ apiKey: 'k', fetchImpl: stub(() => ({ body })) });
    const thread = await src.getThread('1900');
    expect(thread.root.id).toBe('1800');
    expect(thread.replies.map((r) => r.id)).toEqual(['1850', '1900']); // oldest-first
  });

  it('getThread hydrates the seed alone when thread_context is empty', async () => {
    const fetchImpl = stub((url) =>
      url.includes('/twitter/tweets')
        ? { body: { tweets: [rawTweet({ id: '77' })] } }
        : { body: { replies: [] } },
    );
    const src = new TwitterApiIoSource({ apiKey: 'k', fetchImpl });
    const thread = await src.getThread('77');
    expect(thread.root.id).toBe('77');
    expect(thread.replies).toEqual([]);
  });

  it('maps upstream failures to codes without leaking anything', async () => {
    const rate = new TwitterApiIoSource({
      apiKey: 'k',
      fetchImpl: stub(() => ({ status: 429, body: {} })),
    });
    await expect(rate.getMentions('h')).rejects.toMatchObject({ code: 'rate_limited' });
    const boom = new TwitterApiIoSource({
      apiKey: 'k',
      fetchImpl: stub(() => ({ status: 500, body: {} })),
    });
    await expect(boom.getMentions('h')).rejects.toMatchObject({ code: 'upstream_error' });
    const errBody = new TwitterApiIoSource({
      apiKey: 'k',
      fetchImpl: stub(() => ({ body: { status: 'error', message: 'bad query' } })),
    });
    await expect(errBody.search('x')).rejects.toMatchObject({ code: 'upstream_error' });
  });

  it('refuses to construct without a key — a misconfiguration fails loudly, not silently', () => {
    expect(() => new TwitterApiIoSource({ apiKey: '' })).toThrow(XReadError);
  });
});

describe('createXReadSource — the env-selected factory', () => {
  it('defaults to the mock backend', () => {
    expect(createXReadSource({}).backend).toBe('mock');
  });
  it('builds twitterapi.io from the key in env', () => {
    expect(
      createXReadSource({ X_READ_BACKEND: 'twitterapi.io', X_READ_TWITTERAPIIO_KEY: 'k' }).backend,
    ).toBe('twitterapi.io');
  });
  it('fails loudly when the selected backend has no credential', () => {
    expect(() => createXReadSource({ X_READ_BACKEND: 'twitterapi.io' })).toThrow(XReadError);
  });
  it('rejects an unknown backend', () => {
    expect(() => createXReadSource({ X_READ_BACKEND: 'nope' })).toThrow(XReadError);
  });
});
