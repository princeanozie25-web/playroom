import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildRoomMcpServer, RoomMcpError, type RoomMcpPort } from '@playroom/hosts';

// ═══ B1 — THE MCP TOOL LAYER, PROVEN AGAINST A FAKE PORT (no DB, no HTTP) ═══
//
// buildRoomMcpServer is an adapter over commands: this proves the ADAPTER — the six governed-loop tools
// exist, each routes to its RoomMcpPort method with the arguments the caller sent, a governed refusal
// renders as an MCP error result, and — the load-bearing invariant — NO tool takes an identity argument.
// The port's own governance (executeCommand, membership) is proven separately in mcp-port.test.ts.

interface Call {
  m: string;
  args: unknown;
}

function recordingPort(overrides: Partial<RoomMcpPort> = {}): { port: RoomMcpPort; calls: Call[] } {
  const calls: Call[] = [];
  const port: RoomMcpPort = {
    memberId: 'claude-main',
    listRooms: () => {
      calls.push({ m: 'listRooms', args: null });
      return Promise.resolve([
        { id: 'r1', title: 'Room 1', created_at: 't', created_by: 'prince' },
      ]);
    },
    readRoom: (roomId) => {
      calls.push({ m: 'readRoom', args: { roomId } });
      return Promise.resolve({
        id: roomId,
        title: 'Room',
        created_by: 'prince',
        members: ['claude-main'],
        recent: [],
        briefing: null,
      });
    },
    postMessage: (i) => {
      calls.push({ m: 'postMessage', args: i });
      return Promise.resolve({ seq: 7 });
    },
    requestAction: (i) => {
      calls.push({ m: 'requestAction', args: i });
      return Promise.resolve({
        decision: 'CO_SIGN',
        reason_code: 'PROTECTED_ACTION',
        required_signer: 'principal:prince',
        effective_mandate_hash: 'sha256:x',
        decision_id: 'dec_1',
        poll_after_ms: 1500,
      });
    },
    respondToDecision: (i) => {
      calls.push({ m: 'respondToDecision', args: i });
      return Promise.resolve({ ok: true });
    },
    raiseHand: (i) => {
      calls.push({ m: 'raiseHand', args: i });
      return Promise.resolve({ addressed: ['prince'], raised: 1, refused: null });
    },
    ...overrides,
  };
  return { port, calls };
}

async function connect(port: RoomMcpPort): Promise<Client> {
  const server = buildRoomMcpServer(port);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientT);
  return client;
}

const GOVERNED_LOOP = [
  'list_rooms',
  'read_room',
  'post_message',
  'request_action',
  'respond_to_decision',
  'raise_hand',
].sort();

describe('the MCP tool surface (B1)', () => {
  it('exposes exactly the governed-loop tools — no more, no fewer', async () => {
    const client = await connect(recordingPort().port);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(GOVERNED_LOOP);
    // Deferred tools are NOT stubbed in: their backends (A3 receipts, B3 pending tags) do not exist yet.
    expect(tools.map((t) => t.name)).not.toContain('get_receipt');
    expect(tools.map((t) => t.name)).not.toContain('list_pending_tags');
  });

  it('NO tool takes an identity argument — the acting member is the credential, never a claim', async () => {
    // The door's rule, enforced here by construction: not one input schema has a member/subject/actor/
    // principal/author field. If a future tool added one, a caller could ASK to act as someone else, and
    // the fabric would rule on the name instead of the credential. This fails loudly if that ever happens.
    const client = await connect(recordingPort().port);
    const { tools } = await client.listTools();
    const forbidden = /^(member|subject|actor|principal|author|as|on_behalf|impersonate)/i;
    for (const t of tools) {
      const props = Object.keys(t.inputSchema?.properties ?? {});
      for (const p of props) {
        expect(forbidden.test(p), `${t.name} exposes an identity argument: ${p}`).toBe(false);
      }
    }
  });

  it('post_message routes to the port with the caller args and no identity', async () => {
    const { port, calls } = recordingPort();
    const client = await connect(port);
    const res = await client.callTool({
      name: 'post_message',
      arguments: { room_id: 'r1', body: 'hello' },
    });
    expect(calls).toEqual([
      { m: 'postMessage', args: { roomId: 'r1', body: 'hello', clientMsgId: undefined } },
    ]);
    expect(res.isError).toBeFalsy();
    expect(JSON.parse((res.content as Array<{ text: string }>)[0].text)).toEqual({ seq: 7 });
  });

  it('request_action returns the fabric verdict as the tool result', async () => {
    const { port } = recordingPort();
    const client = await connect(port);
    const res = await client.callTool({
      name: 'request_action',
      arguments: { room_id: 'r1', action: 'pr.merge', resource: 'repo:x#1' },
    });
    const verdict = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(verdict.decision).toBe('CO_SIGN');
    expect(verdict.decision_id).toBe('dec_1');
    expect(verdict.required_signer).toBe('principal:prince');
  });

  it('a governed refusal renders as an MCP error RESULT, not a thrown fault', async () => {
    const { port } = recordingPort({
      raiseHand: () =>
        Promise.reject(new RoomMcpError('no_human_addressee', 'no human to raise a hand to')),
    });
    const client = await connect(port);
    const res = await client.callTool({
      name: 'raise_hand',
      arguments: { room_id: 'r1', urgency: 'BLOCKER', reason: 'need eyes' },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toContain('no_human_addressee');
  });

  it('rejects a malformed call — an unknown enum value never reaches the port', async () => {
    const { port, calls } = recordingPort();
    const client = await connect(port);
    const res = await client.callTool({
      name: 'raise_hand',
      arguments: { room_id: 'r1', urgency: 'DECISION', reason: 'x' }, // DECISION is not a raised-hand urgency
    });
    expect(res.isError).toBe(true); // schema-rejected by the SDK before the handler
    expect(calls).toEqual([]); // the port was never called
  });

  it('an UNEXPECTED fault is OPAQUE — the raw error text never crosses the wire (only RoomMcpError is shown)', async () => {
    // A plain Error (a DB constraint, a TypeError) is NOT a governed refusal. The SDK would otherwise deliver
    // its `message` verbatim as tool content to the model; run() must return an opaque internal_error and
    // report the real fault to the host instead. This is the trust-boundary leak the B1 review caught.
    const seen: unknown[] = [];
    const { port } = recordingPort({
      readRoom: () =>
        Promise.reject(
          new Error('SECRET duplicate key value violates unique constraint "events_pkey"'),
        ),
    });
    const server = buildRoomMcpServer(port, { onError: (e) => seen.push(e) });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientT);

    const res = await client.callTool({ name: 'read_room', arguments: { room_id: 'r1' } });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('internal_error');
    expect(text).not.toContain('SECRET'); // the raw message did NOT reach the caller
    expect(text).not.toContain('events_pkey');
    // …but it WAS reported server-side, so the host can log it.
    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toContain('SECRET');
  });
});
