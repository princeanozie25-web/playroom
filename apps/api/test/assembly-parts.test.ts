import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentTurnChunk } from '@playroom/shared';
import { dropRoomQuiesced, testPool, uniqueRoomId } from './support.js';
import { RoomBus } from '../src/bus.js';
import { appendAgentEvent, appendMessage, appendSummon, createRoom } from '../src/events.js';
import { ensureTask } from '../src/tasks.js';
import { executeCommand, type CommandDeps } from '../src/commands/index.js';
import {
  ASSEMBLY_PARTS,
  AssemblyInvariantError,
  assemblyShape,
  shapeSummary,
  windowFor,
  type Assembly,
  type AssemblyPart,
} from '../src/assembly.js';

/**
 * ═══ S-LOOP2 — THE PARTS OF A WINDOW ARE DECLARED ONCE (SL2-1) ═══
 *
 * S17-N1 was not "someone forgot two lines". It was a fact stated in six places, five of which could
 * be edited without the sixth. These walk the DECLARATION itself — never a copy of it — so a part
 * added tomorrow is covered by the same assertions today.
 */

const PRINCE = 'principal:prince';
const PRINCE_MEMBER = 'claude-main';
const SYSTEM = { text: 'SYSTEM FRAME FOR THE DECLARATION TEST', hash: 'test-hash' };

/** One part per declared source, each carrying a body that names it. */
function onePartEach(): AssemblyPart[] {
  return ASSEMBLY_PARTS.map((d) => ({
    source: d.source,
    principal_id: d.ownership === 'private' ? PRINCE : null,
    messages: [{ author: `author-of-${d.source}`, body: `BODY-OF-${d.source}` }],
  }));
}
const assemblyOf = (parts: AssemblyPart[]): Assembly => ({
  member_id: PRINCE_MEMBER,
  principal_id: PRINCE,
  system: SYSTEM,
  parts,
});

describe('every DECLARED part reaches the window (the S17-N1 class)', () => {
  it('windowFor accepts each declared part and carries its messages, in declaration order', () => {
    const assembly = assemblyOf(onePartEach());
    expect(() => windowFor(assembly)).not.toThrow();
    const w = windowFor(assembly);

    // Not one of them silently dropped: a part that is declared but missing from the flatten order
    // would assemble, assert, and then simply not be in what the model was sent.
    for (const d of ASSEMBLY_PARTS) {
      expect(
        w.messages.map((m) => m.body),
        `the declared part "${d.source}" never reached the window`,
      ).toContain(`BODY-OF-${d.source}`);
    }
    expect(w.messages).toHaveLength(ASSEMBLY_PARTS.length);

    // And in the order the declaration gives, which is the order the reasoning in it describes.
    expect(w.messages.map((m) => m.body)).toEqual(ASSEMBLY_PARTS.map((d) => `BODY-OF-${d.source}`));
  });

  it('each declared part is counted in the shape and named on the telemetry line', () => {
    const shape = assemblyShape(assemblyOf(onePartEach()));
    const summary = shapeSummary(shape);
    for (const d of ASSEMBLY_PARTS) {
      expect(Object.keys(shape), `"${d.source}" is missing from the shape`).toContain(
        d.source.replace(/-/g, '_'),
      );
      // The bug this catches by construction: the hand-written telemetry string predated the
      // briefing and never grew a term for it, so the logged composition omitted a whole region.
      expect(summary, `"${d.source}" is missing from the telemetry summary`).toContain(
        `${d.label}:1`,
      );
    }
  });

  it('exactly one declared part is private, and it is the member’s own store', () => {
    const privateParts = ASSEMBLY_PARTS.filter((d) => d.ownership === 'private');
    expect(privateParts.map((d) => d.source)).toEqual(['own-store']);
  });
});

describe('an UNDECLARED part is refused by name', () => {
  it('names the source that arrived and the sources that are declared', () => {
    const smuggled = {
      source: 'vector-cache' as unknown as AssemblyPart['source'],
      principal_id: null,
      messages: [{ author: 'x', body: 'y' }],
    };
    let caught: unknown;
    try {
      windowFor(assemblyOf([smuggled]));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AssemblyInvariantError);
    const message = String(caught);
    // THE REFUSAL IS HONEST: what came in, and what was expected instead.
    expect(message).toContain('vector-cache');
    expect(message).toContain('undeclared source');
    for (const d of ASSEMBLY_PARTS) expect(message).toContain(d.source);
    expect(message).toContain('§7.1');
  });
});

/**
 * AND WHEN IT DOES FIRE, THE LOOP SAYS SO. The refusal above is thrown deep in assembly; what an owner
 * actually reads is the sentence the standing order pauses with. S17-N1 wore "ended in error", which is
 * the same sentence a provider outage wears — so a fabric refusal spent a slice looking like a bad
 * night at the model. The class is now in the sentence.
 */
