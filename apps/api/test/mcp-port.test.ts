import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AgentAdapter, AgentTurnChunk } from '@playroom/shared';
import { RoomMcpError } from '@playroom/hosts';
import { testPool, uniqueRoomId, startTestServer } from './support.js';
import { RoomBus } from '../src/bus.js';
import { createRoom } from '../src/events.js';
import { executeCommand, type CommandDeps } from '../src/commands/index.js';
import { roomMcpPortFor } from '../src/mcp.js';

// ═══ B1 — THE MCP PORT OVER THE COMMAND LAYER, AGAINST THE REAL DATABASE ═══
//
// mcp-tools.test.ts proved the adapter; this proves the WIRING. A tool call reaches executeCommand — the
// same trust fabric every surface uses — so: a message is attributed to the CREDENTIAL's member and no
// other, a governed action is ruled under the member's SIGNED mandate (A1), the co-sign loop resolves end
// to end (the "drive a room from a subscription, approve on your phone" scenario), and a non-member is
// refused a room the same way a missing one is. No new authority: the MCP surface is a front door, not a key.

const pool = testPool();
const rooms: string[] = [];

function scripted(id: string): AgentAdapter {
  return {
    id,
    async *stream(): AsyncGenerator<AgentTurnChunk> {
      yield { kind: 'done', tokens_in: 0, tokens_out: 0, stop_reason: 'end_turn' };
    },
  };
}

function deps(): CommandDeps {
  const d: CommandDeps = {
    pool,
    bus: new RoomBus(),
    log: { info() {}, warn() {}, error() {} },
    adapterFactory: (id) => scripted(id),
    execute: (ctx, command) => executeCommand(ctx, command, d),
  };
  return d;
}

const claudeMain = () =>
  roomMcpPortFor({ memberId: 'claude-main', principalId: 'principal:prince' }, deps());

/**
 * A fresh room. Creation BLANKET-ENROLS every seeded member today (a scoped Room Door is ADR-009, not yet
 * built), so all of claude-main/sol/prince start as members. Tests that need a genuine NON-member call
 * `deEnrol` to remove one — which is exactly the state the gate and the scoping query must handle, and the
 * state every room will be in once the Door lands.
 */
async function room(): Promise<string> {
  const roomId = uniqueRoomId('mcp');
  rooms.push(roomId);
  await createRoom(pool, roomId, roomId, 'prince');
  return roomId;
}

/** Remove one member from a room's roster — manufacturing the non-member state blanket-enrolment hides. */
async function deEnrol(roomId: string, member: string): Promise<void> {
  await pool.query('DELETE FROM room_members WHERE room_id = $1 AND member_id = $2', [
    roomId,
    member,
  ]);
}

afterEach(async () => {
  for (const r of rooms) {
    await pool.query('DELETE FROM interrupts WHERE room_id = $1', [r]);
    await pool.query('DELETE FROM events WHERE room_id = $1', [r]);
    await pool.query('DELETE FROM room_members WHERE room_id = $1', [r]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [r]);
  }
  rooms.length = 0;
});

afterAll(async () => {
  await pool.end();
});

