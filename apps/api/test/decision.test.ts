import { describe, expect, it, afterAll } from 'vitest';
import { Writable } from 'node:stream';
import { DecisionEvent } from '@playroom/shared';
import { startTestServer, testPool, uniqueRoomId, httpCreateRoom, Client } from './support.js';

// The producer. A member requesting `pr.merge` must produce a CO_SIGN decision event
// carrying the reason code, the required signer and the mandate hash — and the S-UI
// card must be able to render it unmodified, which is asserted by parsing the row
// through the shared DecisionEvent schema the card is typed against.
//
// ASSERT THE MECHANISM, NEVER THE OUTCOME. "No merge happened" is not a test: it
// passes if the mandate refused, if the handler threw, or if the socket died. Every
// assertion below names the decision.

const pool = testPool();
afterAll(async () => {
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
    const server = await startTestServer();
    const room = uniqueRoomId('decision-cosign');
    try {
      await httpCreateRoom(server.httpBase, room);
      const c = new Client(`${server.wsBase}/rooms/${room}/ws?after=0`);
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
      expect(await decisionRows(room)).toHaveLength(1);
      c.close();
    } finally {
      await server.close();
    }
  });

  it('an unknown action type is BLOCKed — deny by default, asserted by reason code', async () => {
    const server = await startTestServer();
    const room = uniqueRoomId('decision-unknown');
    try {
      await httpCreateRoom(server.httpBase, room);
      const c = new Client(`${server.wsBase}/rooms/${room}/ws?after=0`);
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
    const server = await startTestServer();
    const room = uniqueRoomId('decision-nomandate');
    try {
      await httpCreateRoom(server.httpBase, room);
      const c = new Client(`${server.wsBase}/rooms/${room}/ws?after=0`);
      await c.open();
      c.ws.send(
        JSON.stringify({
          type: 'request_action',
          client_msg_id: 'm3-nomandate-1',
          subject: 'nobody-in-particular',
          action: 'pr.review',
          resource: 'repo:x#1',
        }),
      );
      await c.waitForType('decision');
      const ev = DecisionEvent.parse(c.ofType('decision')[0]);
      expect(ev.payload.decision).toBe('BLOCK');
      expect(ev.payload.reason_code).toBe('NO_MANDATE');
      expect(ev.payload.effective_mandate_hash).toBeNull();
      c.close();
    } finally {
      await server.close();
    }
  });

  it('an ALLOW writes NO decision event — nothing ran, so nothing is recorded as having run', async () => {
    const { lines, stream } = capture();
    const server = await startTestServer({ loggerStream: stream, logLevel: 'info' });
    const room = uniqueRoomId('decision-allow');
    try {
      await httpCreateRoom(server.httpBase, room);
      const c = new Client(`${server.wsBase}/rooms/${room}/ws?after=0`);
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
      expect(await decisionRows(room)).toHaveLength(0);
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
    const room = uniqueRoomId('decision-chat');
    try {
      await httpCreateRoom(server.httpBase, room);
      const c = new Client(`${server.wsBase}/rooms/${room}/ws?after=0`);
      await c.open();
      c.send('just talking', 'm3-chat-1', 'prince');
      await c.waitForEvents(1);
      expect(c.ofType('message')).toHaveLength(1);
      expect(await decisionRows(room)).toHaveLength(0);
      c.close();
    } finally {
      await server.close();
    }
  });
});
