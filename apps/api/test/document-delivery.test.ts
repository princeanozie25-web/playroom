import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentTurnChunk } from '@playroom/shared';
import {
  dropRoomQuiesced,
  httpCreateRoom,
  startTestServer,
  testPool,
  uniqueRoomId,
  type TestServer,
} from './support.js';
import { RoomBus } from '../src/bus.js';
import { createRoom, appendMessage } from '../src/events.js';
import { setBriefing } from '../src/briefings.js';
import { ASSEMBLY_PARTS, assembleContext } from '../src/assembly.js';
import { RECENT_WINDOW_MESSAGES } from '../src/summary.js';
import { executeCommand, type CommandDeps } from '../src/commands/index.js';

/**
 * ═══ S-UPLOAD — DELIVERY (SU-2) ═══
 *
 * A document is only useful if it reaches the member doing the work. The briefing solved this once
 * (S1.7) and this is the same shape: pinned ahead of the window, read from the record, delivered to a
 * summoned member AND to a puller reading through the door.
 *
 * THE FIRST TEST HERE IS THE ONE THAT MATTERS MOST — a room with no documents must assemble exactly
 * as it did before this slice. Every room in production is that room, so a regression there is a
 * regression everywhere, and it is asserted before anything about documents is asserted at all.
 */

const pool = testPool();
const rooms: string[] = [];

function replier(id: string): AgentAdapter {
  return {
    id,
    async *stream(): AsyncGenerator<AgentTurnChunk> {
      yield { kind: 'done', tokens_in: 1, tokens_out: 1, stop_reason: 'end_turn' };
    },
  };
}

let deps: CommandDeps;
beforeEach(() => {
  deps = {
    pool,
    bus: new RoomBus(),
    log: { info() {}, warn() {}, error() {} },
    adapterFactory: (id) => replier(id),
    execute: (ctx, command) => executeCommand(ctx, command, deps),
  };
});
afterEach(async () => {
  for (const room of rooms) await dropRoomQuiesced(pool, room);
  rooms.length = 0;
});
afterAll(async () => {
  await pool.end();
});

async function newRoom(prefix: string): Promise<string> {
  const id = uniqueRoomId(prefix);
  rooms.push(id);
  await createRoom(pool, id, id, 'prince');
  return id;
}

function assemble(roomId: string, member = 'claude-main') {
  return assembleContext(pool, {
    memberId: member,
    principalId: 'principal:prince',
    roomId,
    task: null,
    system: { text: 'system', hash: 'h' },
    commonGroundLimit: RECENT_WINDOW_MESSAGES,
  });
}

async function give(roomId: string, over: Partial<{ title: string; content: string }> = {}) {
  const res = await executeCommand(
    { actorId: 'prince', mode: 'human' },
    {
      kind: 'uploadDocument',
      roomId,
      clientMsgId: `up-${roomId}-${Math.random().toString(36).slice(2, 8)}`,
      title: 'Handoff',
      purpose: 'what the next cycle needs to know',
      provenance: 'handoff.md',
      declaredType: 'text/markdown',
      content: 'the pipeline is red because the token expired on Tuesday',
      ...over,
    },
    deps,
  );
  if (!res.ok) throw new Error(`upload refused: ${JSON.stringify(res)}`);
  return res.documentId;
}

/** Fill the recent window past its limit, so nothing here works because the room happened to be empty. */
async function fillWindow(roomId: string): Promise<void> {
  for (let i = 0; i < RECENT_WINDOW_MESSAGES + 6; i += 1) {
    await appendMessage(pool, roomId, 'prince', `fill-${roomId}-${i}`, `filler message ${i}`);
  }
}

describe('a room with no documents is byte-identical to before this slice', () => {
  it('pushes no documents part, and the assembled window is unchanged', async () => {
    const roomId = await newRoom('su2-none');
    await setBriefing(pool, { roomId, content: 'brief', purpose: 'p', setBy: 'prince' });
    await fillWindow(roomId);

    const win = await assemble(roomId);
    const sources = win.parts.map((p) => p.source);
    expect(sources).not.toContain('documents');
    // The parts a room had before S-UPLOAD are exactly the parts it has now.
    expect(new Set(sources)).toEqual(new Set(['briefing', 'common-ground', 'own-store']));
  });
});