describe('roomMcpPortFor — the governed loop over the command layer (B1)', () => {
  it('list_rooms is scoped to the acting member — no cross-member enumeration', async () => {
    const roomId = await room();
    await deEnrol(roomId, 'sol'); // sol is no longer in this room
    expect((await claudeMain().listRooms()).some((r) => r.id === roomId)).toBe(true);
    // sol is not enrolled; the room does not appear for them.
    const solRooms = await roomMcpPortFor(
      { memberId: 'sol', principalId: 'principal:jerry' },
      deps(),
    ).listRooms();
    expect(solRooms.some((r) => r.id === roomId)).toBe(false);
  });

  it('post_message writes one event ATTRIBUTED to the credential member — identity is derived', async () => {
    const roomId = await room();
    const { seq } = await claudeMain().postMessage({ roomId, body: 'hello from a subscription' });
    const { rows } = await pool.query<{ actor_id: string; event_type: string }>(
      'SELECT actor_id, event_type FROM events WHERE room_id = $1 AND seq = $2',
      [roomId, seq],
    );
    expect(rows).toHaveLength(1);
    // NOT any other member: the tool carried no identity, so attribution can only be the credential's.
    expect(rows[0].actor_id).toBe('claude-main');
    expect(rows[0].event_type).toBe('message');
  });

  it('request_action rules under the SIGNED mandate (A1) — pr.merge is CO_SIGN, never SIGNATURE_INVALID', async () => {
    const roomId = await room();
    const v = await claudeMain().requestAction({
      roomId,
      action: 'pr.merge',
      resource: 'repo:x#1',
    });
    expect(v.decision).toBe('CO_SIGN');
    // PROTECTED_ACTION (not SIGNATURE_INVALID) proves the shipped signed mandate passed the §0 gate.
    expect(v.reason_code).toBe('PROTECTED_ACTION');
    expect(v.required_signer).toBe('principal:prince');
    expect(v.decision_id).toBeTruthy();
    expect(v.poll_after_ms).toBeGreaterThan(0);
  });

  it('respond_to_decision resolves the co-sign loop — a human signer approves through MCP', async () => {
    const roomId = await room();
    const v = await claudeMain().requestAction({
      roomId,
      action: 'pr.merge',
      resource: 'repo:x#1',
    });
    expect(v.decision_id).toBeTruthy();
    // The human signer (prince, the room owner) approves — the phone half of the flagship scenario.
    const prince = roomMcpPortFor({ memberId: 'prince', principalId: 'principal:prince' }, deps());
    expect(
      await prince.respondToDecision({
        roomId,
        decisionId: v.decision_id!,
        resolution: 'APPROVED',
      }),
    ).toEqual({
      ok: true,
    });
    const { rows } = await pool.query(
      `SELECT 1 FROM events WHERE room_id = $1 AND event_type = 'decision.resolved' AND payload ->> 'decision_id' = $2`,
      [roomId, v.decision_id],
    );
    expect(rows).toHaveLength(1);
  });

  it('the membership gate refuses a non-member with room_not_found — no existence leak', async () => {
    const roomId = await room();
    await deEnrol(roomId, 'sol'); // now genuinely not a member (blanket-enrolment removed)
    const sol = roomMcpPortFor({ memberId: 'sol', principalId: 'principal:jerry' }, deps());
    await expect(sol.readRoom(roomId)).rejects.toBeInstanceOf(RoomMcpError);
    await expect(sol.readRoom(roomId)).rejects.toMatchObject({ code: 'room_not_found' });
    await expect(sol.postMessage({ roomId, body: 'x' })).rejects.toMatchObject({
      code: 'room_not_found',
    });
    await expect(
      sol.requestAction({ roomId, action: 'pr.review', resource: 'r' }),
    ).rejects.toMatchObject({ code: 'room_not_found' });
  });

  it('read_room returns the roster, recent transcript and briefing state', async () => {
    const roomId = await room();
    await claudeMain().postMessage({ roomId, body: 'first' });
    const view = await claudeMain().readRoom(roomId);
    expect(view.id).toBe(roomId);
    expect(view.members).toContain('claude-main');
    expect(view.recent.some((e) => e.body === 'first')).toBe(true);
    expect(view.briefing).toBeNull();
  });
});

