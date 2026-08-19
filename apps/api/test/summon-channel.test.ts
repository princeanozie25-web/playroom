import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentTurnChunk } from '@playroom/shared';
import {
  Client,
  admitToRoom,
  httpCreateRoom,
  startTestServer,
  testPool,
  uniqueRoomId,
  type TestServer,
} from './support.js';
import { RoomBus } from '../src/bus.js';
import { createRoom } from '../src/events.js';
import { executeCommand, type CommandDeps } from '../src/commands/index.js';

/**
 * ═══ S1.8 — THE SUMMON THROUGH THE CHANNEL, AND ITS POSTURE ═══
 *
 * An agent emits a structured summon; it converges on the SINGLE existing constructor, is governed
 * there, and produces exactly one attributed turn — or is refused with a named reason. The real exit
 * is the injection posture: a structured emission is subject to every control a free-text activation
 * is, and one more — it is only as authorised as the agent that emitted it. This proves the mechanism,
 * not just the outcome: which guard fired, or which evaluation passed.
 */

// A scripted adapter whose model emits a SUMMON of `target` (a structured action), plus some text.
function summoningAdapter(id: string, target: string): AgentAdapter {
  return {
    id,
    async *stream(_messages, opts): AsyncGenerator<AgentTurnChunk> {
      void opts;
      yield { kind: 'text_delta', text: `bringing in ${target}` };
      yield { kind: 'action', action: 'summon', arguments: { member: target } };
      yield { kind: 'done', tokens_in: 6, tokens_out: 4, stop_reason: 'tool_use' };
    },
  };
}

// A plain replying adapter — records the tools it was offered, so the near-guard can be asserted.
function replyingAdapter(id: string, seen?: Record<string, unknown>): AgentAdapter {
  return {
    id,
    async *stream(_messages, opts): AsyncGenerator<AgentTurnChunk> {
      if (seen) seen[id] = opts?.tools;
      yield { kind: 'text_delta', text: 'ok' };
      yield { kind: 'done', tokens_in: 3, tokens_out: 2, stop_reason: 'end_turn' };
    },
  };
}

const pool = testPool();
let server: TestServer | undefined;
const rooms: string[] = [];

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
  for (const room of rooms) {
    await pool.query('DELETE FROM events WHERE room_id = $1', [room]);
    await pool.query('DELETE FROM room_members WHERE room_id = $1', [room]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [room]);
  }
  rooms.length = 0;
});

async function startWith(factory: (id: string) => AgentAdapter): Promise<TestServer> {
  server = await startTestServer({ adapterFactory: factory });
  return server;
}

/** Poll the log until `predicate` holds, or throw. Provenance is asserted from the DB, not replay. */
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

