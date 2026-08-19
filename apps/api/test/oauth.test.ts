import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { testPool, uniqueRoomId, startTestServer, type TestServer } from './support.js';
import { createRoom } from '../src/events.js';
import { issueCredential, revokeCredential } from '../src/credentials.js';

// ═══ B2 — OAuTH FOR THE SUBSCRIPTION LOGIN, END TO END ═══
//
// A subscription registers a client, its user proves which member they are with a prm_ credential at consent,
// and it receives a short-lived token that drives the SAME /mcp door B1 built. Identity is derived from the
// credential the whole way through — the OAuth token resolves to exactly the member the credential does. The
// negatives matter as much as the happy path: PKCE must verify, a code is single-use, a bad credential is
// refused without confirming it was real, and a revoked token stops working.

const pool = testPool();
const clientIds: string[] = [];
const rooms: string[] = [];
const extraCredentialIds: string[] = [];
const REDIRECT = 'http://127.0.0.1:9999/cb';

const CT_FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const CT_JSON = { 'content-type': 'application/json' };

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function registerClient(base: string): Promise<string> {
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: CT_JSON,
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Test Subscription' }),
  });
  expect(res.status).toBe(201);
  const client = (await res.json()) as { client_id: string };
  clientIds.push(client.client_id);
  return client.client_id;
}

/** Register → consent with `credential` → token. Returns the token response and the client id. */
async function login(
  server: TestServer,
  credential: string,
): Promise<{ clientId: string; tokens: Record<string, string> }> {
  const base = server.httpBase;
  const clientId = await registerClient(base);
  const { verifier, challenge } = pkce();

  const consent = await fetch(`${base}/authorize/consent`, {
    method: 'POST',
    headers: CT_FORM,
    redirect: 'manual',
    body: new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      state: 'st-123',
      scope: 'playroom',
      credential,
    }),
  });
  expect(consent.status).toBe(302);
  const loc = new URL(consent.headers.get('location') as string);
  expect(loc.searchParams.get('state')).toBe('st-123');
  const code = loc.searchParams.get('code') as string;
  expect(code).toMatch(/^plo_ac_/);

  const tokenRes = await fetch(`${base}/token`, {
    method: 'POST',
    headers: CT_FORM,
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
    }),
  });
  expect(tokenRes.status).toBe(200);
  return { clientId, tokens: (await tokenRes.json()) as Record<string, string> };
}

async function mcpToolCount(base: string, accessToken: string): Promise<number> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: 'oauth-e2e', version: '0.0.0' });
  try {
    await client.connect(transport);
    return (await client.listTools()).tools.length;
  } finally {
    await client.close().catch(() => {});
  }
}

afterEach(async () => {
  for (const c of clientIds) {
    await pool.query('DELETE FROM oauth_tokens WHERE client_id = $1', [c]);
    await pool.query('DELETE FROM oauth_codes WHERE client_id = $1', [c]);
    await pool.query('DELETE FROM oauth_clients WHERE client_id = $1', [c]);
  }
  clientIds.length = 0;
  for (const r of rooms) {
    await pool.query('DELETE FROM events WHERE room_id = $1', [r]);
    await pool.query('DELETE FROM room_members WHERE room_id = $1', [r]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [r]);
  }
  rooms.length = 0;
  // Credentials issued by a test clean up after themselves (S12-N3), same as the rooms and clients above.
  for (const id of extraCredentialIds) {
    await pool.query('DELETE FROM member_credentials WHERE id = $1', [id]);
  }
  extraCredentialIds.length = 0;
});

afterAll(async () => {
  await pool.end();
});

