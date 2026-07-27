import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentAdapter } from '@playroom/shared';
import {
  Client,
  httpCreateRoom,
  issueTestCredential,
  scriptedAdapter,
  startTestServer,
  testPool,
  uniqueRoomId,
  type TestServer,
} from './support.js';

// TWO PEOPLE, TWO AGENTS, ONE ROOM, AT THE SAME TIME.
//
// This is the primary test for S-LIVE: Prince tags his agent and Jerry tags his, from two phones,
// and both stream at once. Everything else in the slice is in service of it.
//
// ── WHY IT IS ASSERTED AND NOT REASONED ABOUT ──
//
// §22b refuses a second concurrent turn for a member, keyed `${roomId} ${adapterId}` — so two
// DIFFERENT agents in one room should be independent, and reading that line is enough to believe
// it. It is not enough to SHIP it: the same reasoning would have been just as convincing if the key
// had been the room alone, and the failure mode is one I would only find with two people watching.
//
// ── AND WHY INTERLEAVING, NOT COMPLETION ──
//
// "Both turns completed" is satisfied by a server that ran them strictly one after the other, which
// is the exact defect worth catching: with a 40ms-per-chunk script, serialised turns produce all of
// A's deltas then all of B's, and a room where the second person waits for the first is a room that
// does not work on two phones. So the assertion is that the delta streams INTERLEAVE — A after B and
// B after A, in one transcript.

const CHUNK_DELAY_MS = 40;

/** Distinct scripted adapters, one per id, so a delta's author is unambiguous. */
function guestFactory(): (id: string) => AgentAdapter {
  const text: Record<string, string[]> = {
    'claude-main': ['Reading ', 'the ', 'branch ', 'now.'],
    sol: ['Looking ', 'at ', 'the ', 'diff.'],
  };
  return (id: string) => {
    const words = text[id] ?? ['ok.'];
    return scriptedAdapter(
      id,
      [
        ...words.map((t) => ({ kind: 'text_delta' as const, text: t })),
        { kind: 'done' as const, tokens_in: 10, tokens_out: words.length, stop_reason: 'end_turn' },
      ],
      { delayMs: CHUNK_DELAY_MS },
    );
  };
}

describe('concurrent summons — two humans, two agents, one room', () => {
  let server: TestServer;
  let jerryToken: string;
  const roomId = uniqueRoomId('concurrent');

  beforeAll(async () => {
    server = await startTestServer({ adapterFactory: guestFactory() });
    const res = await httpCreateRoom(server.httpBase, roomId, server.token);
    expect(res.status).toBe(201);

    // `createRoom` enrols the CREATOR and nobody else (S1.3c), so the other three members are
    // enrolled here — the same rows a room code would write. Both agents must be members for
    // `@claude` and `@sol` to resolve in THIS room: the token table is per-room (S1.1a).
    const pool = testPool();
    try {
      await pool.query(
        `INSERT INTO room_members (room_id, member_id)
         SELECT $1, m FROM unnest($2::text[]) AS m
         ON CONFLICT DO NOTHING`,
        [roomId, ['jerry', 'claude-main', 'sol']],
      );
    } finally {
      await pool.end();
    }
    jerryToken = await issueTestCredential('jerry', 'concurrency test');
  });

  afterAll(async () => {
    const pool = testPool();
    try {
      await pool.query('DELETE FROM events WHERE room_id = $1', [roomId]);
      await pool.query('DELETE FROM room_members WHERE room_id = $1', [roomId]);
      await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
      await pool.query("DELETE FROM member_credentials WHERE label = 'concurrency test'");
    } finally {
      await pool.end();
    }
    await server.close();
  });

  it('BOTH agents stream, and their deltas INTERLEAVE', async () => {
    const prince = new Client(`${server.wsBase}/rooms/${roomId}/ws`, server.token);
    const jerry = new Client(`${server.wsBase}/rooms/${roomId}/ws`, jerryToken);
    await Promise.all([prince.open(), jerry.open()]);

    // As close to simultaneous as two sockets get. Not awaited in sequence: awaiting the first
    // summon before issuing the second would test exactly the thing this is trying to rule out.
    prince.send('@claude how does the branch look?', 'c1');
    jerry.send('@sol and what about the diff?', 'c2');

    // Each turn writes started + 4 deltas + completed = 6; two messages and two summons ride
    // along, so wait on the terminal condition instead of counting.
    await prince.waitForEvents(2, 20000);
    const seen = new Set<string>();
    const deadline = Date.now() + 20000;
    while (seen.size < 2 && Date.now() < deadline) {
      for (const ev of prince.events) {
        if (ev.event_type === 'agent.turn.completed') seen.add(ev.actor_id);
      }
      if (seen.size < 2) await new Promise((r) => setTimeout(r, 100));
    }
    expect([...seen].sort(), 'both turns did not complete').toEqual(['claude-main', 'sol']);

    // BOTH SUCCEEDED, and attributed to the right member acting for the right principal.
    const completions = prince.events.filter((e) => e.event_type === 'agent.turn.completed');
    for (const c of completions) {
      if (c.event_type !== 'agent.turn.completed') continue;
      expect(c.payload.success, `${c.actor_id}'s turn failed`).toBe(true);
    }

    // THE INTERLEAVING. Deltas in arrival order, reduced to their author.
    const authors = prince.events
      .filter((e) => e.event_type === 'agent.turn.delta')
      .map((e) => e.actor_id);
    expect(authors.length, 'no deltas arrived').toBeGreaterThan(4);
    // A switch back and forth is only possible if both turns were open at once. A serialised
    // server yields exactly one switch (all of A, then all of B); genuine concurrency yields many.
    let switches = 0;
    for (let i = 1; i < authors.length; i += 1) if (authors[i] !== authors[i - 1]) switches += 1;
    // REPORTED, not just asserted. A threshold that passes is not evidence of how far it passed,
    // and the number is the whole claim: 1 switch is "A then B" (serialised), 6 is two streams
    // genuinely braided together.
    console.log(
      `[concurrent] ${authors.length} deltas, ${switches} author switches — ` +
        authors.map((a) => (a === 'claude-main' ? 'C' : 'S')).join(''),
    );
    expect(
      switches,
      `deltas did not interleave — author sequence was ${authors.join(',')}`,
    ).toBeGreaterThan(1);

    prince.close();
    jerry.close();
  }, 40000);

  it('and each turn is stamped to its OWN principal — two authorities in one transcript', async () => {
    // The reason two agents in one room is interesting at all. Reads the log rather than the
    // sockets, so it asserts what was RECORDED, not what a client happened to receive.
    const pool = testPool();
    try {
      const { rows } = await pool.query<{ actor_id: string; principal_id: string }>(
        `SELECT actor_id, payload ->> 'principal_id' AS principal_id
           FROM events
          WHERE room_id = $1 AND event_type = 'agent.turn.started'
          ORDER BY seq`,
        [roomId],
      );
      const byActor = new Map(rows.map((r) => [r.actor_id, r.principal_id]));
      expect(byActor.get('claude-main')).toBe('principal:prince');
      expect(byActor.get('sol')).toBe('principal:jerry');
    } finally {
      await pool.end();
    }
  });
});