interface SummonRow {
  member: string;
  requested_by: string;
  root_actor: string;
  root_is_human: boolean;
  depth: number;
}
async function summonsOf(roomId: string, member: string): Promise<SummonRow[]> {
  const { rows } = await pool.query<{ payload: SummonRow; root_is_human: boolean }>(
    `SELECT payload, root_is_human FROM events
      WHERE room_id = $1 AND event_type = 'summon' AND payload ->> 'member' = $2`,
    [roomId, member],
  );
  return rows.map((r) => ({ ...r.payload, root_is_human: r.root_is_human }));
}
async function turnsOf(roomId: string, adapterId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM events
      WHERE room_id = $1 AND event_type = 'agent.turn.completed' AND adapter_id = $2`,
    [roomId, adapterId],
  );
  return Number(rows[0].n);
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

describe('the near guard: the summon tool is offered only to a summon-authorised agent', () => {
  it('offers claude-main the summon tool and offers sol none', async () => {
    const seen: Record<string, unknown> = {};
    const s = await startWith((id) => replyingAdapter(id, seen));
    const roomId = uniqueRoomId('channel-tools');
    rooms.push(roomId);
    expect((await httpCreateRoom(s.httpBase, roomId, s.token)).status).toBe(201);
    await admitToRoom(roomId, 'claude-main', 'sol'); // both are tagged and must take a turn (ADR-009)

    const c = new Client(`${s.wsBase}/rooms/${roomId}/ws`, s.token);
    await c.open();
    c.send('@claude hello', 'tool-claude');
    await c.waitForType('agent.turn.completed');
    c.send('@sol hello', 'tool-sol');
    await until(
      () => Promise.resolve(seen),
      (m) => 'sol' in m,
    );
    c.close();

    // claude-main HAS summon.initiate → offered exactly the summon tool. sol does NOT → offered none,
    // so its model has nothing to call: the injection cannot even form for an unauthorised agent.
    const claudeTools = seen['claude-main'] as Array<{ name: string }> | undefined;
    expect(claudeTools?.map((t) => t.name)).toEqual(['summon']);
    expect(seen['sol']).toBeUndefined();
  });
});

describe('the path: an emitted summon converges and produces one attributed turn', () => {
  it('claude-main emits a summon of sol; sol is summoned at depth 1, rooted in the human', async () => {
    const s = await startWith((id) =>
      id === 'claude-main' ? summoningAdapter(id, 'sol') : replyingAdapter(id),
    );
    const roomId = uniqueRoomId('channel-path');
    rooms.push(roomId);
    expect((await httpCreateRoom(s.httpBase, roomId, s.token)).status).toBe(201);
    // claude-main takes a turn AND emits a summon of sol — sol must be in the room for that emission to
    // resolve (matchRoomAgent is per-room). Admit both.
    await admitToRoom(roomId, 'claude-main', 'sol');

    const c = new Client(`${s.wsBase}/rooms/${roomId}/ws`, s.token);
    await c.open();
    c.send('@claude please bring sol in', 'path-1');

    // Wait for the whole chain to settle: claude-main's turn, then sol's.
    await until(
      () => turnsOf(roomId, 'sol'),
      (n) => n >= 1,
    );
    c.close();

    // The emitted summon converged on the constructor: exactly ONE summon of sol, attributed to the
    // EMITTING agent, rooted in the HUMAN at the head of the chain, at depth 1 (one hop from human).
    const solSummons = await summonsOf(roomId, 'sol');
    expect(solSummons).toHaveLength(1);
    expect(solSummons[0].requested_by).toBe('claude-main');
    expect(solSummons[0].root_actor).toBe('prince');
    expect(solSummons[0].root_is_human).toBe(true);
    expect(solSummons[0].depth).toBe(1);
    // And exactly one turn from sol — one-turn-per-summon holds across the extra hop.
    expect(await turnsOf(roomId, 'sol')).toBe(1);
    // claude-main's own turn (depth 0) also ran.
    expect(await turnsOf(roomId, 'claude-main')).toBe(1);
  });
});

describe('the injection posture: a structured emission is only as authorised as its emitter', () => {
  it('sol emits a summon but its mandate does not grant it — REFUSED by the mandate check', async () => {
    // sol has no `summon.initiate`. Whatever made its model emit — an injection in its context is the
    // hazard this is named for — the constructor refuses it. This is RA-005 at the structured layer:
    // the control that stops it is the MANDATE, evaluated against the emitting agent.
    const s = await startWith((id) =>
      id === 'sol' ? summoningAdapter(id, 'claude-main') : replyingAdapter(id),
    );
    const roomId = uniqueRoomId('channel-inject');
    rooms.push(roomId);
    expect((await httpCreateRoom(s.httpBase, roomId, s.token)).status).toBe(201);
    // sol must be in the room to take its turn; claude-main is admitted too so the refusal that fires is the
    // MANDATE (sol lacks summon.initiate), never an incidental "target not in room" for claude-main.
    await admitToRoom(roomId, 'sol', 'claude-main');

    const c = new Client(`${s.wsBase}/rooms/${roomId}/ws`, s.token);
    await c.open();
    c.send('@sol do something', 'inject-1');
    await c.waitForType('agent.turn.completed'); // sol's own turn
    // Give the (refused) emitted summon a moment to be attempted and refused.
    await until(
      () => systemSays(roomId, 'cannot initiate a summon'),
      (v) => v,
    );
    c.close();

    // NO summon of claude-main was created — the emission was refused before it could form one.
    expect(await summonsOf(roomId, 'claude-main')).toHaveLength(0);
    // sol never summoned claude-main, so claude-main took no turn from this.
    expect(await turnsOf(roomId, 'claude-main')).toBe(0);
    // And the refusal is OUT LOUD, naming the control: sol's mandate does not grant it.
    expect(await systemSays(roomId, 'cannot initiate a summon')).toBe(true);
  });
});

describe('the depth cap under emission: a summoned agent may not start another summon', () => {
  it('refuses an over-depth emitted summon at the cap, out loud, and spends no tokens', async () => {
    // Driven at the constructor with a chain already at depth 1 — the position an agent B reaches
    // when A (human-rooted) emitted a summon of it. The subject is claude-main (authorised, so it
    // clears the mandate check and the DEPTH CAP is what refuses), which isolates the cap. No server:
    // the summon is dispatched straight at the constructor.
    const roomId = uniqueRoomId('channel-depth');
    rooms.push(roomId);
    await createRoom(pool, roomId, roomId, 'prince');
    // The EMITTER (claude-main) must be in the room: its mandate is roster_only, so an action requested under
    // it from a room it is not in is BLOCKed with ROSTER_VIOLATION before the depth cap can be the refusal.
    await admitToRoom(roomId, 'claude-main');

    let turnsTriggered = 0;
    const deps: CommandDeps = {
      pool,
      bus: new RoomBus(),
      log: { info() {}, warn() {}, error() {} },
      // If a turn is (wrongly) triggered, an adapter is built here — the tokens the cap must not spend.
      adapterFactory: (id) => {
        turnsTriggered += 1;
        return replyingAdapter(id);
      },
      execute: (ctx, command) => executeCommand(ctx, command, deps),
    };
    await executeCommand(
      { actorId: 'claude-main', mode: 'hosted' },
      {
        kind: 'summon',
        roomId,
        member: 'sol',
        causeSeq: 1,
        intent: 'claude-main (at depth 1) tries to summon sol',
        chain: { rootActor: 'prince', rootIsHuman: true, depth: 1 },
      },
      deps,
    );
    await new Promise((r) => setTimeout(r, 300)); // let any wrongly-triggered turn surface

    // depth would be 2, over the cap of 1 → refused before the summon is written.
    expect(await summonsOf(roomId, 'sol')).toHaveLength(0);
    // NO TOKENS: the refusal is before the adapter is ever built, so no turn was triggered.
    expect(turnsTriggered).toBe(0);
    expect(await turnsOf(roomId, 'sol')).toBe(0);
    // Out loud, naming the cap.
    expect(await systemSays(roomId, 'may not start another summon')).toBe(true);
  });
});

describe('control a: an emitted summon cannot name a member outside the room', () => {
  it('refuses a target that is not an agent member of this room', async () => {
    const roomId = uniqueRoomId('channel-target');
    rooms.push(roomId);
    await createRoom(pool, roomId, roomId, 'prince');
    // The emitter claude-main is in the room (roster_only mandate); the TARGET nobody-real is not — so the
    // refusal that fires is matchRoomAgent's "no agent by that name", the control this test is about.
    await admitToRoom(roomId, 'claude-main');

    const deps: CommandDeps = {
      pool,
      bus: new RoomBus(),
      log: { info() {}, warn() {}, error() {} },
      adapterFactory: (id) => replyingAdapter(id),
      execute: (ctx, command) => executeCommand(ctx, command, deps),
    };
    await executeCommand(
      { actorId: 'claude-main', mode: 'hosted' },
      {
        kind: 'summon',
        roomId,
        member: 'nobody-real',
        causeSeq: 1,
        intent: 'summon a member that is not here',
        chain: { rootActor: 'prince', rootIsHuman: true, depth: 0 },
      },
      deps,
    );

    expect(await systemSays(roomId, 'no agent by that name is in this room')).toBe(true);
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM events WHERE room_id = $1 AND event_type = 'summon'`,
      [roomId],
    );
    expect(Number(rows[0].n)).toBe(0);
  });
});
