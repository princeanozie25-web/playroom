import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admitToRoom,
  Client,
  credentialCount,
  httpCreateRoom,
  scriptedAdapter,
  startTestServer,
  testPool,
  throwingAdapter,
  uniqueRoomId,
  type TestServer,
} from './support.js';
import { eventsForTask } from '../src/events.js';
import { rebuild, tasksInRoom } from '../src/tasks.js';

// WORK AS A RECORD WITH A STATE (Bible §21.3).
//
// Before this slice the room held only instants: a message, a summon, a turn, a decision. None
// of them could say that work was underway, stuck or finished — which is why `input-required`
// was a state named in the Bible three times (§6.2's failure rule, §11's chip line, §14's
// route-unavailable row) and implemented nowhere. S1.1c shipped the half that could exist
// without it, the room naming the failed constraint, and said so in its report.
//
// Two properties are asserted here, and the second is the one that keeps the first honest:
//
//   1. every state is REACHABLE — a state nothing can enter is a claim about a lifecycle
//      rather than a lifecycle;
//   2. every state is RECONSTRUCTIBLE FROM THE LOG — folding a task's events gives the same
//      answer as its row, so the row is a projection and not a second source of truth.

const pool = testPool();
let server: TestServer;
const rooms: string[] = [];

function room(prefix: string): string {
  const id = uniqueRoomId(prefix);
  rooms.push(id);
  return id;
}

/** Assert the row and the folded log agree — the whole point of appending transitions. */
async function assertRebuildable(taskId: string, expected: string): Promise<void> {
  const events = await eventsForTask(pool, taskId);
  expect(events.length, `no events carry task_id ${taskId}`).toBeGreaterThan(0);
  expect(rebuild(events), 'the log disagrees with the row — the row is not a projection').toBe(
    expected,
  );
}

beforeAll(async () => {
  server = await startTestServer({
    adapterFactory: (id) =>
      id === 'sol'
        ? throwingAdapter(id, 'RateLimit: 429 from the provider')
        : scriptedAdapter(id, [
            { kind: 'text_delta', text: `${id} answering` },
            { kind: 'done', tokens_in: 4, tokens_out: 2, stop_reason: 'end_turn' },
          ]),
  });
});

afterAll(async () => {
  for (const id of rooms) {
    await pool.query('DELETE FROM events WHERE room_id = $1', [id]);
    await pool.query('DELETE FROM tasks WHERE room_id = $1', [id]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [id]);
  }
  await pool.end();
  await server.close();
});

describe('a task is created when a human asks a member for work', () => {
  it('starts WORKING, names its assignee and intent, and reaches DONE when the turn completes', async () => {
    const id = room('task-working');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    await admitToRoom(id, 'claude-main', 'sol');
    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();

    c.send('@claude what governs this room', 'w-1');
    await c.waitForType('agent.turn.completed');
    await c.waitForType('task.state');

    const tasks = await tasksInRoom(pool, id);
    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    // The task says what it is FOR. A row with a state and no subject is not a task.
    expect(task).toMatchObject({
      assignee_member_id: 'claude-main',
      state: 'done',
      created_by: 'prince',
      intent: '@claude what governs this room',
      // NULL, not a placeholder: answering in a room is not a governed action and no mandate
      // scope covers it. A handoff is what sets this.
      action: null,
    });

    // The states it passed through, in order, from the log alone.
    const events = await eventsForTask(pool, task.id);
    const states = events
      .filter((e) => e.event_type === 'task.created' || e.event_type === 'task.state')
      .map((e) =>
        e.event_type === 'task.created' || e.event_type === 'task.state' ? e.payload.state : '',
      );
    expect(states).toEqual(['working', 'done']);
    await assertRebuildable(task.id, 'done');

    // THE SUMMON AND THE TURN CARRY THE TASK. `events.task_id` is a column, so "everything
    // that happened to this task" is one indexed read — including the work itself.
    const types = events.map((e) => e.event_type);
    expect(types).toContain('summon');
    expect(types).toContain('agent.turn.started');
    expect(types).toContain('agent.turn.completed');

    // The member who finished the work is the actor on the transition that closed it.
    const done = events.find((e) => e.event_type === 'task.state');
    expect(done?.actor_id).toBe('claude-main');
    c.close();
  });

  it('does NOT create a second task when the frame is replayed', async () => {
    // The S0.5a shape, one layer up. Message idempotency alone left the summon path open and a
    // replayed frame produced two turns from one ask; the same replay must not produce two
    // tasks. Migration 011's unique index on the origin is what refuses it — an `if` cannot,
    // because both frames can be in flight before either has committed.
    const id = room('task-replay');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    await admitToRoom(id, 'claude-main', 'sol');
    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();

    c.send('@claude twice please', 'r-1');
    await c.waitForType('agent.turn.completed');
    c.send('@claude twice please', 'r-1'); // verbatim replay
    await new Promise((r) => setTimeout(r, 1500));

    expect(await tasksInRoom(pool, id)).toHaveLength(1);
    // And no second `task.created` for the one that exists.
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM events WHERE room_id = $1 AND event_type = 'task.created'",
      [id],
    );
    expect(Number(rows[0].n)).toBe(1);
    c.close();
  });

  it('two tagged members produce TWO tasks, one each', async () => {
    const id = room('task-two');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    await admitToRoom(id, 'claude-main', 'sol');
    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();
    c.send('@claude and @sol both please', 't-1');
    // sol's adapter throws in this suite, so wait for both turns to finish either way.
    const until = Date.now() + 20_000;
    while (c.ofType('agent.turn.completed').length < 2 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const tasks = await tasksInRoom(pool, id);
    expect(tasks.map((t) => t.assignee_member_id).sort()).toEqual(['claude-main', 'sol']);
    // One task each, with their own states — the work did not merge into one record.
    expect(new Set(tasks.map((t) => t.id)).size).toBe(2);
    c.close();
  });
});

