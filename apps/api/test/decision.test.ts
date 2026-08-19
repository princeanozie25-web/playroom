import { describe, expect, it, afterAll } from 'vitest';
import { Writable } from 'node:stream';
import { DecisionEvent } from '@playroom/shared';
import {
  admitToRoom,
  startTestServer,
  testPool,
  uniqueRoomId,
  httpCreateRoom,
  delegateTask,
  Client,
} from './support.js';

// The producer. A member requesting `pr.merge` must produce a CO_SIGN decision event
// carrying the reason code, the required signer and the mandate hash — and the S-UI
// card must be able to render it unmodified, which is asserted by parsing the row
// through the shared DecisionEvent schema the card is typed against.
//
// ASSERT THE MECHANISM, NEVER THE OUTCOME. "No merge happened" is not a test: it
// passes if the mandate refused, if the handler threw, or if the socket died. Every
// assertion below names the decision.
//
// EVERY CASE HERE NOW DELEGATES A TASK FIRST, and that is not scaffolding — it is the
// mechanism S1.3 added. `subject` used to be a free field: these tests named `claude-main` and
// the server evaluated its mandate on nothing but the caller's word (S12-N2). A governed request
// now requires a record entitling the requester to act for that subject, so the tests establish
// one, exactly as a room would.

const pool = testPool();

/**
 * Every room this file creates, so it can delete them — S12-N3's shape, one layer over.
 *
 * These rooms leaked five per run from S0.3 until S1.3b: 20 rooms and, once S1.3 gave every
 * delegated task a row, 20 tasks with them. Nothing broke, which is why nobody looked — the same
 * reason 479 credentials accumulated. A test that creates durable rows and does not remove them is
 * a test that lies about its own cost.
 */
const rooms: string[] = [];
function room(prefix: string): string {
  const id = uniqueRoomId(prefix);
  rooms.push(id);
  return id;
}

afterAll(async () => {
  for (const id of rooms) {
    await pool.query('DELETE FROM events WHERE room_id = $1', [id]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [id]); // tasks cascade (migration 011)
  }
  await pool.end();
});

async function decisionRows(roomId: string) {
  const { rows } = await pool.query<{ payload: unknown }>(
    "SELECT payload FROM events WHERE room_id = $1 AND event_type = 'decision' ORDER BY seq",
    [roomId],
  );
  return rows.map((r) => r.payload);
}

function capture(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  return {
    lines,
    stream: new Writable({
      write(chunk: Buffer, _e, cb) {
        lines.push(chunk.toString());
        cb();
      },
    }),
  };
}

