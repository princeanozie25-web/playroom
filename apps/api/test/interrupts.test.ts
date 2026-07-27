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
import { ClientFrame } from '@playroom/shared';
import {
  budgetFor,
  costOf,
  downgradeInterrupt,
  getInterrupt,
  lowerThan,
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

describe('interrupts_per_day stops being decorative (S1.4)', () => {
  it('REFUSES a raise beyond the budget, with its own reason', async () => {
    // The fifth field that looked like authority: parsed by the mandate schema since M-3 and read
    // by NOTHING. `claude-main` is allowed six interrupts a day; the seventh is refused.
    const id = room('int-budget');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    await clearSpend();

    const limit = (await budgetFor(pool, 'claude-main')).limit;
    expect(limit, 'the mandate must carry a limit or this test proves nothing').toBe(6);

    for (let i = 0; i < (limit ?? 0); i += 1) {
      const ok = await raiseInterrupt(pool, {
        roomId: id,
        urgency: 'DECISION',
        raisedBy: 'claude-main',
        addressedTo: 'prince',
        aboutKind: 'message',
        aboutId: `spend-${i}`,
        summary: `claim ${i}`,
      });
      expect(ok.ok, `raise ${i} should be within budget`).toBe(true);
    }

    const overspent = await raiseInterrupt(pool, {
      roomId: id,
      urgency: 'DECISION',
      raisedBy: 'claude-main',
      addressedTo: 'prince',
      aboutKind: 'message',
      aboutId: 'one-too-many',
      summary: 'the seventh',
    });
    expect(overspent.ok).toBe(false);
    if (overspent.ok) throw new Error('narrowing');
    // ITS OWN REASON. An exhausted budget is not an out-of-scope action: the member MAY do this
    // and has done it too often, and reporting OUT_OF_SCOPE would send someone to edit a mandate's
    // scope when the answer is to wait for tomorrow.
    expect(overspent.failure).toBe('budget_exhausted');
    expect(overspent.budget).toMatchObject({ limit: 6, spent: 6, remaining: 0 });

    // AND NOTHING WAS WRITTEN. A refused claim leaves no row to render and no event to count.
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM interrupts WHERE room_id = $1 AND about_id = 'one-too-many'",
      [id],
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it('an FYI still passes when the budget is gone — free is free', async () => {
    // The other half of "the budget moves only when attention was actually claimed". An exhausted
    // member can still say something that interrupts nobody, which is the behaviour the pricing
    // exists to encourage.
    const id = room('int-fyi-free');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    await clearSpend();
    for (let i = 0; i < 6; i += 1) {
      await raiseInterrupt(pool, {
        roomId: id,
        urgency: 'DECISION',
        raisedBy: 'claude-main',
        addressedTo: 'prince',
        aboutKind: 'message',
        aboutId: `fill-${i}`,
        summary: 'filling the budget',
      });
    }
    const fyi = await raiseInterrupt(pool, {
      roomId: id,
      urgency: 'FYI',
      raisedBy: 'claude-main',
      addressedTo: 'prince',
      aboutKind: 'message',
      aboutId: 'free-one',
      summary: 'costs nothing',
    });
    expect(fyi.ok).toBe(true);
  });

  it('a member with NO mandate has no limit, and that is not a hole', async () => {
    // Mandates bind AGENTS to the principals who grant them. `prince` is a human member acting as
    // a principal, so there is no mandate to read a limit from — and pricing a person's claim on
    // their own attention would be charging someone rent on their own house.
    const budget = await budgetFor(pool, 'prince');
    expect(budget.limit).toBeNull();
    expect(budget.remaining).toBeNull();
  });

  it('the raise carries what was LEFT, so the room can show it without asking', async () => {
    const id = room('int-ambient');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    await clearSpend();
    const raised = await raiseInterrupt(pool, {
      roomId: id,
      urgency: 'DECISION',
      raisedBy: 'claude-main',
      addressedTo: 'prince',
      aboutKind: 'message',
      aboutId: 'ambient-1',
      summary: 'a claim',
    });
    if (!raised.ok || !raised.event) throw new Error('narrowing');
    const ev = raised.event;
    if (ev.event_type !== 'interrupt.raised') throw new Error('narrowing');
    // Six a day, one spent: five left, on the event, at the moment the claim was made.
    expect(ev.payload.budget_remaining).toBe(5);
  });
});

describe('one tap lowers the claim, and the raiser pays for it', () => {
  it('BLOCKER → DECISION → FYI, and each step charges the RAISER', async () => {
    // The mechanism, not a dismissal. A misjudged interrupt costs twice: once to make the claim,
    // once when the person says it was not worth making. That is what makes a downgrade a SIGNAL.
    const id = room('int-downgrade');
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
      summary: 'stop everything',
    });
    if (!raised.ok) throw new Error('narrowing');
    expect((await budgetFor(pool, 'claude-main')).spent).toBe(1); // the raise

    const first = await downgradeInterrupt(pool, raised.interrupt.id, 'prince');
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('narrowing');
    expect(first.interrupt.urgency).toBe('DECISION');
    expect((await budgetFor(pool, 'claude-main')).spent).toBe(2); // raise + one downgrade

    const second = await downgradeInterrupt(pool, raised.interrupt.id, 'prince');
    if (!second.ok) throw new Error('narrowing');
    expect(second.interrupt.urgency).toBe('FYI');
    expect((await budgetFor(pool, 'claude-main')).spent).toBe(3);

    // THE FLOOR. An FYI cannot be lowered further, and there is nowhere below it to go.
    const third = await downgradeInterrupt(pool, raised.interrupt.id, 'prince');
    expect(third.ok).toBe(false);
    if (third.ok) throw new Error('narrowing');
    expect(third.failure).toBe('already_lowest');
  });

  it('ONLY the member it addresses may lower it', async () => {
    // The raiser lowering their own would be a refund; anyone else lowering it would be deciding
    // on someone else's behalf what deserves their attention.
    const id = room('int-notyours');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    await clearSpend();
    const raised = await raiseInterrupt(pool, {
      roomId: id,
      urgency: 'BLOCKER',
      raisedBy: 'claude-main',
      addressedTo: 'prince',
      aboutKind: 'message',
      aboutId: 'not-yours-1',
      summary: 'addressed to prince',
    });
    if (!raised.ok) throw new Error('narrowing');

    const byRaiser = await downgradeInterrupt(pool, raised.interrupt.id, 'claude-main');
    expect(byRaiser.ok).toBe(false);
    if (byRaiser.ok) throw new Error('narrowing');
    expect(byRaiser.failure).toBe('not_addressed_to_you');
    const bystander = await downgradeInterrupt(pool, raised.interrupt.id, 'sol');
    expect(bystander.ok).toBe(false);

    // Unchanged, and uncharged: a refused downgrade costs nobody anything.
    expect((await getInterrupt(pool, raised.interrupt.id))?.urgency).toBe('BLOCKER');
    expect((await budgetFor(pool, 'claude-main')).spent).toBe(1);
  });

  it('THE DECREMENT IS ON THE EVENT, which is what makes it visible on screen', async () => {
    // "Visibly" in the exit criterion means on screen, not in a log. The room reads the number off
    // the event rather than polling, so the chip's budget drops as the tap lands.
    const id = room('int-visible');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    await clearSpend();
    const raised = await raiseInterrupt(pool, {
      roomId: id,
      urgency: 'BLOCKER',
      raisedBy: 'claude-main',
      addressedTo: 'prince',
      aboutKind: 'message',
      aboutId: 'visible-1',
      summary: 'watch the number',
    });
    if (!raised.ok || !raised.event) throw new Error('narrowing');
    const raisedEv = raised.event;
    if (raisedEv.event_type !== 'interrupt.raised') throw new Error('narrowing');
    expect(raisedEv.payload.budget_remaining).toBe(5);

    const down = await downgradeInterrupt(pool, raised.interrupt.id, 'prince');
    if (!down.ok) throw new Error('narrowing');
    const downEv = down.event;
    if (downEv.event_type !== 'interrupt.downgraded') throw new Error('narrowing');
    expect(downEv.payload).toMatchObject({
      from_urgency: 'BLOCKER',
      urgency: 'DECISION',
      raised_by: 'claude-main',
      budget_remaining: 4,
    });
  });

  it('over the wire: the recipient taps, the room sees it, a stranger cannot', async () => {
    const id = room('int-wire');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    await clearSpend();
    const raised = await raiseInterrupt(pool, {
      roomId: id,
      urgency: 'BLOCKER',
      raisedBy: 'claude-main',
      addressedTo: 'prince',
      aboutKind: 'message',
      aboutId: 'wire-1',
      summary: 'over the wire',
    });
    if (!raised.ok) throw new Error('narrowing');

    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();
    c.ws.send(
      JSON.stringify({
        type: 'downgrade',
        client_msg_id: 'dg-1',
        interrupt_id: raised.interrupt.id,
      }),
    );
    await c.waitForType('interrupt.downgraded');
    const ev = c.ofType('interrupt.downgraded')[0];
    if (ev.event_type !== 'interrupt.downgraded') throw new Error('narrowing');
    expect(ev.payload.urgency).toBe('DECISION');
    // The actor on the event is the authenticated member — the frame carried no claim about who.
    expect(ev.actor_id).toBe('prince');

    // AND A NAME THAT IS NOT THERE IS REFUSED, in one shape. Unknown, not-yours and
    // already-lowest are told apart in the log and not to the caller: distinguishing them would
    // say whether an interrupt exists and who it addresses, which is a fact about someone else's
    // attention that a stranger has no business reading.
    c.ws.send(
      JSON.stringify({ type: 'downgrade', client_msg_id: 'dg-2', interrupt_id: 'int_nope' }),
    );
    const refusal = await c.waitForError((e) => e.code === 'downgrade_refused');
    expect(refusal.message).toMatch(/cannot be lowered/);
    c.close();
  });

  it('THERE IS NO UPGRADE, and no place to put one', () => {
    // A recipient may lower a claim on their attention; nobody may raise it after the fact,
    // because a second attempt that cost nothing would make the budget a suggestion. Asserted
    // structurally, because the temptation arrives as a small symmetric-looking addition.
    expect(lowerThan('BLOCKER')).toBe('DECISION');
    expect(lowerThan('DECISION')).toBe('FYI');
    expect(lowerThan('FYI')).toBeNull();
    const wire = ClientFrame.options.map((o) => o.shape.type.value);
    expect(wire).toContain('downgrade');
    expect(wire).not.toContain('upgrade');
  });
});
