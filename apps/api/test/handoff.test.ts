import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { eventsForTask } from '../src/events.js';
import { getTask, rebuild, tasksInRoom } from '../src/tasks.js';

// "@SOL TAKE REVIEW" — THE TASK MOVES, WITH STATE AND MANDATE REFERENCE, LOGGED (Bible §21.3).
//
// And one field the Bible does not name: THE AUTHENTICATED ACTOR who performed the transfer.
// That is what makes this a record of a delegation rather than a state change nobody is
// accountable for, and it is what S13-3 reads to close S12-N2 — a member may name another as the
// subject of a governed request only where a record establishes it.
//
// The property that matters most here is the one a later slice is most likely to break:
// A HANDOFF CONFERS NO AUTHORITY. Delegation in most systems passes permissions along. Here the
// receiving member acts under their own mandate, and a handoff can only narrow or refuse.

const pool = testPool();
let server: TestServer;
const rooms: string[] = [];

function room(prefix: string): string {
  const id = uniqueRoomId(prefix);
  rooms.push(id);
  return id;
}

/** Create a room, connect, and drive a task into existence by tagging a member. */
async function roomWithTask(
  prefix: string,
  tag = '@claude please look at this',
): Promise<{ id: string; c: Client; taskId: string }> {
  const id = room(prefix);
  expect((await httpCreateRoom(server.httpBase, id)).status).toBe(201);
  const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
  await c.open();
  c.send(tag, `seed-${id}`);
  await c.waitForType('agent.turn.completed');
  const tasks = await tasksInRoom(pool, id);
  expect(tasks).toHaveLength(1);
  return { id, c, taskId: tasks[0].id };
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
  await pool.query("DELETE FROM member_credentials WHERE label LIKE 'handoff-test%'");
  await pool.end();
  await server.close();
});

describe('the handoff moves the task', () => {
  it('carries the task, both members, the action, the RECEIVER mandate and the actor', async () => {
    const { id, c, taskId } = await roomWithTask('ho-move');

    c.handoff(taskId, 'sol', 'pr.review');
    await c.waitForType('task.handoff');

    const ev = c.ofType('task.handoff')[0];
    if (ev.event_type !== 'task.handoff') throw new Error('narrowing');
    expect(ev.payload).toMatchObject({
      task_id: taskId,
      from_member: 'claude-main',
      to_member: 'sol',
      action: 'pr.review',
      state: 'submitted',
    });
    // THE MANDATE REFERENCE IS SOL'S — the member who will act — not claude-main's.
    expect(ev.payload.mandate_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM events WHERE room_id = $1 AND event_type = 'task.handoff'",
      [id],
    );
    expect(Number(rows[0].n)).toBe(1);
    // THE AUTHENTICATED ACTOR. `prince` connected with a credential; nothing in the frame said so.
    expect(ev.actor_id).toBe('prince');

    // The row followed, and the state is `submitted` — received, not started. A handoff triggers
    // no turn, so `working` would be the room claiming activity it does not have.
    const task = await getTask(pool, taskId);
    expect(task).toMatchObject({
      assignee_member_id: 'sol',
      state: 'submitted',
      action: 'pr.review',
    });
    // And it is still reconstructible from the log alone.
    expect(rebuild(await eventsForTask(pool, taskId))).toBe('submitted');
    c.close();
  });

  it('the mandate reference is the RECEIVER’s, and differs from the sender’s', async () => {
    // The strongest available form of "confers no authority": the two members hold different
    // mandate documents, so the hash on the handoff event identifies WHICH one travels with the
    // task. If a later slice ever passes the sender's authority along, this assertion is what
    // catches it — the hashes would match.
    const { c, taskId } = await roomWithTask('ho-mandate');
    c.handoff(taskId, 'sol', 'pr.review');
    await c.waitForType('task.handoff');
    const ev = c.ofType('task.handoff')[0];
    if (ev.event_type !== 'task.handoff') throw new Error('narrowing');

    const claudeHash = c.ofType('agent.turn.started').find(() => true);
    if (claudeHash?.event_type !== 'agent.turn.started') throw new Error('narrowing');
    // claude-main stamped its own turn with its own mandate; the handoff carries sol's.
    expect(claudeHash.payload.mandate_hash).not.toBe(ev.payload.mandate_hash);
    c.close();
  });
});