const pool = testPool();
const rooms: string[] = [];
let deps: CommandDeps;

function refusingAdapter(id: string): AgentAdapter {
  return {
    id,
    // eslint-disable-next-line require-yield
    async *stream(): AsyncGenerator<AgentTurnChunk> {
      throw new AssemblyInvariantError('a simulated undeclared part', PRINCE, []);
    },
  };
}

beforeEach(() => {
  deps = {
    pool,
    bus: new RoomBus(),
    log: { info() {}, warn() {}, error() {} },
    adapterFactory: (id) => refusingAdapter(id),
    execute: (ctx, command) => executeCommand(ctx, command, deps),
  };
});
afterEach(async () => {
  // Quiesce THEN delete (support.ts): the refusing adapter's turn is still landing rows when this
  // returns, and a room deleted mid-turn leaves debris §19 counts as unrooted — in another file.
  for (const room of rooms) await dropRoomQuiesced(pool, room);
  rooms.length = 0;
});
afterAll(async () => {
  await pool.end();
});

describe('a refusal pauses the loop OUT LOUD, wearing its own name', () => {
  it('the order pauses and the reason names the class, not just “ended in error”', async () => {
    const roomId = uniqueRoomId('sl2-refusal');
    rooms.push(roomId);
    await createRoom(pool, roomId, roomId, 'prince');

    const created = await executeCommand(
      { actorId: 'prince', mode: 'human' },
      {
        kind: 'createOrder',
        roomId,
        clientMsgId: `oc-${roomId}`,
        triggerEventType: 'agent.turn.completed',
        triggerMember: 'sol',
        actionMember: PRINCE_MEMBER,
        maxCycles: null,
        maxUnattendedCycles: 3,
        expiresAt: null,
      },
      deps,
    );
    if (!created.ok) throw new Error('order not created');

    // A real trigger: a completed turn with text, which is what the runner reacts to in production.
    const kick = await appendMessage(pool, roomId, 'prince', `kick-${roomId}`, '@sol start');
    const { task } = await ensureTask(pool, {
      roomId,
      assignee: 'sol',
      state: 'working',
      action: null,
      intent: 'the turn that triggers the cycle',
      createdBy: 'prince',
      causeSeq: kick.seq,
    });
    // The summon comes first, because §19's drift query is GLOBAL: a turn whose summon_id matches no
    // summon row is unrooted wherever it lives, and a teardown that loses a race would leak one.
    await appendSummon(
      pool,
      roomId,
      { task_id: task.id },
      {
        summon_id: `trig-${roomId}`,
        member: 'sol',
        requested_by: 'prince',
        root_actor: 'prince',
        root_is_human: true,
        depth: 0,
        cause_seq: kick.seq,
      },
    );
    const trigger = await appendAgentEvent(
      pool,
      roomId,
      'sol',
      { summon_id: `trig-${roomId}` },
      { task_id: task.id },
      'agent.turn.completed',
      {
        turn_id: `trig-turn-${roomId}`,
        adapter_id: 'sol',
        text: 'the prior turn',
        success: true,
        tokens_in: 1,
        tokens_out: 1,
        cost_usd: 0,
        error_class: null,
      },
      {
        adapter_id: 'sol',
        tokens_in: 1,
        tokens_out: 1,
        cost_usd: 0,
        latency_ms: 1,
        prompt_hash: null,
        success: true,
        error_class: null,
        timings: null,
      },
    );

    await executeCommand(
      { actorId: 'system', mode: 'system' },
      { kind: 'runOrders', roomId, member: 'sol', completedSeq: trigger.seq, success: true },
      deps,
    );

    const deadline = Date.now() + 15000;
    let row: { status: string; pause_reason: string | null } | undefined;
    for (;;) {
      const { rows } = await pool.query<{ status: string; pause_reason: string | null }>(
        `SELECT status, pause_reason FROM standing_orders WHERE id = $1`,
        [created.orderId],
      );
      row = rows[0];
      if (row?.status === 'PAUSED' || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(row?.status, 'the order kept cycling on a refused window').toBe('PAUSED');
    expect(row?.pause_reason).toContain('AssemblyInvariantError');

    // The room sees the same sentence — the record, not only the projection.
    const { rows: events } = await pool.query<{ payload: { reason: string } }>(
      `SELECT payload FROM events WHERE room_id = $1 AND event_type = 'order.status' ORDER BY seq DESC LIMIT 1`,
      [roomId],
    );
    expect(events[0].payload.reason).toContain('AssemblyInvariantError');
  });
});
