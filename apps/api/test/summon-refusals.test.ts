import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RoomBus } from '../src/bus.js';
import { runAgentTurn } from '../src/agent.js';
import { appendSummon } from '../src/events.js';
import { ensureTask } from '../src/tasks.js';
import {
  Client,
  httpCreateRoom,
  scriptedAdapter,
  startTestServer,
  testPool,
  uniqueRoomId,
  type TestServer,
} from './support.js';

// REFUSALS THE ROOM MUST MAKE OUT LOUD, and the one guarantee only the database can give.
//
// Silent non-response is RT-001's shape. These cases are the ones where it is most
// tempting, because "nobody is called that" and "the adapter cannot be built" both feel
// like nothing happened — and a member cannot tell either apart from an agent being slow.

const pool = testPool();
let server: TestServer;
const rooms: string[] = [];

function room(prefix: string): string {
  const id = uniqueRoomId(prefix);
  rooms.push(id);
  return id;
}

const reply = (id: string) =>
  scriptedAdapter(id, [
    { kind: 'text_delta', text: `${id} here` },
    { kind: 'done', tokens_in: 4, tokens_out: 2, stop_reason: 'end_turn' },
  ]);

beforeAll(async () => {
  server = await startTestServer({
    adapterFactory: (id) => {
      // `sol` cannot be constructed — the shape of a missing provider key, which is the
      // reachable half of "a roster member with no reachable adapter".
      if (id === 'sol') throw new Error('MissingKey: no credential for sol');
      return reply(id);
    },
  });
});

afterAll(async () => {
  for (const id of rooms) {
    await pool.query('DELETE FROM events WHERE room_id = $1', [id]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [id]);
  }
  await pool.end();
  await server.close();
});

describe('refuse out loud', () => {
  it('says so when a tag names nobody, and writes no summon', async () => {
    const id = room('summon-unknown');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();

    c.send('@nobody are you there?', 'u-1');
    await c.waitForEvents(2); // the member's message, then the room's refusal

    const bodies = c.bodies();
    expect(bodies[0]).toBe('@nobody are you there?');
    expect(bodies[1]).toBe('No member of this room is called @nobody.');
    // The refusal is the room speaking, and it must not itself summon (SYSTEM_AUTHORED).
    expect(c.events[1].actor_id).toBe('system');
    expect(c.ofType('summon')).toHaveLength(0);
    c.close();
  });

  it('does not repeat the refusal when the frame is replayed', async () => {
    // The notice's client_msg_id is derived from the causing message's seq, so it inherits
    // appendMessage's idempotency. Without that, a replayed frame would append a second
    // identical refusal — the same class of bug as the replayed summon.
    const id = room('summon-unknown-replay');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();

    c.send('@ghost hello', 'u-2');
    await c.waitForEvents(2);
    c.send('@ghost hello', 'u-2'); // verbatim replay
    await new Promise((r) => setTimeout(r, 1200));

    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM events WHERE room_id = $1 AND actor_id = 'system'",
      [id],
    );
    expect(Number(rows[0].n)).toBe(1);
    c.close();
  });

  it('names the known member AND refuses the unknown one in the same message', async () => {
    const id = room('summon-mixed');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();

    c.send('@claude and @nobody, please', 'm-1');
    await c.waitForType('agent.turn.completed');

    expect(c.bodies()).toContain('No member of this room is called @nobody.');
    expect(c.ofType('summon')).toHaveLength(1);
    c.close();
  });

  it('records a visible failure when a named member has no reachable adapter', async () => {
    // Reachable half of the case: `sol` IS in the roster and IS addressable, but the
    // adapter cannot be constructed. The summon is legitimate, so it is written — and the
    // turn fails LOUDLY, with a body a member can read and an error_class in telemetry.
    // Not silence, which is what a caught-and-swallowed factory error would have been.
    const id = room('summon-unreachable');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();

    c.send('@sol can you take this?', 'x-1');
    await c.waitForType('agent.turn.completed');

    const done = c.ofType('agent.turn.completed')[0];
    expect(done.event_type).toBe('agent.turn.completed');
    if (done.event_type !== 'agent.turn.completed') throw new Error('narrowing');
    expect(done.payload.success).toBe(false);
    expect(done.payload.text).toBe('(sol could not respond)');
    expect(done.payload.error_class).toBe('Error');
    // Still rooted: a failed turn is a turn, and it traces to the human who asked.
    expect(c.ofType('summon')).toHaveLength(1);
    c.close();
  });
});

describe('the second drift number, enforced', () => {
  it('a summon may start at most one turn — the database refuses the second', async () => {
    // The retry shape: the first turn finished, so the in-process in-flight key is clear
    // and nothing in application memory remembers this summon was already answered. Only
    // migration 006's unique index on `agent.turn.started` can refuse it.
    const id = room('one-turn-per-summon');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);

    // A TASK FIRST, because a summon belongs to one as of S1.3 and the signature says so.
    // This test drives `runAgentTurn` directly to reach the retry race, so it builds what the
    // summon path would have built — including the task, which is the point: there is no
    // shortcut that skips it, in the product or here.
    const { task } = await ensureTask(pool, {
      roomId: id,
      assignee: 'claude-main',
      state: 'working',
      action: null,
      intent: 'retry the same summon twice',
      createdBy: 'prince',
      causeSeq: 0,
    });

    const summonId = `sum_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const summon = await appendSummon(
      pool,
      id,
      { task_id: task.id },
      {
        summon_id: summonId,
        member: 'claude-main',
        requested_by: 'prince',
        root_actor: 'prince',
        root_is_human: true,
        depth: 0,
        cause_seq: 0,
      },
    );
    expect(summon).not.toBeNull();

    const deps = {
      pool,
      bus: new RoomBus(),
      roomId: id,
      adapterId: 'claude-main',
      adapterFactory: (a: string) => reply(a),
      // A no-op entry: this turn's scripted adapter emits no action, so nothing is dispatched (S1.8).
      execute: () => Promise.resolve(),
      summon: { summon_id: summonId },
      task: { task_id: task.id },
    };
    await runAgentTurn(deps);
    await runAgentTurn(deps); // same summon, sequentially — the retry

    const { rows } = await pool.query<{ event_type: string; n: string }>(
      `SELECT event_type, count(*) AS n FROM events
       WHERE room_id = $1 AND summon_id = $2 GROUP BY 1`,
      [id, summonId],
    );
    const byType = new Map(rows.map((r) => [r.event_type, Number(r.n)]));
    expect(byType.get('agent.turn.started')).toBe(1);
    // AND the loser wrote no completed row. A completed row here would carry a turn_id
    // nothing started and would itself be the second turn in the log — the drift the
    // index exists to prevent, committed by the code reporting it.
    expect(byType.get('agent.turn.completed')).toBe(1);

    const turnIds = await pool.query<{ n: string }>(
      `SELECT count(DISTINCT payload ->> 'turn_id') AS n FROM events
       WHERE room_id = $1 AND summon_id = $2 AND event_type LIKE 'agent.turn.%'`,
      [id, summonId],
    );
    expect(Number(turnIds.rows[0].n)).toBe(1);
  });
});