describe('a handoff confers no authority', () => {
  it('REFUSES work the receiver’s mandate does not admit, and names the reason', async () => {
    // claude-main's mandate admits `pr.merge` (as CO_SIGN). sol's does not admit it at all. So
    // this is exactly the escalation a delegation model would allow and this one must not: the
    // work cannot arrive at sol carrying claude's authority to do it.
    const { c, taskId } = await roomWithTask('ho-noauth');
    c.handoff(taskId, 'sol', 'pr.merge');
    const refusal = await c.waitForError((e) => e.code === 'handoff_mandate_does_not_admit');
    expect(refusal.message).toMatch(/sol's mandate does not admit pr\.merge \(OUT_OF_SCOPE\)/);

    // NOTHING MOVED. The task is still claude-main's, in the state it was in.
    const task = await getTask(pool, taskId);
    expect(task).toMatchObject({ assignee_member_id: 'claude-main', state: 'done' });
    expect(c.ofType('task.handoff')).toHaveLength(0);
    c.close();
  });

  it('ALLOWS work the receiver’s mandate admits with a co-signature', async () => {
    // CO_SIGN is not a wall. Handing `pr.merge` to claude-main — whose mandate lists it as
    // protected — must succeed, because the member CAN do the work with a human signature.
    // Refusing it would make every protected action untransferable and misread co-signing.
    const { c, taskId } = await roomWithTask('ho-cosign', '@sol please look at this');
    c.handoff(taskId, 'claude-main', 'pr.merge');
    await c.waitForType('task.handoff');
    const task = await getTask(pool, taskId);
    expect(task).toMatchObject({ assignee_member_id: 'claude-main', action: 'pr.merge' });
    c.close();
  });

  it('and the receiver is still refused the action their own mandate blocks, AFTER the handoff', async () => {
    // The end-to-end statement of it. Hand `pr.review` to sol, then request `pr.merge` with sol as
    // the subject: the evaluator answers from SOL's mandate and BLOCKs, exactly as it would have
    // before the handoff. Holding a task is not authority to act.
    const { id, c, taskId } = await roomWithTask('ho-after');
    c.handoff(taskId, 'sol', 'pr.review');
    await c.waitForType('task.handoff');

    c.ws.send(
      JSON.stringify({
        type: 'request_action',
        client_msg_id: 'after-handoff',
        subject: 'sol',
        action: 'pr.merge',
        resource: 'repo:playroom/playroom#pr-41',
      }),
    );
    await c.waitForType('decision');
    const decision = c.ofType('decision')[0];
    if (decision.event_type !== 'decision') throw new Error('narrowing');
    // BLOCK, not CO_SIGN. claude-main would have been CO_SIGN for the same action — which is the
    // difference between the two mandates, and it survived the handoff untouched.
    expect(decision.payload).toMatchObject({
      subject: 'sol',
      decision: 'BLOCK',
      reason_code: 'OUT_OF_SCOPE',
    });
    expect(id).toBeTruthy();
    c.close();
  });
});

describe('the four refusals, each naming its own constraint', () => {
  it('UNKNOWN_TASK for a task that is not in this room', async () => {
    const { c } = await roomWithTask('ho-unknown');
    c.handoff('task_does_not_exist', 'sol', 'pr.review');
    const refusal = await c.waitForError((e) => e.code === 'unknown_task');
    expect(refusal.message).toMatch(/no task "task_does_not_exist" in this room/);
    c.close();
  });

  it('NOT_YOUR_TASK when the caller is neither the creator nor the holder', async () => {
    // `sol` holds a credential and is in the room, and that is not standing to move work between
    // other members. The S12-N2 shape one level up: a member acting on work that is none of
    // theirs, with no record that says otherwise.
    const { id, c, taskId } = await roomWithTask('ho-standing');
    const solToken = await issueTestCredential('sol', 'handoff-test-sol');
    const sol = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, solToken);
    await sol.open();
    sol.handoff(taskId, 'claude-main', 'pr.review');
    const refusal = await sol.waitForError((e) => e.code === 'not_your_task');
    expect(refusal.message).toMatch(
      /only the member who created this task or the member holding it/,
    );
    sol.close();
    c.close();
  });

  it('HANDOFF_ROSTER when the receiving member is not in this room', async () => {
    // The roster rule, which only exists because S1.1b made membership data. Handing work to a
    // member who is not here would put a task on someone the room cannot address.
    const { id, c, taskId } = await roomWithTask('ho-roster');
    await pool.query('DELETE FROM room_members WHERE room_id = $1 AND member_id = $2', [id, 'sol']);
    c.handoff(taskId, 'sol', 'pr.review');
    const refusal = await c.waitForError((e) => e.code === 'handoff_roster_violation');
    expect(refusal.message).toBe('sol is not in this room');
    // A DIFFERENT REFUSAL FROM THE MANDATE ONE, and that is the point of having four codes: this
    // is fixed by enrolling sol, the other by changing a mandate. Collapsing them would send
    // someone to edit the wrong file.
    expect(refusal.code).not.toBe('handoff_mandate_does_not_admit');
    c.close();
  });

  it('the socket survives a refusal and the next handoff still works', async () => {
    // A refusal is one request refused, not an identity problem. Proving it here is what stops a
    // future "just close the socket" from looking harmless.
    const { c, taskId } = await roomWithTask('ho-survive');
    c.handoff('task_nope', 'sol', 'pr.review');
    await c.waitForError((e) => e.code === 'unknown_task');
    c.handoff(taskId, 'sol', 'pr.review');
    await c.waitForType('task.handoff');
    expect((await getTask(pool, taskId))?.assignee_member_id).toBe('sol');
    c.close();
  });
});