describe('input-required, at last', () => {
  it('a member with no usable route puts the task in INPUT-REQUIRED, with the same sentence as before', async () => {
    // §6.2's failure rule, whole for the first time: "if no route satisfies the constraints,
    // the task enters input-required and the tagging human is told which constraint failed."
    // S1.1c could only do the second half. THE SENTENCE IS UNCHANGED — the task state is a new
    // record of the same refusal, not a new refusal, and this assertion is what says so.
    const id = room('task-inputreq');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    await admitToRoom(id, 'claude-main', 'sol');
    await pool.query("UPDATE routes SET status = 'unavailable' WHERE member_id = 'sol'");
    try {
      const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
      await c.open();
      c.send('@sol are you there', 'ir-1');
      await c.waitForType('task.created');
      await new Promise((r) => setTimeout(r, 800));

      const tasks = await tasksInRoom(pool, id);
      expect(tasks).toHaveLength(1);
      // Created IN that state, never `working` — it never was working, and a log read as a
      // history must not contain a state the task was not in.
      expect(tasks[0].state).toBe('input-required');
      const events = await eventsForTask(pool, tasks[0].id);
      expect(events.filter((e) => e.event_type === 'task.state')).toHaveLength(0);
      await assertRebuildable(tasks[0].id, 'input-required');

      // The room's sentence, byte for byte what S1.1c shipped.
      expect(c.bodies()).toContain('sol cannot be reached: every route is unavailable (hosted).');
      // And no summon: nothing downstream believes a turn was asked for.
      expect(c.ofType('summon')).toHaveLength(0);
      c.close();
    } finally {
      await pool.query("UPDATE routes SET status = 'available' WHERE member_id = 'sol'");
    }
  });
});

describe('held, per §14', () => {
  it('a turn that fails for an operational reason HOLDS the task and names the error class', async () => {
    // §14: "Provider outage or 429 mid-task → task moves to held, persisted; room notified."
    // The room notification is the failed turn (which already existed); the persisted state is
    // new. NOTHING RESUMES IT — there is no retry budget and no scheduler, so this asserts
    // where the work stopped and not that anything picks it up.
    const id = room('task-held');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    await admitToRoom(id, 'claude-main', 'sol');
    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();
    c.send('@sol please look', 'h-1');
    await c.waitForType('agent.turn.completed');
    await c.waitForType('task.state');

    const tasks = await tasksInRoom(pool, id);
    expect(tasks[0].state).toBe('held');
    await assertRebuildable(tasks[0].id, 'held');

    const held = c.ofType('task.state')[0];
    if (held.event_type !== 'task.state') throw new Error('narrowing');
    expect(held.payload.from_state).toBe('working');
    // A held task with no stated reason is a state a member cannot act on.
    expect(held.payload.reason).toMatch(/Error/);
    // `system` is the actor: the room noticed, the agent did not do anything.
    expect(held.actor_id).toBe('system');
    c.close();
  });
});

describe('the log is the source of truth', () => {
  it('every task in every room this file created rebuilds to exactly its row state', async () => {
    // The property, over everything the file produced rather than one worked example. A future
    // path that updates the column without appending the event fails HERE, instead of quietly
    // becoming the new truth — which is the failure mode a projection invites.
    let checked = 0;
    for (const id of rooms) {
      for (const task of await tasksInRoom(pool, id)) {
        await assertRebuildable(task.id, task.state);
        checked += 1;
      }
    }
    expect(checked, 'nothing to check — this pass would be vacuous').toBeGreaterThan(4);
  });
});

describe('test credentials do not accumulate (S12-N3)', () => {
  it('starting and closing servers leaves the credential count where it began', async () => {
    // The defect this closes was mine, introduced in S12-1 and found by inspecting the test
    // database after the slice: `startTestServer` issued a credential per call and nothing ever
    // removed it, so 479 active credentials for `prince` had piled up. Asserted rather than
    // fixed-and-trusted, because the growth was invisible for exactly as long as nobody looked.
    const before = await credentialCount();
    const servers = [await startTestServer(), await startTestServer(), await startTestServer()];
    expect(await credentialCount()).toBe(before + 3); // they are real credentials while they live
    for (const s of servers) await s.close();
    expect(await credentialCount()).toBe(before);
  });
});
