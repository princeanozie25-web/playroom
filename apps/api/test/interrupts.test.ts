import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  delegateTask,
  httpCreateRoom,
  scriptedAdapter,
  startTestServer,
  testPool,
  uniqueRoomId,
  type TestServer,
} from './support.js';
import { eventsForInterrupt } from '../src/events.js';
import {
  budgetFor,
  costOf,
  downgradeInterrupt,
  interruptsInRoom,
  raiseInterrupt,
  rebuildUrgency,
} from '../src/interrupts.js';
import { getTask, tasksInRoom } from '../src/tasks.js';

// CLAIMING A HUMAN'S ATTENTION IS A RECORD WITH A PRICE (Bible §21.3, §18).
//
// Two properties carry this slice. The three urgencies differ in BEHAVIOUR — a label that changed
// nothing would be a preference, not a control. And the budget MOVES ONLY WHEN ATTENTION WAS
// ACTUALLY CLAIMED: silence is free, an FYI is free, and a misjudged interrupt costs twice.
//
// Everything here is member-addressed. Nothing assumes one human per member, which is the
// constraint this slice inherited from S1.3c's ranking and the one thing expensive to get wrong.

const pool = testPool();
let server: TestServer;
const rooms: string[] = [];

function room(prefix: string): string {
  const id = uniqueRoomId(prefix);
  rooms.push(id);
  return id;
}

/** Interrupt events are global by member, so each case starts from a clean slate for its raiser. */
async function clearSpend(): Promise<void> {
  await pool.query(
    "DELETE FROM events WHERE event_type IN ('interrupt.raised', 'interrupt.downgraded')",
  );
}

beforeAll(async () => {
  server = await startTestServer({
    adapterFactory: (id) =>
      scriptedAdapter(id, [
        { kind: 'text_delta', text: `${id} answering` },
        { kind: 'done', tokens_in: 4, tokens_out: 2, stop_reason: 'end_turn' },
      ]),
  });
});

afterAll(async () => {
  for (const id of rooms) {
    await pool.query('DELETE FROM events WHERE room_id = $1', [id]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [id]);
  }
  await clearSpend();
  await pool.end();
  await server.close();
});

describe('the three urgencies differ in behaviour', () => {
  it('BLOCKER halts the owning task', async () => {
    // The task stops because a person has to act. `input-required` is A2A's name for exactly that
    // and the state S1.3 already reaches through §6.2 — reused rather than invented.
    const id = room('int-blocker');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    const taskId = await delegateTask(pool, id, 'claude-main');
    await clearSpend();

    const raised = await raiseInterrupt(pool, {
      roomId: id,
      urgency: 'BLOCKER',
      raisedBy: 'claude-main',
      addressedTo: 'prince',
      aboutKind: 'task',
      aboutId: taskId,
      taskId,
      summary: 'I cannot proceed without a decision',
    });
    expect(raised.ok).toBe(true);
    if (!raised.ok) throw new Error('narrowing');

    expect((await getTask(pool, taskId))?.state).toBe('input-required');
    // The halt is an EVENT, so the task's history explains why it stopped.
    expect(raised.halt).not.toBeNull();
  });

  it('DECISION queues — it claims attention and stops nothing', async () => {
    const id = room('int-decision');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    const taskId = await delegateTask(pool, id, 'claude-main');
    await clearSpend();

    const raised = await raiseInterrupt(pool, {
      roomId: id,
      urgency: 'DECISION',
      raisedBy: 'claude-main',
      addressedTo: 'prince',
      aboutKind: 'task',
      aboutId: taskId,
      taskId,
      summary: 'when you have a moment',
    });
    expect(raised.ok).toBe(true);
    if (!raised.ok) throw new Error('narrowing');
    expect(raised.halt).toBeNull();
    expect((await getTask(pool, taskId))?.state).toBe('working');
  });

  it('FYI never interrupts, and never costs anything', async () => {
    const id = room('int-fyi');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    const taskId = await delegateTask(pool, id, 'claude-main');
    await clearSpend();

    const before = await budgetFor(pool, 'claude-main');
    const raised = await raiseInterrupt(pool, {
      roomId: id,
      urgency: 'FYI',
      raisedBy: 'claude-main',
      addressedTo: 'prince',
      aboutKind: 'task',
      aboutId: taskId,
      taskId,
      summary: 'for the record',
    });
    expect(raised.ok).toBe(true);
    if (!raised.ok) throw new Error('narrowing');

    expect(raised.halt).toBeNull();
    expect((await getTask(pool, taskId))?.state).toBe('working');
    // FREE. The budget prices a claim on attention, and an FYI explicitly makes none — charging
    // for one would price the thing the system wants agents to do INSTEAD of interrupting.
    expect((await budgetFor(pool, 'claude-main')).spent).toBe(before.spent);
    expect(costOf('FYI')).toBe(0);
  });

  it('a BLOCKER does NOT re-stop a task that is already stopped', async () => {
    // Overwriting `held` with `input-required` would replace an operational fact with a social one
    // and lose the error class that explains it.
    const id = room('int-held');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    const taskId = await delegateTask(pool, id, 'claude-main');
    await pool.query("UPDATE tasks SET state = 'held' WHERE id = $1", [taskId]);
    await clearSpend();

    const raised = await raiseInterrupt(pool, {
      roomId: id,
      urgency: 'BLOCKER',
      raisedBy: 'claude-main',
      addressedTo: 'prince',
      aboutKind: 'task',
      aboutId: taskId,
      taskId,
      summary: 'still blocked',
    });
    if (!raised.ok) throw new Error('narrowing');
    expect(raised.halt).toBeNull();
    expect((await getTask(pool, taskId))?.state).toBe('held');
  });
});