describe('S12-N2 is closed: the subject must be justified by a record', () => {
  it('REFUSES a subject the requester has no record for, and writes NOTHING to the room', async () => {
    // THE HOLE, AS IT WAS. Any authenticated member could name any other as the subject of a
    // governed request — or any string at all, which is worse than the finding recorded:
    // `decision.test.ts` still has a passing case with `nobody-in-particular`. The verdict was
    // sound for the subject it was given, and the card said "requested under Claude's mandate"
    // for a request Claude never made.
    const id = room('subj-unjustified');
    expect((await httpCreateRoom(server.httpBase, id)).status).toBe(201);
    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();

    // No task, no handoff — nothing in this room says prince may act for sol.
    c.ws.send(
      JSON.stringify({
        type: 'request_action',
        client_msg_id: 'unjust-1',
        subject: 'sol',
        action: 'pr.review',
        resource: 'repo:playroom/playroom#pr-41',
      }),
    );
    const refusal = await c.waitForError((e) => e.code === 'subject_not_justified');
    expect(refusal.message).toMatch(/no record entitles prince to request under sol's mandate/);

    // AND NO DECISION EVENT. The fabric evaluated nothing, because the room refused the
    // attribution — a BLOCK card reading "requested under Sol's mandate" would render the very
    // claim being rejected.
    await new Promise((r) => setTimeout(r, 600));
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM events WHERE room_id = $1 AND event_type = 'decision'",
      [id],
    );
    expect(Number(rows[0].n)).toBe(0);
    c.close();
  });

  it('ACCEPTS the subject once a task delegates the work, and records BOTH parties', async () => {
    // The film's beat 5 shape: prince tags @claude, which creates a task claude-main holds, and
    // prince then requests pr.merge under claude's mandate. The record that makes that legitimate
    // is the task itself — delegation, in the only form the product has.
    const { c } = await roomWithTask('subj-delegated');
    c.ws.send(
      JSON.stringify({
        type: 'request_action',
        client_msg_id: 'just-1',
        subject: 'claude-main',
        action: 'pr.merge',
        resource: 'repo:playroom/playroom#pr-41',
      }),
    );
    await c.waitForType('decision');
    const decision = c.ofType('decision')[0];
    if (decision.event_type !== 'decision') throw new Error('narrowing');
    expect(decision.payload).toMatchObject({
      subject: 'claude-main',
      requested_by: 'prince',
      subject_basis: 'delegated_task',
      decision: 'CO_SIGN',
    });
    // The envelope and the payload agree on who asked — one of them is what a projection reads.
    expect(decision.actor_id).toBe('prince');
    c.close();
  });

  it('ACCEPTS a subject the requester handed work TO', async () => {
    // The other record. `prince` created the task and handed it to sol, so `handoff` is the basis
    // even though the delegated-task branch would also match — asserted on the SPECIFIC basis so
    // a future refactor cannot collapse the two and still pass.
    const { c, taskId } = await roomWithTask('subj-handoff');
    c.handoff(taskId, 'sol', 'pr.review');
    await c.waitForType('task.handoff');
    // Remove the delegated-task basis so only the handoff can justify it: the task's creator is
    // still prince, so reassign creation to claude-main to isolate the branch.
    await pool.query('UPDATE tasks SET created_by = $1 WHERE id = $2', ['claude-main', taskId]);

    c.ws.send(
      JSON.stringify({
        type: 'request_action',
        client_msg_id: 'just-2',
        subject: 'sol',
        action: 'deploy',
        resource: 'repo:playroom/playroom#pr-41',
      }),
    );
    await c.waitForType('decision');
    const decision = c.ofType('decision')[0];
    if (decision.event_type !== 'decision') throw new Error('narrowing');
    expect(decision.payload).toMatchObject({ subject: 'sol', subject_basis: 'handoff' });
    c.close();
  });

  it('ACCEPTS a member acting as THEMSELVES with no record at all', async () => {
    // `self` needs no justification, and it must not require one: a member asking about their own
    // authority is the base case, and a rule that demanded a task first would refuse the one
    // request that never needed a record.
    const id = room('subj-self');
    expect((await httpCreateRoom(server.httpBase, id)).status).toBe(201);
    const solToken = await issueTestCredential('sol', 'handoff-test-self');
    const sol = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, solToken);
    await sol.open();
    sol.ws.send(
      JSON.stringify({
        type: 'request_action',
        client_msg_id: 'self-1',
        subject: 'sol',
        action: 'pr.merge',
        resource: 'repo:playroom/playroom#pr-41',
      }),
    );
    await sol.waitForType('decision');
    const decision = sol.ofType('decision')[0];
    if (decision.event_type !== 'decision') throw new Error('narrowing');
    expect(decision.payload).toMatchObject({
      subject: 'sol',
      requested_by: 'sol',
      subject_basis: 'self',
      // sol's own mandate does not admit pr.merge, so the verdict is still BLOCK. Standing to ask
      // is not authority to act — the two questions stay separate.
      decision: 'BLOCK',
    });
    sol.close();
  });

  it('REFUSES a subject that is not a member at all', async () => {
    // The case the finding understated. `subject` was never checked to be a member: a caller could
    // name any string, and `decision.test.ts` proves it by asserting a NO_MANDATE verdict for
    // `nobody-in-particular`. No record can name a non-member, so this now refuses before the
    // evaluator — and the room stops accepting decision rows about names that refer to nobody.
    const id = room('subj-ghost');
    expect((await httpCreateRoom(server.httpBase, id)).status).toBe(201);
    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();
    c.ws.send(
      JSON.stringify({
        type: 'request_action',
        client_msg_id: 'ghost-1',
        subject: 'nobody-in-particular',
        action: 'pr.review',
        resource: 'repo:x#1',
      }),
    );
    const refusal = await c.waitForError((e) => e.code === 'subject_not_justified');
    expect(refusal.message).toMatch(/nobody-in-particular/);
    c.close();
  });
});