describe('mandate v0 — the producer', () => {
  it('pr.merge produces a CO_SIGN decision event naming the required signer', async () => {
    const { lines, stream } = capture();
    const server = await startTestServer({ loggerStream: stream, logLevel: 'info' });
    const roomId = room('decision-cosign');
    try {
      await httpCreateRoom(server.httpBase, roomId, server.token);
      await delegateTask(pool, roomId, 'claude-main'); // standing, per S1.3
      // The SUBJECT's mandate is roster_only, so it must be in the room or evaluate() BLOCKs with
      // ROSTER_VIOLATION before the verdict this test is about (ADR-009).
      await admitToRoom(roomId, 'claude-main');
      const c = new Client(`${server.wsBase}/rooms/${roomId}/ws?after=0`, server.token);
      await c.open();
      c.ws.send(
        JSON.stringify({
          type: 'request_action',
          client_msg_id: 'm3-merge-1',
          subject: 'claude-main',
          action: 'pr.merge',
          resource: 'repo:playroom/playroom#pr-41',
        }),
      );
      await c.waitForType('decision');

      // Renders through the SAME schema the S-UI card is typed against.
      const ev = DecisionEvent.parse(c.ofType('decision')[0]);
      expect(ev.payload.decision).toBe('CO_SIGN');
      expect(ev.payload.reason_code).toBe('PROTECTED_ACTION');
      expect(ev.payload.subject).toBe('claude-main');
      expect(ev.payload.principal).toBe('principal:prince');
      expect(ev.payload.action).toBe('pr.merge');
      expect(ev.payload.resource).toBe('repo:playroom/playroom#pr-41');
      expect(ev.payload.required_signer).toBe('principal:prince');
      expect(ev.payload.effective_mandate_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(ev.payload.policy_version).toBe('playroom-policy/1.0');
      expect(ev.payload.decision_id).toMatch(/^dec_/);
      expect(ev.payload.arguments_hash).toMatch(/^sha256:[0-9a-f]{64}$/);

      // It is durable, not only fanned out (§12 persist-before-fan-out).
      expect(await decisionRows(roomId)).toHaveLength(1);
      c.close();
    } finally {
      await server.close();
    }
    expect(lines.join('')).not.toContain('Cannot use a pool after calling end on the pool');
  });

  it('an unknown action type is BLOCKed — deny by default, asserted by reason code', async () => {
    const server = await startTestServer();
    const roomId = room('decision-unknown');
    try {
      await httpCreateRoom(server.httpBase, roomId, server.token);
      await delegateTask(pool, roomId, 'claude-main'); // standing, per S1.3
      // The SUBJECT's mandate is roster_only, so it must be in the room or evaluate() BLOCKs with
      // ROSTER_VIOLATION before the verdict this test is about (ADR-009).
      await admitToRoom(roomId, 'claude-main');
      const c = new Client(`${server.wsBase}/rooms/${roomId}/ws?after=0`, server.token);
      await c.open();
      c.ws.send(
        JSON.stringify({
          type: 'request_action',
          client_msg_id: 'm3-unknown-1',
          subject: 'claude-main',
          action: 'totally.made.up',
          resource: 'repo:x#1',
        }),
      );
      await c.waitForType('decision');
      const ev = DecisionEvent.parse(c.ofType('decision')[0]);
      expect(ev.payload.decision).toBe('BLOCK');
      expect(ev.payload.reason_code).toBe('OUT_OF_SCOPE');
      expect(ev.payload.required_signer).toBeNull();
      c.close();
    } finally {
      await server.close();
    }
  });

  it('a member with no mandate is BLOCKed with NO_MANDATE, not allowed through', async () => {
    // THIS CASE'S SUBJECT CHANGED IN S1.3, and the reason is the finding it exposed. It used to
    // name `nobody-in-particular` — a string that is not a member at all — which passed because
    // `subject` was never checked to BE anyone. That was S12-N2 understated: the hole was not only
    // that a member could name another member, it was that a member could name NOTHING and get a
    // decision row about it. No record can entitle anyone to act for a name that refers to nobody,
    // so that request is now refused before the evaluator (asserted in handoff.test.ts).
    //
    // The NO_MANDATE branch is still reachable, through the honest door: `prince` is a MEMBER and
    // holds no mandate, because mandates bind agents to the principals who grant them and a human
    // in their own room acts as a principal. A human asking to take a governed action themselves
    // needs no standing record — `self` — and is BLOCKed for having no mandate at all.
    const server = await startTestServer();
    const roomId = room('decision-nomandate');
    try {
      await httpCreateRoom(server.httpBase, roomId, server.token);
      const c = new Client(`${server.wsBase}/rooms/${roomId}/ws?after=0`, server.token);
      await c.open();
      c.ws.send(
        JSON.stringify({
          type: 'request_action',
          client_msg_id: 'm3-nomandate-1',
          subject: 'prince',
          action: 'pr.review',
          resource: 'repo:x#1',
        }),
      );
      await c.waitForType('decision');
      const ev = DecisionEvent.parse(c.ofType('decision')[0]);
      expect(ev.payload.decision).toBe('BLOCK');
      expect(ev.payload.reason_code).toBe('NO_MANDATE');
      expect(ev.payload.effective_mandate_hash).toBeNull();
      // And the record says which door it came through.
      expect(ev.payload.subject_basis).toBe('self');
      c.close();
    } finally {
      await server.close();
    }
  });

  it('an ALLOW writes NO decision event — nothing ran, so nothing is recorded as having run', async () => {
    const { lines, stream } = capture();
    const server = await startTestServer({ loggerStream: stream, logLevel: 'info' });
    const roomId = room('decision-allow');
    try {
      await httpCreateRoom(server.httpBase, roomId, server.token);
      await delegateTask(pool, roomId, 'claude-main'); // standing, per S1.3
      // The SUBJECT's mandate is roster_only, so it must be in the room or evaluate() BLOCKs with
      // ROSTER_VIOLATION before the verdict this test is about (ADR-009).
      await admitToRoom(roomId, 'claude-main');
      const c = new Client(`${server.wsBase}/rooms/${roomId}/ws?after=0`, server.token);
      await c.open();
      c.ws.send(
        JSON.stringify({
          type: 'request_action',
          client_msg_id: 'm3-allow-1',
          subject: 'claude-main',
          action: 'pr.review',
          resource: 'repo:x#1',
        }),
      );
      await new Promise((r) => setTimeout(r, 700));
      expect(await decisionRows(roomId)).toHaveLength(0);
      // But the evaluation IS audited with its mandate hash (Bible §9.2). Asserting the
      // log, not the absence — an unlogged ALLOW is A4-F1 wearing a different hat.
      const raw = lines.join('');
      expect(raw).toContain('mandate evaluated');
      expect(raw).toContain('ALLOWED_IN_SCOPE');
      expect(raw).toMatch(/sha256:[0-9a-f]{64}/);
      c.close();
    } finally {
      await server.close();
    }
  });

  it('a chat message is NOT a governed action and produces no decision', async () => {
    // Room content is not an action: mandates bind members to the principals who grant
    // them, and a human typing in their own room acts as a principal. If this ever
    // starts producing decisions, every message in the room becomes a governance event.
    const server = await startTestServer();
    const roomId = room('decision-chat');
    try {
      await httpCreateRoom(server.httpBase, roomId, server.token);
      const c = new Client(`${server.wsBase}/rooms/${roomId}/ws?after=0`, server.token);
      await c.open();
      c.send('just talking', 'm3-chat-1');
      await c.waitForEvents(1);
      expect(c.ofType('message')).toHaveLength(1);
      expect(await decisionRows(roomId)).toHaveLength(0);
      c.close();
    } finally {
      await server.close();
    }
  });
});