describe('a document reaches a summoned member', () => {
  it('IN A FULL WINDOW — pinned, so window pressure cannot evict it', async () => {
    const roomId = await newRoom('su2-full');
    await setBriefing(pool, {
      roomId,
      content: 'how work is done here',
      purpose: 'p',
      setBy: 'prince',
    });
    await give(roomId);
    // The window is FULL: in an empty room this feature would work by accident.
    await fillWindow(roomId);

    const win = await assemble(roomId);
    const docParts = win.parts.filter((p) => p.source === 'documents');
    expect(docParts).toHaveLength(1);
    const body = docParts[0].messages.map((m) => m.body).join('\n');
    expect(body).toContain('the token expired on Tuesday');
    // THE PURPOSE TRAVELS WITH IT — a reader has to be able to judge relevance.
    expect(body).toContain('what the next cycle needs to know');
    // And it is attributed to a namespace, never to a member: reference material is not something
    // a member said, and nothing downstream may mistake it for one.
    expect(docParts[0].messages[0].author).toBe('context/document:Handoff');
    expect(docParts[0].principal_id).toBeNull();
  });

  it('two documents arrive as two spans, each naming its own title', async () => {
    const roomId = await newRoom('su2-two');
    await give(roomId, { title: 'Handoff', content: 'the first thing' });
    await give(roomId, { title: 'Checklist', content: 'the second thing' });
    const win = await assemble(roomId);
    const docs = win.parts.filter((p) => p.source === 'documents');
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.messages[0].author)).toEqual([
      'context/document:Handoff',
      'context/document:Checklist',
    ]);
  });

  it('a REMOVED document is not assembled — absent and removed differ in the record, not the window', async () => {
    const roomId = await newRoom('su2-removed');
    const id = await give(roomId);
    await executeCommand(
      { actorId: 'prince', mode: 'human' },
      { kind: 'removeDocument', roomId, clientMsgId: `rm-${roomId}`, documentId: id },
      deps,
    );
    const win = await assemble(roomId);
    expect(win.parts.filter((p) => p.source === 'documents')).toHaveLength(0);
  });
});

describe('the regions are distinguishable, and declared in one place', () => {
  it('documents sits AFTER the briefing and BEFORE the conversation', async () => {
    const roomId = await newRoom('su2-order');
    await setBriefing(pool, { roomId, content: 'framing', purpose: 'p', setBy: 'prince' });
    await give(roomId);
    await fillWindow(roomId);

    const order = (await assemble(roomId)).parts.map((p) => p.source);
    // The framing says HOW work is done, a document is what the work is ABOUT, the window is what has
    // been SAID. A member that cannot tell those apart cannot weigh them.
    expect(order.indexOf('briefing')).toBeLessThan(order.indexOf('documents'));
    expect(order.indexOf('documents')).toBeLessThan(order.indexOf('common-ground'));
  });

  it('the part is declared in ASSEMBLY_PARTS and nowhere else', () => {
    // SL2-1 made this table the single source of truth after the same fact was enumerated in six
    // places. A sixth part that did not go through it would put the count back to being a coincidence.
    const sources = ASSEMBLY_PARTS.map((p) => p.source);
    expect(sources).toContain('documents');
    expect(sources.length).toBe(6);
    expect(new Set(sources).size).toBe(6);
    const decl = ASSEMBLY_PARTS.find((p) => p.source === 'documents')!;
    expect(decl.ownership).toBe('shared');
    expect(decl.label).toBe('docs');
    // Every part must say WHY it is in a member's window, and the declaration is where that lives.
    expect(decl.why.length).toBeGreaterThan(80);
  });

  it('a document is SHARED — it never names a principal', async () => {
    const roomId = await newRoom('su2-shared');
    await give(roomId);
    const win = await assemble(roomId);
    const priv = win.parts.filter((p) => p.principal_id !== null);
    // The only part that may name a principal is own-store. A document a person gave the ROOM is
    // common ground by construction; if it ever carried one, this is where that shows up.
    expect(priv.map((p) => p.source)).toEqual(['own-store']);
  });
});

/**
 * THE SECOND DELIVERY POINT (S1.7's shape). A PULLER — claude-code reads history, it is never
 * summoned — must inherit what a summoned member gets. Without this a document would reach
 * `claude-audit` and not `claude-code`, which is exactly the asymmetry the briefing's history field
 * was built to avoid.
 */
describe('a puller reading through the door receives it too', () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('GET /history carries the documents as their own field, with their bodies', async () => {
    server = await startTestServer();
    const roomId = uniqueRoomId('su2-puller');
    rooms.push(roomId);
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    await give(roomId, { title: 'Handoff', content: 'the token expired on Tuesday' });

    const res = await fetch(`${server.httpBase}/rooms/${roomId}/history`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: unknown[];
      documents: Array<{ title: string; content: string; purpose: string; content_hash: string }>;
    };
    expect(body.documents).toHaveLength(1);
    expect(body.documents[0].title).toBe('Handoff');
    // THE BODY IS HERE, unlike in the event payload: a puller is doing what assembly does — collecting
    // the context it is about to work from — and a manifest it cannot read would force a second trip.
    expect(body.documents[0].content).toContain('the token expired on Tuesday');
    expect(body.documents[0].purpose).toBe('what the next cycle needs to know');
    expect(body.documents[0].content_hash).toMatch(/^[0-9a-f]{64}$/);

    // PINNED, NOT PAGINATED: it is its own top-level field and never interleaved into `events`, so a
    // cursor cannot page past it the way it could page past a message.
    expect(JSON.stringify(body.events)).not.toContain('the token expired on Tuesday');
  });

  it('a room with no documents returns an empty list, not a missing field', async () => {
    server = await startTestServer();
    const roomId = uniqueRoomId('su2-puller-none');
    rooms.push(roomId);
    await httpCreateRoom(server.httpBase, roomId, server.token);
    const res = await fetch(`${server.httpBase}/rooms/${roomId}/history`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    const body = (await res.json()) as { documents: unknown[] };
    // An absent field and an empty list read differently to a client, and one of them is a bug the
    // first time a puller does `body.documents.map`.
    expect(Array.isArray(body.documents)).toBe(true);
    expect(body.documents).toHaveLength(0);
  });
});