describe('a co-sign raises a DECISION interrupt through the same record', () => {
  it('addresses the human members of the required principal, and charges the SUBJECT', async () => {
    // Bible §12.1: co-sign requests always arrive as an interrupt. One record, not a parallel
    // notification concept — two records for one fact would drift, and the second would be the
    // one nobody budgeted.
    const id = room('int-cosign');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    await delegateTask(pool, id, 'claude-main');
    await clearSpend();

    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();
    c.ws.send(
      JSON.stringify({
        type: 'request_action',
        client_msg_id: 'cosign-int-1',
        subject: 'claude-main',
        action: 'pr.merge',
        resource: 'repo:playroom/playroom#pr-41',
      }),
    );
    await c.waitForType('interrupt.raised');

    const raised = c.ofType('interrupt.raised')[0];
    if (raised.event_type !== 'interrupt.raised') throw new Error('narrowing');
    expect(raised.payload).toMatchObject({
      urgency: 'DECISION',
      // CHARGED TO THE SUBJECT: the work is claude-main's, so the claim its work makes on a
      // person's attention is claude-main's to fund. That is also what makes the member's own
      // `interrupts_per_day` the right number to read.
      raised_by: 'claude-main',
      // ADDRESSED TO A MEMBER, resolved from the required PRINCIPAL. `principal:prince` has two
      // members — the human `prince` and the agent `claude-main` — and only the human is claimed.
      addressed_to: 'prince',
      about_kind: 'decision',
    });
    expect(raised.payload.summary).toMatch(/pr\.merge/);

    // ONE interrupt, and it is in the room's record.
    const rows = await interruptsInRoom(pool, id);
    expect(rows).toHaveLength(1);
    expect(rows[0].urgency).toBe('DECISION');
    c.close();
  });

  it('a repeated request claims the same person once', async () => {
    // Migration 014's unique index. A retried co-sign or two racing requests must not claim a
    // person's attention twice for one decision — the same discipline the summon has.
    const id = room('int-once');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    const taskId = await delegateTask(pool, id, 'claude-main');
    await clearSpend();

    for (let i = 0; i < 3; i += 1) {
      await raiseInterrupt(pool, {
        roomId: id,
        urgency: 'DECISION',
        raisedBy: 'claude-main',
        addressedTo: 'prince',
        aboutKind: 'task',
        aboutId: taskId,
        taskId,
        summary: 'the same thing, three times',
      });
    }
    expect(await interruptsInRoom(pool, id)).toHaveLength(1);
    // And it was charged ONCE: the second and third raises found the row and wrote no event.
    expect((await budgetFor(pool, 'claude-main')).spent).toBe(1);
  });
});

describe('the log is the source of truth', () => {
  it('an interrupt rebuilds to its row urgency from its events alone', async () => {
    const id = room('int-rebuild');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    const taskId = await delegateTask(pool, id, 'claude-main');
    await clearSpend();

    const raised = await raiseInterrupt(pool, {
      roomId: id,
      urgency: 'BLOCKER',
      raisedBy: 'claude-main',
      addressedTo: 'prince',
      aboutKind: 'task',
      aboutId: taskId,
      taskId,
      summary: 'rebuild me',
    });
    if (!raised.ok) throw new Error('narrowing');
    await downgradeInterrupt(pool, raised.interrupt.id, 'prince');

    const events = await eventsForInterrupt(pool, raised.interrupt.id);
    expect(events.map((e) => e.event_type)).toEqual(['interrupt.raised', 'interrupt.downgraded']);
    expect(rebuildUrgency(events)).toBe('DECISION');
    const rows = await interruptsInRoom(pool, id);
    expect(rows[0].urgency).toBe(rebuildUrgency(events));
  });

  it('silence is free — a room with no interrupts spends nothing', async () => {
    // The assertion the economics rests on. A member that says nothing pays nothing, and a room
    // that runs a whole turn without claiming anyone's attention leaves the budget where it was.
    const id = room('int-silence');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    await clearSpend();
    const before = await budgetFor(pool, 'claude-main');

    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();
    c.send('@claude what governs this room', 'silence-1');
    await c.waitForType('agent.turn.completed');

    expect(await interruptsInRoom(pool, id)).toHaveLength(0);
    expect((await budgetFor(pool, 'claude-main')).spent).toBe(before.spent);
    expect(await tasksInRoom(pool, id)).toHaveLength(1); // work happened; nobody was interrupted
    c.close();
  });
});
