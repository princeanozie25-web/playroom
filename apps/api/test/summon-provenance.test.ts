import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  httpCreateRoom,
  scriptedAdapter,
  startTestServer,
  testPool,
  uniqueRoomId,
  Client,
  type TestServer,
} from './support.js';

// EVERY AGENT TURN TRACES TO A HUMAN SUMMON.
//
// Asserted as a PROPERTY over a generated log rather than one worked example: a
// generated sequence of messages — untagged, single-tag, double-tag, replayed — must
// leave a log in which every agent.turn row resolves through its summon_id to a human
// root. The two cases most likely to break it (two tags in one message, and a replayed
// message) are generated deliberately rather than hoped for.
//
// The §19 query is then run AS SQL from the file the nightly job reads, against the same
// database, so the test and the production check are provably the same statement.

const ZERO_QUERY = readFileSync(
  resolve(import.meta.dirname, '../../../scripts/sql/unprompted-turns.sql'),
  'utf8',
);

const pool = testPool();
let server: TestServer;
const roomId = uniqueRoomId('summon-prop');

// Two members so a double-tag produces two summons and two turns.
function adapterFor(id: string) {
  return scriptedAdapter(id, [
    { kind: 'text_delta', text: `${id} ` },
    { kind: 'text_delta', text: 'answering' },
    { kind: 'done', tokens_in: 5, tokens_out: 2, stop_reason: 'end_turn' },
  ]);
}

beforeAll(async () => {
  server = await startTestServer({ adapterFactory: (id) => adapterFor(id) });
  expect((await httpCreateRoom(server.httpBase, roomId)).status).toBe(201);
});

afterAll(async () => {
  await pool.query('DELETE FROM events WHERE room_id = $1', [roomId]);
  await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
  await pool.end();
  await server.close();
});

interface Row {
  seq: string;
  event_type: string;
  actor_id: string;
  summon_id: string | null;
  root_is_human: boolean | null;
  payload: Record<string, unknown>;
}

async function log(): Promise<Row[]> {
  const { rows } = await pool.query<Row>(
    'SELECT seq, event_type, actor_id, summon_id, root_is_human, payload FROM events WHERE room_id = $1 ORDER BY seq',
    [roomId],
  );
  return rows;
}

describe('summon provenance (Bible §19)', () => {
  it('generates a log and every agent turn resolves to a human root', async () => {
    const c = new Client(`${server.wsBase}/rooms/${roomId}/ws?after=0`);
    await c.open();

    // A generated sequence covering the shapes that matter. Deliberately includes the
    // untagged case — silence is part of the property, not an absence of one.
    const sends: Array<{ body: string; id: string; expectTurns: number }> = [
      { body: 'morning, no tags here', id: 'p-1', expectTurns: 0 },
      { body: '@claude what governs this room', id: 'p-2', expectTurns: 1 },
      { body: 'thinking about @solar panels', id: 'p-3', expectTurns: 0 }, // substring, not a tag
      { body: '@claude and @sol both please', id: 'p-4', expectTurns: 2 }, // TWO summons
      { body: '@sol one more', id: 'p-5', expectTurns: 1 },
    ];

    let expected = 0;
    for (const s of sends) {
      expected += s.expectTurns;
      c.send(s.body, s.id, 'prince');
      // Wait for the turns this message should have produced to complete.
      const until = Date.now() + 20_000;
      while (c.ofType('agent.turn.completed').length < expected && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(c.ofType('agent.turn.completed').length).toBe(expected);
    }

    // REPLAY: the same client_msg_id again must add no message, no summon, no turn.
    //
    // This is the case that caught the bug S05a-2 fixed. Message idempotency alone left
    // the summon path open, so the replay raised a second summon and a second turn — both
    // human-rooted, so the zero query stayed at zero while the agent spoke twice to one
    // ask. Asserting on the WHOLE log length, not on the turn count, is what surfaced it:
    // counting only turns would have missed the extra summon row.
    const before = await log();
    c.send('@claude what governs this room', 'p-2', 'prince');
    await new Promise((r) => setTimeout(r, 1500));
    const after = await log();
    expect(after.length, 'a replayed frame appended rows').toBe(before.length);
    expect(c.ofType('agent.turn.completed').length).toBe(expected);

    c.close();

    // ---- the property ----
    const rows = after;
    const summons = new Map(
      rows.filter((r) => r.event_type === 'summon').map((r) => [r.summon_id, r]),
    );
    const turns = rows.filter((r) => r.event_type.startsWith('agent.turn.'));

    expect(turns.length).toBeGreaterThan(0);
    for (const t of turns) {
      expect(t.summon_id, `turn seq ${t.seq} has no summon`).toBeTruthy();
      const s = summons.get(t.summon_id);
      expect(s, `turn seq ${t.seq} references a summon that does not exist`).toBeDefined();
      expect(s?.root_is_human, `turn seq ${t.seq} is not human-rooted`).toBe(true);
      expect(s?.payload.root_actor).toBe('prince');
      expect(s?.payload.depth).toBe(0); // human-rooted; S0.5b introduces non-zero
    }

    // One summon per turn_id, and one turn per summon — not one turn naming two members.
    const bySummon = new Map<string, Set<string>>();
    for (const t of turns) {
      const turnId = String(t.payload.turn_id);
      (bySummon.get(t.summon_id!) ?? bySummon.set(t.summon_id!, new Set()).get(t.summon_id!)!).add(
        turnId,
      );
    }
    for (const [sid, turnIds] of bySummon) {
      expect(turnIds.size, `summon ${sid} produced ${turnIds.size} turns`).toBe(1);
    }

    // The double-tag message raised two summons naming DIFFERENT members.
    const causeOfDouble = rows.find(
      (r) => r.event_type === 'message' && String(r.payload.body).includes('both please'),
    );
    const fromDouble = rows.filter(
      (r) => r.event_type === 'summon' && r.payload.cause_seq === Number(causeOfDouble!.seq),
    );
    expect(fromDouble).toHaveLength(2);
    expect(new Set(fromDouble.map((r) => r.payload.member)).size).toBe(2);
  });

  it('THE ZERO QUERY returns zero, as the SQL the nightly job reads', async () => {
    const { rows } = await pool.query<{
      unprompted_turns: number;
      no_summon_ref: number;
      dangling_ref: number;
      not_human_rooted: number;
    }>(ZERO_QUERY);
    const r = rows[0];
    // Reported rather than just asserted, so a failure says WHICH way it failed.
    expect({ ...r }, `unprompted turns present: ${JSON.stringify(r)}`).toEqual({
      unprompted_turns: 0,
      no_summon_ref: 0,
      dangling_ref: 0,
      not_human_rooted: 0,
    });
  });

  it('an agent turn cannot be appended without a summon — the type is the gate', () => {
    // There is no runtime assertion to make here, and that is the point: omitting the
    // SummonRef is a COMPILE error, so this test documents where the guarantee lives
    // rather than duplicating it weakly at runtime. Deleting the parameter would fail
    // `pnpm typecheck`, not this file.
    const src = readFileSync(resolve(import.meta.dirname, '../src/events.ts'), 'utf8');
    expect(src).toMatch(/summon: SummonRef,/);
    expect(src).toMatch(/INSERT INTO events[\s\S]*?summon_id/);
  });
});