describe('pending tags — mentions with nothing to answer them (B3)', () => {
  // The recipient is a member NOT answered by a hosted summon — a human member (prince) driving via a
  // connection. Mentioning it drops the tag (it is not summonable), which is exactly what this surfaces.
  // The mentioner is claude-main; an agent-authored message never fires a summon, so nothing else moves.
  const princePort = () =>
    roomMcpPortFor({ memberId: 'prince', principalId: 'principal:prince' }, deps());
  const mine = (roomId: string) =>
    princePort()
      .listPendingTags()
      .then((all) => all.filter((p) => p.room_id === roomId));

  it('surfaces a message that @-mentions the member, with author and snippet', async () => {
    const roomId = await room();
    await claudeMain().postMessage({ roomId, body: '@prince please decide on pr-1' });
    const pending = await mine(roomId);
    expect(pending).toHaveLength(1);
    expect(pending[0].from).toBe('claude-main');
    expect(pending[0].snippet).toContain('@prince');
    expect(pending[0].seq).toBeGreaterThan(0);
  });

  it('matches the exact tag, not a superstring — @princeps is not @prince', async () => {
    const roomId = await room();
    await claudeMain().postMessage({ roomId, body: 'ping @princeps, not you' });
    expect(await mine(roomId)).toHaveLength(0);
  });

  it('DRAINS once the member acts in that room — pending is measured since last activity', async () => {
    const roomId = await room();
    await claudeMain().postMessage({ roomId, body: '@prince early' });
    expect(await mine(roomId)).toHaveLength(1);
    await princePort().postMessage({ roomId, body: 'looking now' }); // prince acts -> clears it
    expect(await mine(roomId)).toHaveLength(0);
  });

  it("does not surface the member's own mentions or the room's system notices", async () => {
    const roomId = await room();
    await princePort().postMessage({ roomId, body: '@prince note to self' });
    expect(await mine(roomId)).toHaveLength(0);
  });

  it('is scoped to the rooms the member is in — a mention in a room it left is not surfaced', async () => {
    const roomId = await room();
    await claudeMain().postMessage({ roomId, body: '@prince here' });
    await deEnrol(roomId, 'prince'); // prince leaves the room
    expect(await mine(roomId)).toHaveLength(0);
  });
});

describe('the /mcp route (B1)', () => {
  it('refuses a request with no credential — 401, before any MCP handling', async () => {
    const server = await startTestServer();
    try {
      const res = await fetch(`${server.httpBase}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(res.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('applies the SCC per-credential throttle — a bounded credential gets 429, not an unbounded surface', async () => {
    // The B1 review's F1: the MCP door must not grant a governed-request rate the action door refuses.
    // actionRateMax: 0 puts every authenticated request over budget, so an AUTHENTICATED /mcp call (past the
    // 401 gate) is refused 429 with the same per-credential control — proving the bound is applied, not skipped.
    const server = await startTestServer({ actionRateMax: 0 });
    try {
      const res = await fetch(`${server.httpBase}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${server.token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(res.status).toBe(429);
      expect(((await res.json()) as { code?: string }).code).toBe('mcp_throttled');
    } finally {
      await server.close();
    }
  });

  // THE FLAGSHIP SCENARIO, END TO END: a real MCP client, over Streamable HTTP, authenticated with a Bearer
  // credential, driving a room through the whole stack — transport → tools → executeCommand → Postgres. This
  // is "drive a room from a subscription": nothing is faked, and the message lands attributed to the
  // credential's member.
  it('a real MCP client drives a room over Streamable HTTP with a Bearer credential', async () => {
    const server = await startTestServer(); // issues a real `prince` credential (server.token)
    const roomId = await room(); // prince is blanket-enrolled
    const transport = new StreamableHTTPClientTransport(new URL(`${server.httpBase}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
    });
    const client = new Client({ name: 'e2e', version: '0.0.0' });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(7);
      expect(tools.map((t) => t.name)).toContain('post_message');

      const res = await client.callTool({
        name: 'post_message',
        arguments: { room_id: roomId, body: 'driven from a subscription' },
      });
      expect(res.isError).toBeFalsy();

      // It landed, through the full stack, attributed to the credential's member — never a claim.
      const { rows } = await pool.query<{ actor_id: string }>(
        `SELECT actor_id FROM events WHERE room_id = $1 AND event_type = 'message' AND payload ->> 'body' = $2`,
        [roomId, 'driven from a subscription'],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_id).toBe('prince');
    } finally {
      await client.close().catch(() => {});
      await server.close();
    }
  });
});
