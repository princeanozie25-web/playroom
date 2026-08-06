import { afterAll, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import type { AgentAdapter, AgentTurnChunk } from '@playroom/shared';
import { Client, httpCreateRoom, startTestServer, testPool, uniqueRoomId } from './support.js';
import { MAX_ACTIONS_PER_TURN } from '../src/agent.js';

/**
 * ═══ S2.1a — THE TOOL-CALL CHANNEL (Phase 1: the channel, and the cap) ═══
 *
 * A non-summon action a turn emits reaches requestAction — the evaluator — and is ruled on, in-process.
 * The subject is the EMITTING member; standing resolves to `self`, unweakened. NOTHING IS EXECUTED under
 * any verdict: the path ends at the decision. And the emission path is capped — a burst is bounded
 * server-side and said out loud, because an uncapped path is the denial-of-wallet case with the model
 * holding the pen.
 *
 * ASSERT THE MECHANISM, NEVER THE OUTCOME. "the merge didn't happen" passes if nothing was wired; every
 * assertion below names the decision — its subject, its reason code, its mandate hash — or the cap.
 */

// A scripted adapter whose model emits governed (non-summon) actions after some text.
function actingAdapter(
  id: string,
  emissions: { action: string; arguments: Record<string, unknown>; call_id?: string }[],
): AgentAdapter {
  return {
    id,
    async *stream(): AsyncGenerator<AgentTurnChunk> {
      yield { kind: 'text_delta', text: 'on it' };
      for (const e of emissions) {
        yield { kind: 'action', action: e.action, arguments: e.arguments, call_id: e.call_id };
      }
      yield { kind: 'done', tokens_in: 6, tokens_out: 4, stop_reason: 'tool_use' };
    },
  };
}
function plainAdapter(id: string): AgentAdapter {
  return {
    id,
    async *stream(): AsyncGenerator<AgentTurnChunk> {
      yield { kind: 'text_delta', text: 'ok' };
      yield { kind: 'done', tokens_in: 2, tokens_out: 1, stop_reason: 'end_turn' };
    },
  };
}

const pool = testPool();
const rooms: string[] = [];
function room(prefix: string): string {
  const id = uniqueRoomId(prefix);
  rooms.push(id);
  return id;
}

afterAll(async () => {
  for (const id of rooms) {
    await pool.query('DELETE FROM events WHERE room_id = $1', [id]);
    await pool.query('DELETE FROM room_members WHERE room_id = $1', [id]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [id]);
  }
  await pool.end();
});

interface DecisionPayload {
  subject: string;
  subject_basis: string;
  action: string;
  resource: string;
  decision: string;
  reason_code: string;
  required_signer: string | null;
  effective_mandate_hash: string | null;
}
async function decisionRows(roomId: string): Promise<DecisionPayload[]> {
  const { rows } = await pool.query<{ payload: DecisionPayload }>(
    "SELECT payload FROM events WHERE room_id = $1 AND event_type = 'decision' ORDER BY seq",
    [roomId],
  );
  return rows.map((r) => r.payload);
}
async function systemSays(roomId: string, needle: string): Promise<boolean> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM events
      WHERE room_id = $1 AND event_type = 'message' AND actor_id = 'system'
        AND payload ->> 'body' ILIKE $2`,
    [roomId, `%${needle}%`],
  );
  return Number(rows[0].n) > 0;
}
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
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

describe('S2.1a Phase 1 — the channel: an emitted action reaches the evaluator', () => {
  it("evaluates a non-summon emission against the EMITTING member's own mandate, with self standing", async () => {
    // claude-main emits an OUT-OF-SCOPE action. Out-of-scope is deliberate: OUT_OF_SCOPE writes a
    // decision event (ALLOW does not), so the event IS the proof the emission reached evaluate().
    const server = await startTestServer({
      adapterFactory: (id) =>
        id === 'claude-main'
          ? actingAdapter(id, [
              { action: 'secrets.read', arguments: { resource: 'vault:prod/db' } },
            ])
          : plainAdapter(id),
    });
    const roomId = room('s21a-route');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    const c = new Client(`${server.wsBase}/rooms/${roomId}/ws`, server.token);
    try {
      await c.open();
      c.send('@claude have a look', 'route-1');
      const rows = await until(
        () => decisionRows(roomId),
        (r) => r.length >= 1,
      );
      expect(rows).toHaveLength(1);
      // THE MECHANISM: the subject is the emitting member, standing is `self` (unweakened — no delegated
      // task or handoff was needed, because a member acting on its OWN request already has standing), and
      // the verdict carries the reason code and the mandate hash. The emission was ruled on by the fabric.
      expect(rows[0].subject).toBe('claude-main');
      expect(rows[0].subject_basis).toBe('self');
      expect(rows[0].action).toBe('secrets.read');
      expect(rows[0].decision).toBe('BLOCK');
      expect(rows[0].reason_code).toBe('OUT_OF_SCOPE');
      expect(rows[0].effective_mandate_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    } finally {
      c.close();
      await server.close();
    }
  });

  it('an ALLOW emission is audited with its mandate hash, writes NO decision event, and runs nothing', async () => {
    // pr.review is in claude-main's scope and not protected → ALLOW. A4-F1's ruling stands: an ALLOW
    // writes NO decision event. The mechanism is the audit log (the verdict + its hash) plus the ABSENCE
    // of a decision row — and there is no executor to run, which is WHY nothing happened. (The brief's
    // exit line "ALLOW produces a decision event" conflicts with A4-F1; the ruling is honored — see
    // decision.test.ts and the S21A report.)
    const { lines, stream } = capture();
    const server = await startTestServer({
      adapterFactory: (id) =>
        id === 'claude-main'
          ? actingAdapter(id, [
              { action: 'pr.review', arguments: { resource: 'repo:playroom/playroom#pr-41' } },
            ])
          : plainAdapter(id),
      loggerStream: stream,
      logLevel: 'info',
    });
    const roomId = room('s21a-allow');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    const c = new Client(`${server.wsBase}/rooms/${roomId}/ws`, server.token);
    try {
      await c.open();
      c.send('@claude review it', 'allow-1');
      await until(
        () => Promise.resolve(lines.join('')),
        (raw) => raw.includes('ALLOWED_IN_SCOPE'),
      );
      const raw = lines.join('');
      expect(raw).toContain('mandate evaluated');
      expect(raw).toContain('ALLOWED_IN_SCOPE');
      expect(raw).toMatch(/sha256:[0-9a-f]{64}/);
      // NO decision event — nothing ran, so nothing is recorded as having run (A4-F1).
      expect(await decisionRows(roomId)).toHaveLength(0);
    } finally {
      c.close();
      await server.close();
    }
  });
});

describe('S2.1a Phase 1 — the cap: one turn may not emit unboundedly', () => {
  it('caps governed emissions at MAX_ACTIONS_PER_TURN and says so out loud', async () => {
    const burst = MAX_ACTIONS_PER_TURN + 3;
    const emissions = Array.from({ length: burst }, (_v, i) => ({
      action: 'secrets.read',
      arguments: { resource: `vault:prod/key-${i}` },
      call_id: `c${i}`,
    }));
    const server = await startTestServer({
      adapterFactory: (id) =>
        id === 'claude-main' ? actingAdapter(id, emissions) : plainAdapter(id),
    });
    const roomId = room('s21a-cap');
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    const c = new Client(`${server.wsBase}/rooms/${roomId}/ws`, server.token);
    try {
      await c.open();
      c.send('@claude go wide', 'cap-1');
      await until(
        () => decisionRows(roomId),
        (r) => r.length >= MAX_ACTIONS_PER_TURN,
      );
      // Give any (wrongly) uncapped extras a moment to appear before asserting the ceiling holds.
      await new Promise((r) => setTimeout(r, 500));
      // EXACTLY the cap: the burst of MAX+3 produced MAX decisions, not more.
      expect(await decisionRows(roomId)).toHaveLength(MAX_ACTIONS_PER_TURN);
      // And the drop is OUT LOUD, naming the cap — never a silent truncation.
      expect(await systemSays(roomId, 'per-turn cap')).toBe(true);
    } finally {
      c.close();
      await server.close();
    }
  });
});
