import { afterAll, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import {
  ERROR_CREDENTIAL_INVALID,
  ERROR_CREDENTIAL_REQUIRED,
  ERROR_SIGNER_NOT_HUMAN,
  type AgentAdapter,
  type AgentTurnChunk,
} from '@playroom/shared';
import {
  startTestServer,
  testPool,
  uniqueRoomId,
  httpCreateRoom,
  admitToRoom,
  type TestServer,
} from './support.js';
import { issueCredential, revokeCredential } from '../src/credentials.js';
import { RoomBus } from '../src/bus.js';
import { executeCommand, type CommandDeps } from '../src/commands/index.js';

/**
 * ═══ S2.1b — THE AUTHENTICATED DOOR (Phase 1: the door, identity derived) ═══
 *
 * The first inbound path from outside the api. It authenticates a MEMBER and carries no authority of its
 * own: the credential resolves to a member, the member to a principal and mandate, and the request is
 * ruled on against THAT mandate. Identity is DERIVED, never claimed — the body says what it wants, never
 * who it is. Revocation and expiry refuse, distinguishably in the LOG (collapsed on the wire per the
 * credentials.ts ruling), and none of them resembles a mandate refusal. The door is throttled. Nothing
 * executes. ASSERT THE MECHANISM: the reason code, the mandate hash, and WHICH check refused.
 */

const pool = testPool();
const rooms: string[] = [];
const creds: string[] = [];
function room(prefix: string): string {
  const id = uniqueRoomId(prefix);
  rooms.push(id);
  return id;
}

// A synthetic test credential for a member. `revoked` revokes it; `expiredHoursAgo` back-dates its
// expiry so `authenticate` rejects it — both real product paths, driven with test-only rows.
async function cred(
  memberId: string,
  opts: { expiredHoursAgo?: number; revoked?: boolean } = {},
): Promise<string> {
  const issued = await issueCredential(pool, memberId, 's21b-door-test');
  creds.push(issued.id);
  if (opts.expiredHoursAgo) {
    await pool.query(
      "UPDATE member_credentials SET expires_at = now() - ($2::numeric * interval '1 hour') WHERE id = $1",
      [issued.id, opts.expiredHoursAgo],
    );
  }
  if (opts.revoked) await revokeCredential(pool, issued.id);
  return issued.token;
}

afterAll(async () => {
  for (const id of creds) await pool.query('DELETE FROM member_credentials WHERE id = $1', [id]);
  for (const id of rooms) {
    await pool.query('DELETE FROM events WHERE room_id = $1', [id]);
    await pool.query('DELETE FROM room_members WHERE room_id = $1', [id]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [id]);
  }
  await pool.end();
});

interface DoorBody {
  decision?: string;
  reason_code?: string;
  effective_mandate_hash?: string | null;
  required_signer?: string | null;
  decision_id?: string | null;
  code?: string;
  message?: string;
  status?: string;
  resolution?: string | null;
  signed_by?: string | null;
}
async function jsonBody(res: Response): Promise<DoorBody> {
  return (await res.json()) as DoorBody;
}
async function postAction(
  server: TestServer,
  roomId: string,
  token: string | undefined,
  body: unknown,
): Promise<Response> {
  return fetch(`${server.httpBase}/rooms/${roomId}/actions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

interface DecisionPayload {
  subject: string;
  action: string;
  decision: string;
  reason_code: string;
  required_signer: string | null;
  effective_mandate_hash: string | null;
}
async function decisionRows(roomId: string): Promise<DecisionPayload[]> {
  const { rows } = await pool.query<{ payload: DecisionPayload }>(
    "SELECT payload FROM events WHERE room_id = $1 AND event_type = 'decision' ORDER BY seq",
    [roomId],
  );
  return rows.map((r) => r.payload);
}
function capture(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  return {
    lines,
    stream: new Writable({
      write(chunk: Buffer, _e, cb) {
        lines.push(chunk.toString());
        cb();
      },
    }),
  };
}

describe('S2.1b Phase 1 — the door: authenticated ingress, identity derived', () => {
  it('a valid credential makes a governed request and receives a verdict', async () => {
    const server = await startTestServer();
    const roomId = room('s21b-ok');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    await admitToRoom(roomId, 'claude-main');
    const token = await cred('claude-main');
    try {
      const res = await postAction(server, roomId, token, {
        action: 'secrets.read',
        resource: 'vault:prod/db',
      });
      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      // THE VERDICT travels the wire — the mechanism, not the outcome. secrets.read is out of scope.
      expect(body.decision).toBe('BLOCK');
      expect(body.reason_code).toBe('OUT_OF_SCOPE');
      expect(body.effective_mandate_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    } finally {
      await server.close();
    }
  });

  it('identity is DERIVED from the credential — a body naming a different member does not win', async () => {
    const server = await startTestServer();
    const roomId = room('s21b-derive');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    await admitToRoom(roomId, 'claude-main');
    const token = await cred('claude-main');
    try {
      // The body tries to claim it is sol / jerry. Every one of those is ignored: the subject is the
      // CREDENTIAL's member (claude-main), looked up, never read from the wire.
      const res = await postAction(server, roomId, token, {
        action: 'pr.merge',
        resource: 'repo:playroom/playroom#pr-1',
        subject: 'sol',
        member: 'sol',
        principal: 'principal:jerry',
      });
      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(body.decision).toBe('CO_SIGN');
      // The signer is claude-main's principal (prince), NOT jerry's — the body could not choose it.
      expect(body.required_signer).toBe('principal:prince');
      const rows = await decisionRows(roomId);
      expect(rows).toHaveLength(1);
      expect(rows[0].subject).toBe('claude-main'); // NOT 'sol'
    } finally {
      await server.close();
    }
  });

  it('a revoked credential is refused immediately, and reaches no evaluator', async () => {
    const server = await startTestServer();
    const roomId = room('s21b-revoked');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    await admitToRoom(roomId, 'claude-main');
    const token = await cred('claude-main', { revoked: true });
    try {
      const res = await postAction(server, roomId, token, {
        action: 'pr.review',
        resource: 'repo:playroom/playroom#pr-1',
      });
      expect(res.status).toBe(401);
      expect((await jsonBody(res)).code).toBe(ERROR_CREDENTIAL_INVALID);
      // AN AUTH FAILURE IS NOT A MANDATE REFUSAL: nothing reached the evaluator, so no decision exists.
      expect(await decisionRows(roomId)).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('unknown / expired / revoked collapse to one WIRE code but are distinct in the OPERATOR log; none is a mandate refusal', async () => {
    const { lines, stream } = capture();
    const server = await startTestServer({ loggerStream: stream, logLevel: 'info' });
    const roomId = room('s21b-distinct');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    await admitToRoom(roomId, 'claude-main');
    const revoked = await cred('claude-main', { revoked: true });
    const expired = await cred('claude-main', { expiredHoursAgo: 1 });
    const unknown = `prm_${'0'.repeat(64)}`; // well-formed shape, matches no row
    try {
      const rRev = await postAction(server, roomId, revoked, {
        action: 'pr.review',
        resource: 'r',
      });
      const rExp = await postAction(server, roomId, expired, {
        action: 'pr.review',
        resource: 'r',
      });
      const rUnk = await postAction(server, roomId, unknown, {
        action: 'pr.review',
        resource: 'r',
      });
      const rMissing = await postAction(server, roomId, undefined, {
        action: 'pr.review',
        resource: 'r',
      });
      // WIRE: the three real-but-bad tokens all return the SAME code — no leak that a token was ever real.
      expect(rRev.status).toBe(401);
      expect((await jsonBody(rRev)).code).toBe(ERROR_CREDENTIAL_INVALID);
      expect(rExp.status).toBe(401);
      expect((await jsonBody(rExp)).code).toBe(ERROR_CREDENTIAL_INVALID);
      expect(rUnk.status).toBe(401);
      expect((await jsonBody(rUnk)).code).toBe(ERROR_CREDENTIAL_INVALID);
      // A MISSING credential is its own code — a client never wired, not a token that failed.
      expect(rMissing.status).toBe(401);
      expect((await jsonBody(rMissing)).code).toBe(ERROR_CREDENTIAL_REQUIRED);
      // LOG: the operator CAN tell them apart — the distinction the wire deliberately withholds.
      const raw = lines.join('');
      expect(raw).toContain('"reason":"revoked"');
      expect(raw).toContain('"reason":"expired"');
      expect(raw).toContain('"reason":"unknown"');
      expect(raw).toContain('"reason":"missing"');
      // NONE resembles a mandate refusal: all are 401s, and NO decision event was written by any of them.
      expect(await decisionRows(roomId)).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('the door is throttled per credential, at the configured limit', async () => {
    const server = await startTestServer({ actionRateMax: 3, actionRateWindowMs: 60_000 });
    const roomId = room('s21b-throttle');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    await admitToRoom(roomId, 'claude-main');
    const token = await cred('claude-main');
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await postAction(server, roomId, token, {
          action: 'pr.review',
          resource: `r-${i}`,
        });
        statuses.push(r.status);
      }
      // The limit is 3 per window: the first three pass, the fourth and fifth are throttled — a 429,
      // which is an AUTH-layer refusal, never mistakable for a mandate BLOCK (a 200 with a verdict).
      expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
      expect(statuses[3]).toBe(429);
      expect(statuses[4]).toBe(429);
    } finally {
      await server.close();
    }
  });
});

async function getDecision(
  server: TestServer,
  roomId: string,
  token: string | undefined,
  decisionId: string,
): Promise<Response> {
  return fetch(`${server.httpBase}/rooms/${roomId}/decisions/${decisionId}`, {
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
}

// A CommandDeps for driving the human sign path directly — there is no agent-signing frame by design,
// and the door has no resolve endpoint, so a signature is dispatched at the command. The stub adapter is
// never called: a pr.merge approval has no executor (S2.6), and none of these decisions is a summon.
function makeDeps(): CommandDeps {
  const stub: AgentAdapter = {
    id: 'stub',
    async *stream(): AsyncGenerator<AgentTurnChunk> {},
  };
  const deps: CommandDeps = {
    pool,
    bus: new RoomBus(),
    log: { info() {}, warn() {}, error() {} },
    adapterFactory: () => stub,
    execute: (cx, cmd) => executeCommand(cx, cmd, deps),
  };
  return deps;
}

describe('S2.1b Phase 2 — the round trip: verdicts over the wire, and polling a decision', () => {
  it('all three verdicts travel the wire against the real mandate', async () => {
    const { lines, stream } = capture();
    const server = await startTestServer({ loggerStream: stream, logLevel: 'info' });
    const roomId = room('s21b-verdicts');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    await admitToRoom(roomId, 'claude-main');
    const token = await cred('claude-main');
    try {
      // ALLOW — in scope, not protected. A4-F1: no decision event, so the decision_id is null and the
      // verdict is proven from the wire body plus the audit line.
      const allow = await jsonBody(
        await postAction(server, roomId, token, { action: 'pr.review', resource: 'repo:x#1' }),
      );
      expect(allow.decision).toBe('ALLOW');
      expect(allow.reason_code).toBe('ALLOWED_IN_SCOPE');
      expect(allow.decision_id).toBeNull();
      expect(lines.join('')).toContain('ALLOWED_IN_SCOPE');

      // CO_SIGN — protected. The signer is named and a decision id comes back to poll.
      const cosign = await jsonBody(
        await postAction(server, roomId, token, { action: 'pr.merge', resource: 'repo:x#1' }),
      );
      expect(cosign.decision).toBe('CO_SIGN');
      expect(cosign.reason_code).toBe('PROTECTED_ACTION');
      expect(cosign.required_signer).toBe('principal:prince');
      expect(cosign.decision_id).toMatch(/^dec_/);

      // BLOCK — out of scope, deny-by-default, by reason code and mandate hash.
      const block = await jsonBody(
        await postAction(server, roomId, token, { action: 'deploy', resource: 'env:prod' }),
      );
      expect(block.decision).toBe('BLOCK');
      expect(block.reason_code).toBe('OUT_OF_SCOPE');
      expect(block.effective_mandate_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    } finally {
      await server.close();
    }
  });

  it('a pending CO_SIGN reads as pending, then resolved with who signed — by polling, never a callback', async () => {
    const server = await startTestServer();
    const roomId = room('s21b-poll');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    await admitToRoom(roomId, 'claude-main');
    const token = await cred('claude-main');
    try {
      const raised = await jsonBody(
        await postAction(server, roomId, token, { action: 'pr.merge', resource: 'repo:x#1' }),
      );
      expect(raised.decision).toBe('CO_SIGN');
      expect(raised.decision_id).toBeTruthy();
      const decId = raised.decision_id as string;

      // POLL: pending. The caller ASKS; Playroom never calls the caller back.
      const p1 = await jsonBody(await getDecision(server, roomId, token, decId));
      expect(p1.status).toBe('pending');
      expect(p1.decision).toBe('CO_SIGN');
      expect(p1.required_signer).toBe('principal:prince');
      expect(p1.resolution).toBeNull();

      // A HUMAN signs — the separate human path (the door offers no resolution endpoint).
      const signed = await executeCommand(
        { actorId: 'prince', mode: 'human' },
        {
          kind: 'signDecision',
          roomId,
          clientMsgId: 'sign-1',
          decisionId: decId,
          resolution: 'APPROVED',
        },
        makeDeps(),
      );
      expect(signed.ok).toBe(true);

      // POLL: resolved, with who signed — the fate learned by asking again.
      const p2 = await jsonBody(await getDecision(server, roomId, token, decId));
      expect(p2.status).toBe('resolved');
      expect(p2.resolution).toBe('APPROVED');
      expect(p2.signed_by).toBe('prince');
    } finally {
      await server.close();
    }
  });

  it('a caller may not resolve its own pending decision — an agent may never sign', async () => {
    const server = await startTestServer();
    const roomId = room('s21b-nosign');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    await admitToRoom(roomId, 'claude-main');
    const token = await cred('claude-main');
    try {
      const raised = await jsonBody(
        await postAction(server, roomId, token, { action: 'pr.merge', resource: 'repo:x#1' }),
      );
      const decId = raised.decision_id as string;
      // The door caller is claude-main (an agent). The door has no resolve endpoint, and if the sign
      // command is reached at all, an agent may never sign — checked against the member's KIND.
      const attempt = await executeCommand(
        { actorId: 'claude-main', mode: 'connected' },
        {
          kind: 'signDecision',
          roomId,
          clientMsgId: 'agent-sign',
          decisionId: decId,
          resolution: 'APPROVED',
        },
        makeDeps(),
      );
      expect(attempt.ok).toBe(false);
      if (!attempt.ok) expect(attempt.refusal.code).toBe(ERROR_SIGNER_NOT_HUMAN);
      // Still pending — the agent's refused attempt changed nothing.
      const poll = await jsonBody(await getDecision(server, roomId, token, decId));
      expect(poll.status).toBe('pending');
    } finally {
      await server.close();
    }
  });

  it('nothing executes on ALLOW — the verdict returns, no decision event, no side effect', async () => {
    const server = await startTestServer();
    const roomId = room('s21b-allow-noexec');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    await admitToRoom(roomId, 'claude-main');
    const token = await cred('claude-main');
    try {
      const allow = await jsonBody(
        await postAction(server, roomId, token, { action: 'pr.comment', resource: 'repo:x#1' }),
      );
      expect(allow.decision).toBe('ALLOW');
      expect(allow.decision_id).toBeNull();
      // No decision event was written (A4-F1), and there is no executor to run — the mechanism by which
      // "nothing happened" is a property of the design, not the absence of an observable.
      expect(await decisionRows(roomId)).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});

describe('S2.1b Phase 3 — adversarial: a stranger, refused by a record it cannot edit', () => {
  it('THE HEADLINE: a valid credential asking an out-of-scope action is refused by the MANDATE, not by auth', async () => {
    const server = await startTestServer();
    const roomId = room('s21b-headline');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    await admitToRoom(roomId, 'claude-main');
    const token = await cred('claude-main'); // a credential the server issued moments ago and never "met"
    try {
      const res = await postAction(server, roomId, token, {
        action: 'secrets.read',
        resource: 'vault:prod/db',
      });
      // Auth SUCCEEDED — the door met the caller — so this is a 200 carrying a verdict, NOT a 401. The
      // refusal is the MANDATE's, by scope, on a record the caller cannot edit. That is the whole slice.
      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(body.decision).toBe('BLOCK');
      expect(body.reason_code).toBe('OUT_OF_SCOPE');
      expect(body.effective_mandate_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    } finally {
      await server.close();
    }
  });

  it('replay is NOT deduplicated today — two identical requests produce two decisions (recorded gap, S21B-N1)', async () => {
    // Replay protection needs a decisions table + nonce (evaluate.ts: "S2.1 … neither of which exists").
    // So a replayed request produces a SECOND decision. This is PINNED, not implied away: the day replay
    // protection lands, this fails and forces the update, rather than the door pretending to a guarantee
    // it does not have. TRIGGER: S2.1's replay branch (nonce + resource-hash against the decisions table).
    const server = await startTestServer();
    const roomId = room('s21b-replay');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    await admitToRoom(roomId, 'claude-main');
    const token = await cred('claude-main');
    try {
      const body = { action: 'secrets.read', resource: 'vault:x', client_msg_id: 'replay-1' };
      await postAction(server, roomId, token, body);
      await postAction(server, roomId, token, body); // byte-identical replay, same client_msg_id
      // TWO decisions — replay is not deduped. The recorded gap, not a silent one.
      expect(await decisionRows(roomId)).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it('a credential determines the member — a sol credential acts as sol, never as another', async () => {
    const server = await startTestServer();
    const roomId = room('s21b-crossmember');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    await admitToRoom(roomId, 'sol');
    const token = await cred('sol');
    try {
      const res = await postAction(server, roomId, token, {
        action: 'secrets.read',
        resource: 'vault:x',
      });
      expect(res.status).toBe(200);
      const rows = await decisionRows(roomId);
      expect(rows).toHaveLength(1);
      // The decision is sol's, decided by WHICH CREDENTIAL was presented — never claude-main's or anyone's.
      expect(rows[0].subject).toBe('sol');
    } finally {
      await server.close();
    }
  });

  it('a credential whose member has NO mandate is refused deny-by-default — distinct from an out-of-scope refusal', async () => {
    const server = await startTestServer();
    const roomId = room('s21b-nomandate');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    const token = await cred('prince'); // prince is a human member with no mandate document
    try {
      const res = await postAction(server, roomId, token, {
        action: 'pr.review',
        resource: 'repo:x#1',
      });
      // Auth SUCCEEDED (a valid credential) — so this is a MANDATE refusal, not an auth one. A member with
      // no mandate has NO authority at all: BLOCK / NO_MANDATE, deny-by-default (§10). NO_MANDATE is a
      // different reason code from OUT_OF_SCOPE — "no authority" is not "authority that omits this action".
      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(body.decision).toBe('BLOCK');
      expect(body.reason_code).toBe('NO_MANDATE');
    } finally {
      await server.close();
    }
  });

  it('oversized, malformed and hostile bodies are rejected at the schema, before the evaluator', async () => {
    const server = await startTestServer();
    const roomId = room('s21b-badbody');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    await admitToRoom(roomId, 'claude-main');
    const token = await cred('claude-main');
    try {
      const bad: unknown[] = [
        {}, // missing both
        { action: 'pr.review' }, // missing resource
        { resource: 'repo:x#1' }, // missing action
        { action: 'x'.repeat(65), resource: 'repo:x#1' }, // action too long
        { action: 'pr.review', resource: 'x'.repeat(600) }, // resource too long / oversized
        { action: 42, resource: 'repo:x#1' }, // wrong type
        { action: 'pr.review', resource: { evil: true } }, // hostile shape
      ];
      for (const body of bad) {
        const res = await postAction(server, roomId, token, body);
        expect(res.status).toBe(400);
        expect((await jsonBody(res)).code).toBe('action_malformed');
      }
      // NONE of them reached the evaluator: no decision event exists.
      expect(await decisionRows(roomId)).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('the throttle holds under burst and says so', async () => {
    const server = await startTestServer({ actionRateMax: 2, actionRateWindowMs: 60_000 });
    const roomId = room('s21b-burst');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    await admitToRoom(roomId, 'claude-main');
    const token = await cred('claude-main');
    try {
      let throttled: DoorBody | undefined;
      let sawThrottle = false;
      for (let i = 0; i < 6; i++) {
        const r = await postAction(server, roomId, token, {
          action: 'pr.review',
          resource: `r-${i}`,
        });
        if (r.status === 429) {
          sawThrottle = true;
          throttled = await jsonBody(r);
          break;
        }
      }
      // The burst hit the ceiling, and the refusal NAMES itself — never a silent drop.
      expect(sawThrottle).toBe(true);
      expect(throttled?.code).toBe('action_throttled');
    } finally {
      await server.close();
    }
  });
});