describe('OAuth discovery + registration (B2)', () => {
  it('advertises the authorization server and the protected resource', async () => {
    const server = await startTestServer();
    try {
      const asMeta = (await (
        await fetch(`${server.httpBase}/.well-known/oauth-authorization-server`)
      ).json()) as {
        authorization_endpoint: string;
        token_endpoint: string;
        code_challenge_methods_supported: string[];
      };
      expect(asMeta.authorization_endpoint).toBe(`${server.httpBase}/authorize`);
      expect(asMeta.token_endpoint).toBe(`${server.httpBase}/token`);
      expect(asMeta.code_challenge_methods_supported).toContain('S256');
      const prMeta = (await (
        await fetch(`${server.httpBase}/.well-known/oauth-protected-resource`)
      ).json()) as { resource: string; authorization_servers: string[] };
      expect(prMeta.resource).toBe(`${server.httpBase}/mcp`);
      expect(prMeta.authorization_servers).toContain(server.httpBase);
    } finally {
      await server.close();
    }
  });

  it('the consent page reflects nothing unescaped and refuses an unregistered redirect_uri', async () => {
    const server = await startTestServer();
    try {
      const clientId = await registerClient(server.httpBase);
      // A registered redirect_uri renders the consent form.
      const ok = await fetch(
        `${server.httpBase}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=abc&code_challenge_method=S256&state=x`,
      );
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toMatch(/text\/html/);
      // F4: the credential-entry page carries a tight CSP and the anti-clickjacking / no-referrer headers.
      expect(ok.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(ok.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
      expect(ok.headers.get('referrer-policy')).toBe('no-referrer');
      expect(ok.headers.get('cache-control')).toBe('no-store');
      const html = await ok.text();
      expect(html).toContain('name="credential"');
      // F3: the page names the destination the code goes to, so the owner can see WHERE before pasting.
      expect(html).toContain('127.0.0.1:9999');
      expect(html).toContain(clientId);
      // An unregistered redirect_uri is refused, never redirected to (no open redirect).
      const bad = await fetch(
        `${server.httpBase}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('https://evil.example/steal')}&code_challenge=abc&code_challenge_method=S256`,
      );
      expect(bad.status).toBe(400);
    } finally {
      await server.close();
    }
  });
});

describe('OAuth end to end (B2)', () => {
  it('register → consent with a prm_ credential → token → drives /mcp as that member', async () => {
    const server = await startTestServer();
    try {
      const { tokens } = await login(server, server.token); // server.token is a real prince credential
      expect(tokens.access_token).toMatch(/^plo_at_/);
      expect(tokens.refresh_token).toMatch(/^plo_rt_/);
      expect(tokens.token_type).toBe('Bearer');

      // The OAuth token drives the same 8-tool MCP surface B1 built.
      expect(await mcpToolCount(server.httpBase, tokens.access_token)).toBe(8);

      // And it resolves to the CREDENTIAL's member (prince): a message posted through it is attributed to prince.
      const roomId = uniqueRoomId('oauth');
      rooms.push(roomId);
      await createRoom(pool, roomId, roomId, 'prince'); // prince blanket-enrolled
      const transport = new StreamableHTTPClientTransport(new URL(`${server.httpBase}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
      });
      const client = new Client({ name: 'oauth-post', version: '0' });
      try {
        await client.connect(transport);
        const res = await client.callTool({
          name: 'post_message',
          arguments: { room_id: roomId, body: 'posted via an OAuth subscription token' },
        });
        expect(res.isError).toBeFalsy();
      } finally {
        await client.close().catch(() => {});
      }
      const { rows } = await pool.query<{ actor_id: string }>(
        `SELECT actor_id FROM events WHERE room_id = $1 AND event_type = 'message' AND payload ->> 'body' = $2`,
        [roomId, 'posted via an OAuth subscription token'],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_id).toBe('prince');
    } finally {
      await server.close();
    }
  });

  it('refresh_token issues a new working access token', async () => {
    const server = await startTestServer();
    try {
      const { clientId, tokens } = await login(server, server.token);
      const res = await fetch(`${server.httpBase}/token`, {
        method: 'POST',
        headers: CT_FORM,
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
          client_id: clientId,
        }),
      });
      expect(res.status).toBe(200);
      const next = (await res.json()) as Record<string, string>;
      expect(next.access_token).toMatch(/^plo_at_/);
      expect(next.access_token).not.toBe(tokens.access_token);
      expect(await mcpToolCount(server.httpBase, next.access_token)).toBe(8);
    } finally {
      await server.close();
    }
  });

  it('revoking the access token stops it working at /mcp', async () => {
    const server = await startTestServer();
    try {
      const { tokens } = await login(server, server.token);
      expect(await mcpToolCount(server.httpBase, tokens.access_token)).toBe(8);
      const rev = await fetch(`${server.httpBase}/revoke`, {
        method: 'POST',
        headers: CT_FORM,
        body: new URLSearchParams({ token: tokens.access_token }),
      });
      expect(rev.status).toBe(200);
      // A revoked token is refused at /mcp — the client transport surfaces the 401 as a connect error.
      await expect(mcpToolCount(server.httpBase, tokens.access_token)).rejects.toBeTruthy();
    } finally {
      await server.close();
    }
  });
});

describe('OAuth refusals (B2)', () => {
  it('a bad credential at consent is refused without confirming it was real (401 + re-render)', async () => {
    const server = await startTestServer();
    try {
      const clientId = await registerClient(server.httpBase);
      const { challenge } = pkce();
      const res = await fetch(`${server.httpBase}/authorize/consent`, {
        method: 'POST',
        headers: CT_FORM,
        redirect: 'manual',
        body: new URLSearchParams({
          client_id: clientId,
          redirect_uri: REDIRECT,
          code_challenge: challenge,
          scope: 'playroom',
          credential: 'prm_not-a-real-credential',
        }),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
      expect(await res.text()).toContain('not accepted');
    } finally {
      await server.close();
    }
  });

  it('PKCE must verify — a wrong code_verifier is invalid_grant', async () => {
    const server = await startTestServer();
    try {
      const base = server.httpBase;
      const clientId = await registerClient(base);
      const { challenge } = pkce();
      const consent = await fetch(`${base}/authorize/consent`, {
        method: 'POST',
        headers: CT_FORM,
        redirect: 'manual',
        body: new URLSearchParams({
          client_id: clientId,
          redirect_uri: REDIRECT,
          code_challenge: challenge,
          credential: server.token,
        }),
      });
      const code = new URL(consent.headers.get('location') as string).searchParams.get(
        'code',
      ) as string;
      const res = await fetch(`${base}/token`, {
        method: 'POST',
        headers: CT_FORM,
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: 'the-wrong-verifier',
          client_id: clientId,
          redirect_uri: REDIRECT,
        }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
    } finally {
      await server.close();
    }
  });

  it('an authorization code is single-use — a second exchange is invalid_grant', async () => {
    const server = await startTestServer();
    try {
      const base = server.httpBase;
      const clientId = await registerClient(base);
      const { verifier, challenge } = pkce();
      const consent = await fetch(`${base}/authorize/consent`, {
        method: 'POST',
        headers: CT_FORM,
        redirect: 'manual',
        body: new URLSearchParams({
          client_id: clientId,
          redirect_uri: REDIRECT,
          code_challenge: challenge,
          credential: server.token,
        }),
      });
      const code = new URL(consent.headers.get('location') as string).searchParams.get(
        'code',
      ) as string;
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT,
      });
      expect(
        (await fetch(`${base}/token`, { method: 'POST', headers: CT_FORM, body })).status,
      ).toBe(200);
      const second = await fetch(`${base}/token`, {
        method: 'POST',
        headers: CT_FORM,
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id: clientId,
          redirect_uri: REDIRECT,
        }),
      });
      expect(second.status).toBe(400);
      expect(((await second.json()) as { error: string }).error).toBe('invalid_grant');
    } finally {
      await server.close();
    }
  });
});

// ═══ B2 — THE GRANT LIFECYCLE (review fixes F1/F2/F6) ═══
//
// A subscription token is not a standalone bearer: it is one link in a chain that reaches back to the prm_
// credential that granted it. Revoke that credential and every token minted from it dies; rotate a refresh
// token and replaying the old one severs the whole family; one /revoke on either half of a grant cuts the
// other half too. These are the properties that make "sever this subscription" a single, trustworthy action.

describe('OAuth grant lifecycle (B2)', () => {
  it('revoking the granting prm_ credential cascades to its OAuth tokens', async () => {
    const server = await startTestServer();
    try {
      // A throwaway prince credential — NOT server.token, which support.ts needs live at teardown.
      const granting = await issueCredential(pool, 'prince', 'oauth-cascade');
      extraCredentialIds.push(granting.id);
      const { tokens } = await login(server, granting.token);
      expect(await mcpToolCount(server.httpBase, tokens.access_token)).toBe(8);

      // The operator's response to a leaked credential: revoke it. verifyOAuthToken joins the credential,
      // so the access token minted from it stops resolving — no per-token revocation needed.
      await revokeCredential(pool, granting.id);
      await expect(mcpToolCount(server.httpBase, tokens.access_token)).rejects.toBeTruthy();
    } finally {
      await server.close();
    }
  });

  it('replaying a rotated refresh token revokes the whole family (breach detection)', async () => {
    const server = await startTestServer();
    try {
      const { clientId, tokens } = await login(server, server.token);

      // Rotate once: refresh1 is spent, refresh2 + access2 are minted in the same family. access2 works.
      const rotated = await fetch(`${server.httpBase}/token`, {
        method: 'POST',
        headers: CT_FORM,
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
          client_id: clientId,
        }),
      });
      expect(rotated.status).toBe(200);
      const next = (await rotated.json()) as Record<string, string>;
      expect(await mcpToolCount(server.httpBase, next.access_token)).toBe(8);

      // Replay the ALREADY-ROTATED refresh1 — the breach signal. It is refused AND the family is revoked,
      // so the thief and the victim both lose the grant: access2 stops working too.
      const replay = await fetch(`${server.httpBase}/token`, {
        method: 'POST',
        headers: CT_FORM,
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
          client_id: clientId,
        }),
      });
      expect(replay.status).toBe(400);
      expect(((await replay.json()) as { error: string }).error).toBe('invalid_grant');
      await expect(mcpToolCount(server.httpBase, next.access_token)).rejects.toBeTruthy();
    } finally {
      await server.close();
    }
  });

  it('/revoke on the refresh token severs the paired access token (family revoke)', async () => {
    const server = await startTestServer();
    try {
      const { tokens } = await login(server, server.token);
      expect(await mcpToolCount(server.httpBase, tokens.access_token)).toBe(8);
      // Present the REFRESH token to /revoke; the ACCESS token in the same family must die with it, or a
      // "revoked" subscription would keep working through its other half.
      const rev = await fetch(`${server.httpBase}/revoke`, {
        method: 'POST',
        headers: CT_FORM,
        body: new URLSearchParams({ token: tokens.refresh_token }),
      });
      expect(rev.status).toBe(200);
      await expect(mcpToolCount(server.httpBase, tokens.access_token)).rejects.toBeTruthy();
    } finally {
      await server.close();
    }
  });

  it('a refresh presented with the wrong client_id fails without burning the token', async () => {
    const server = await startTestServer();
    try {
      const { clientId, tokens } = await login(server, server.token);
      const otherClient = await registerClient(server.httpBase);
      expect(otherClient).not.toBe(clientId);

      // Wrong client: the consuming UPDATE matches nothing (client_id guard), and the token is NOT revoked —
      // so this is a plain invalid_grant, not a family-killing reuse event.
      const wrong = await fetch(`${server.httpBase}/token`, {
        method: 'POST',
        headers: CT_FORM,
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
          client_id: otherClient,
        }),
      });
      expect(wrong.status).toBe(400);
      expect(((await wrong.json()) as { error: string }).error).toBe('invalid_grant');

      // The right client can still redeem the very same refresh token — it was never burned.
      const right = await fetch(`${server.httpBase}/token`, {
        method: 'POST',
        headers: CT_FORM,
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
          client_id: clientId,
        }),
      });
      expect(right.status).toBe(200);
      const next = (await right.json()) as Record<string, string>;
      expect(await mcpToolCount(server.httpBase, next.access_token)).toBe(8);
    } finally {
      await server.close();
    }
  });

  it('the consent surface is throttled per IP (F7)', async () => {
    // Drive the OAuth throttle to a tiny budget so a handful of bad-credential guesses reaches a 429.
    const server = await startTestServer({ oauthRateMax: 3, oauthRateWindowMs: 60_000 });
    try {
      const clientId = await registerClient(server.httpBase);
      const { challenge } = pkce();
      const attempt = () =>
        fetch(`${server.httpBase}/authorize/consent`, {
          method: 'POST',
          headers: CT_FORM,
          redirect: 'manual',
          body: new URLSearchParams({
            client_id: clientId,
            redirect_uri: REDIRECT,
            code_challenge: challenge,
            credential: 'prm_guessing',
          }),
        });
      // The first few are refused as bad credentials (401); once the per-IP budget is spent the door 429s
      // before the credential is even looked at.
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await attempt()).status);
      expect(statuses.filter((s) => s === 401).length).toBeGreaterThan(0);
      expect(statuses).toContain(429);
    } finally {
      await server.close();
    }
  });
});
