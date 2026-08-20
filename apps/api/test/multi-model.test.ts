import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mockAdapterFactory } from '@playroom/adapters';
import {
  testPool,
  uniqueRoomId,
  startTestServer,
  httpCreateRoom,
  admitToRoom,
  Client,
  type TestServer,
} from './support.js';

/**
 * ═══ WORK ALONGSIDE CHATGPT AND CLAUDE FROM INSIDE A ROOM (ADR-022) ═══════════════════════════════════
 *
 * Two members from two DIFFERENT providers — `claude-main` (anthropic) and `sol` (openai) — are summoned by
 * one human message and each takes a GOVERNED turn in the same room. The providers are driven by deterministic
 * mock adapters (mockAdapterFactory), so the whole multi-model room runs offline with no key and no spend —
 * exactly what makes "ChatGPT and Claude work alongside each other" provable in CI. The provider-neutrality of
 * the real adapters is the conformance suite's job; this proves the ROOM orchestrates both under governance.
 */

const pool = testPool();
let server: TestServer;
const rooms: string[] = [];

beforeAll(async () => {
  server = await startTestServer({
    adapterFactory: mockAdapterFactory({
      'claude-main': { text: 'Claude here: I read the diff and it looks sound.' },
      sol: { text: 'ChatGPT here: agreed, and I would add a regression test.' },
    }),
  });
});

afterAll(async () => {
  for (const id of rooms) {
    await pool.query('DELETE FROM events WHERE room_id = $1', [id]);
    await pool.query('DELETE FROM room_members WHERE room_id = $1', [id]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [id]);
  }
  await pool.end();
  await server.close();
});

async function waitForCount(c: Client, type: string, n: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (c.ofType(type).length < n) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${n}× ${type} (saw ${c.ofType(type).length})`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('a Claude member and a ChatGPT member, side by side, governed (ADR-022)', () => {
  it('one human message summons both, and each takes its own governed turn in the room', async () => {
    const id = uniqueRoomId('multimodel');
    rooms.push(id);
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    await admitToRoom(id, 'claude-main', 'sol');

    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();

    // A person names BOTH providers' members in one message — two independent, governed turns follow.
    c.send('@claude-main @sol please both review this diff', 'm1');
    await waitForCount(c, 'agent.turn.completed', 2);

    const completed = c.ofType('agent.turn.completed');
    const members = new Set(completed.map((e) => e.actor_id));
    expect(members.has('claude-main')).toBe(true); // the Claude (anthropic) member answered
    expect(members.has('sol')).toBe(true); // the ChatGPT (openai) member answered
    c.close();
  });
});
