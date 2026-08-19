# @playroom/x-read — the X/Twitter read seam

The read surface for **grokbot parity**, done the Playroom way: provider-neutral (swap the backend) and
behind the fabric (this package is the **only holder of the X credential**; mandates and receipts attach a
layer up). It is a seam, not an integration — a normalized model, one interface, and the backends that
implement it. Posting back to X is a governed **write** for the Execution Gate (C1); deliberately not here.

## The interface

```ts
import { createXReadSource } from '@playroom/x-read';

const x = createXReadSource(); // env-selected; defaults to the mock backend
await x.getMentions('playroom_ai'); // the trigger — posts that @-mention us, newest first
await x.getThread(postId); // the context — a post and its replies
await x.search('governed agents'); // recent posts matching a query
await x.getUserPosts('playroom_ai'); // an account's own recent posts
```

Every method returns the normalized `XPost` shape, and every post carries `post.backend` as provenance.
Nothing above the seam knows which backend answered.

## Backends (env-selected)

`X_READ_BACKEND` selects; the credential is read by the factory, never by a caller.

| `X_READ_BACKEND` | credential env            | notes                                                                 |
| ---------------- | ------------------------- | --------------------------------------------------------------------- |
| `mock` (default) | — none —                  | deterministic, offline; what CI runs against and what the demo uses.  |
| `twitterapi.io`  | `X_READ_TWITTERAPIIO_KEY` | managed read API, ~$0.15/1k reads, one key, no X dev account/cookies. |

Offline demo of the whole surface: `pnpm tsx scripts/x-read-demo.ts [handle]`.

## Verify on the first live call (twitterapi.io)

The backend is written against the provider's **documented** schema and its request-shaping + response-mapping
are tested against fixtures (`twitterapiio.test.ts`) — but two contract points the docs left unconfirmed are
handled **defensively** and should be confirmed with one live trial call before being trusted:

1. **`createdAt` format** — assumed the classic `"Tue Aug 19 09:00:00 +0000 2026"`; `toIso` also accepts
   ISO-8601 and passes an unparseable value through untouched.
2. **`user/last_tweets` shape** — read tolerantly as both `{tweets}` and the nested `{data:{tweets, pin_tweet}}`.

`toXPost` is the one function a schema drift would touch. Pagination beyond the first page (the provider's
`next_cursor`) is a follow-up; today each call fetches one page (cost-bounded), honouring `sinceId`/`maxResults`.

## What comes next (not in this seam)

Wiring a mention into a **governed cycle** — `getMentions` wakes a room, `getThread` supplies context, the
model-swap + reasoning-effort layer answers, and the reply travels the Execution Gate with a receipt — is the
next slice. That is where the governance (the moat over grokbot) attaches; this package is the structure it
sits on. See `docs/decisions/` and the Twitter/grokbot memory for the direction. Backends to add behind the
same interface: the **official X API v2** (compliant, in reserve) and a burner-cookie scraper (`agent-reach`)
for a $0 first light.
