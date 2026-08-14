import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ClientFrame } from '@playroom/shared';
import {
  Client,
  httpCreateRoom,
  scriptedAdapter,
  startTestServer,
  testPool,
  uniqueRoomId,
  type TestServer,
} from './support.js';

// AN AGENT TURN MAY ONLY BE APPENDED BY THE GATEWAY'S ADAPTER PATH.
//
// This was already true when S1.2 started, and it was true BY ACCIDENT OF SHAPE: the WebSocket
// route happened to handle two frame types, and neither of them happened to reach
// `runAgentTurn`. Nobody had decided it. That is the S0.5b lesson exactly — barrier 1 held for
// weeks because generated text happened not to be a `message` event, and the day it was named
// as a decision the test suite could finally tell a guard from a coincidence.
//
// So this file asserts the property that MAKES the forged-Sol claim untrue in both halves:
//
//   1. a caller cannot AUTHOR as Sol           — identity.test.ts, closed by the credential
//   2. a caller cannot MANUFACTURE a Sol TURN  — here
//
// Half 2 matters independently, because a turn does not merely carry an actor id: it renders
// with the agent's accent, a spend line, and a mandate footer. A member reading the room takes
// `agent.turn.completed` as evidence that a model was actually called under a mandate. If that
// could be forged, the credential would have closed the cheap half of the lie and left the
// expensive one open.

const SRC = resolve(import.meta.dirname, '../src');

/**
 * Source with comments removed.
 *
 * The UI2 lesson: `hooks.test.ts` gave a FALSE PASS because the string it searched for appeared
 * in a doc comment. A structural assertion that matches prose is not a structural assertion —
 * this file's whole value is that it fails when someone opens the path, and a comment
 * mentioning `runAgentTurn` must not be able to satisfy it.
 */
function code(relPath: string): string {
  return readFileSync(resolve(SRC, relPath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every .ts file under src, recursively, relative to src. */
function srcFiles(dir = '.'): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(SRC, dir), { withFileTypes: true })) {
    const rel = dir === '.' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...srcFiles(rel));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(rel);
  }
  return out;
}

/** Which src files CALL a function, ignoring the file that declares it. */
function callers(fn: string, declaredIn: string): string[] {
  const call = new RegExp(`\\b${fn}\\s*\\(`);
  return srcFiles()
    .filter((f) => f !== declaredIn)
    .filter((f) => call.test(code(f)));
}

const pool = testPool();
let server: TestServer;
const rooms: string[] = [];

function room(prefix: string): string {
  const id = uniqueRoomId(prefix);
  rooms.push(id);
  return id;
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
  await pool.end();
  await server.close();
});

describe('the gateway is the only path — as a decision, not a shape', () => {
  it('ONE writer of agent turn events, and it is the turn runner', () => {
    // Deleting this assertion is easy; passing it while adding a second writer is not. A new
    // caller of `appendAgentEvent` anywhere in src fails here by name, and the failure says
    // which file — which is the question a reviewer would otherwise have to think to ask.
    expect(callers('appendAgentEvent', 'events.ts')).toEqual(['agent.ts']);
  });

  it('ONE caller of the turn runner in the product, and it is the command entry', () => {
    // Tests call `runAgentTurn` directly — deliberately, to reach the retry race that only the
    // database can refuse. Tests are not the product and are excluded by `srcFiles`. Inside
    // src there is exactly one caller, and it is the command whose input is a summon id.
    expect(callers('runAgentTurn', 'agent.ts')).toEqual(['commands/triggerAgentTurn.ts']);
  });

  it('the turn command is dispatched by the SUMMON command and nothing else', () => {
    const dispatchers = srcFiles()
      .filter((f) => f !== 'commands/index.ts' && f !== 'commands/context.ts')
      .filter((f) => /kind:\s*'triggerAgentTurn'/.test(code(f)));
    // So the chain is: authenticated frame → postMessage → summonRuling → summon → turn. Every
    // link is a decision recorded in one file, and the first link now carries a stamped actor.
    expect(dispatchers).toEqual(['commands/summon.ts']);
  });

  it('the wire admits exactly nine frames, and every path to agent work traces to a human', () => {
    // Read off the schema at runtime rather than grepped, so this cannot pass against a stale
    // build or a comment. A new frame type makes this test fail, which is the point: adding one
    // is then a decision about the activation boundary rather than an addition to a union.
    //
    // IT FIRED. S1.3 added `handoff` and this line failed, which is exactly the conversation the
    // assertion exists to force: does a handoff start a turn? It does NOT — see the case below,
    // and commands/handoff.ts, which says why. An agent cannot ask for work through a handoff, so a
    // transfer that triggered a turn would be the first path where something other than a human
    // summon put an agent to work.
    //
    // IT FIRED AGAIN in S1.4, for `downgrade`, and the answer is the same shape as the handoff's:
    // lowering an interrupt's claim on your attention changes what a member is ASKED to notice,
    // never what an agent is asked to DO. It cannot summon, and the case below asserts that
    // rather than trusting the argument.
    //
    // IT FIRED AGAIN in S2.2, for `sign_decision`, and this one's answer is DIFFERENT and is the
    // point of the slice. This commit only RECORDS a human's approve/deny as a decision.resolved
    // event and starts no turn. But whether an APPROVED decision then releases its held action — a
    // summon fires — is the co-sign EXECUTION, the next commit. When it does, that turn is
    // HUMAN-ROOTED by construction: a person signed it. So the boundary holds — every agent turn
    // still traces to a human — it simply gained a human-gated door that a paused, evaluated
    // decision passes through only when the required person signs. An agent can never send a
    // resolution that lands (commands/signDecision.ts), which is what keeps this a door and not a hole.
    //
    // IT FIRED AGAIN in S-LOOP, for `order_create` and `order_control`. A standing order fires summons
    // across cycles, so this is the other frame family that puts an agent to work — and the answer is
    // the same as sign_decision's, one level up: only a HUMAN may create, resume or revoke an order
    // (commands/order.ts refuses a non-human before anything else), and every summon an order fires is
    // HUMAN-ROOTED through the order's creator. So the boundary still holds — every agent turn traces
    // to a human — the order is a standing authorisation a person gave, not a way for an agent to
    // authorise itself. An agent can send neither frame that lands, which is what keeps it a door.
    //
    // IT FIRED AGAIN in S1.7, for `briefing_set` and `briefing_clear` — and the answer is the CLEANEST
    // of all: a briefing puts NO agent to work. It is owner-authored framing delivered as inert
    // assembled context (its own event type, never a `message`), so a briefing that reads like `@sol`
    // summons nobody. Only a HUMAN OWNER may set or clear one (commands/briefing.ts refuses a non-human
    // before ownership, and a non-owner after), and it CONFERS NO AUTHORITY — a member's evaluated
    // mandate is byte-identical with and without it. So the boundary holds untouched: no agent turn
    // traces to a briefing, and an agent can send neither frame that lands.
    const types = ClientFrame.options.map((o) => o.shape.type.value).sort();
    expect(types).toEqual([
      'briefing_clear',
      'briefing_set',
      'downgrade',
      'handoff',
      'order_control',
      'order_create',
      'request_action',
      'send',
      'sign_decision',
    ]);
  });
});

describe('and it holds against a client that tries', () => {
  it('REFUSES an invented turn-triggering frame — out loud, socket intact', async () => {
    const id = room('forge-turn');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();

    // The frame someone would try: the command kind, spelled exactly as the internal dispatch
    // spells it, with a summon id invented to satisfy the invariant it is trying to dodge.
    c.ws.send(
      JSON.stringify({
        type: 'triggerAgentTurn',
        room_id: id,
        adapterId: 'sol',
        summonId: 'sum_forged',
      }),
    );
    const refusal = await c.waitForError((e) => e.code === 'frame_unrecognised');
    expect(refusal.message).toMatch(/only `send`, `request_action` and `handoff`/);

    // Not JSON at all is the OTHER mistake and gets the other code — the same rule that keeps
    // `credential_required` apart from `credential_invalid`.
    c.ws.send('{not json');
    const malformed = await c.waitForError((e) => e.code === 'frame_malformed');
    expect(malformed.message).toMatch(/valid JSON/);

    // THE SOCKET IS STILL USABLE. A refusal is not a disconnection: the connection is
    // authenticated and its next frame may be perfectly good. Proving it here is what stops a
    // future "just close the socket" from looking harmless.
    c.send('still here', 'after-refusal');
    await c.waitForEvents(1);
    expect(c.events[0].actor_id).toBe('prince');

    // And nothing agent-shaped was written by any of it.
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM events
        WHERE room_id = $1 AND (event_type LIKE 'agent.turn.%' OR event_type = 'summon')`,
      [id],
    );
    expect(Number(rows[0].n)).toBe(0);
    c.close();
  });

  it('a HANDOFF moves work and starts NO TURN — the new frame does not open the path', async () => {
    // The substantive half of the assertion above. A handoff changes who holds a task; it does
    // not put anyone to work, because being given work and being asked to do it are different
    // events and only the second one is a summon. If this ever changes, every agent turn tracing
    // to a human summon stops being true — and that invariant is asserted globally, over the
    // whole database, in summon-provenance.
    const id = room('handoff-no-turn');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();
    c.send('@claude take a first look', 'h-1');
    await c.waitForType('agent.turn.completed');

    const { rows: taskRows } = await pool.query<{ id: string }>(
      'SELECT id FROM tasks WHERE room_id = $1',
      [id],
    );
    const before = c.ofType('agent.turn.started').length;
    c.handoff(taskRows[0].id, 'sol', 'pr.review');
    await c.waitForType('task.handoff');
    await new Promise((r) => setTimeout(r, 1200)); // long enough for a turn to have started

    expect(c.ofType('agent.turn.started')).toHaveLength(before);
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM events
        WHERE room_id = $1 AND event_type IN ('summon', 'agent.turn.started')
          AND seq > (SELECT MIN(seq) FROM events WHERE room_id = $1 AND event_type = 'task.handoff')`,
      [id],
    );
    expect(Number(rows[0].n)).toBe(0);
    c.close();
  });

  it('a turn that DOES exist arrives STAMPED — member, principal, mandate hash', async () => {
    // The positive half. `agent.turn.started` is the first event anything sees of a turn, and
    // it carries the authority context (Bible §4.1, §8.1) rather than making a reader ask for
    // it. Derived from records in stamp.ts, so there is no field here a client could influence.
    const id = room('stamped-turn');
    expect((await httpCreateRoom(server.httpBase, id, server.token)).status).toBe(201);
    const c = new Client(`${server.wsBase}/rooms/${id}/ws?after=0`, server.token);
    await c.open();
    c.send('@sol please take a look', 's-1');
    await c.waitForType('agent.turn.completed');

    const started = c.ofType('agent.turn.started')[0];
    if (started.event_type !== 'agent.turn.started') throw new Error('narrowing');
    expect(started.actor_id).toBe('sol');
    // Sol speaks for Jerry, and that is now a row rather than a sentence in a README.
    expect(started.payload.principal_id).toBe('principal:jerry');
    // A hash, not a mandate: the log records WHICH document was in force without copying it,
    // so a mandate edited afterwards does not silently rewrite what the turn ran under.
    // `sha256:<hex>`, algorithm named. A bare hash would have to be identified by length, and
    // the day a second algorithm appears every stored hash becomes ambiguous.
    expect(started.payload.mandate_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    c.close();
  });

  it('REFUSES TO STAMP a member that has no record — no turn is started on a guess', async () => {
    // Unit, deliberately. Reaching this through a live turn needs an id that IS a registered
    // adapter and IS NOT a member, and the registry and the roster do not currently disagree —
    // so a end-to-end version would assert nothing today and would quietly rot into asserting
    // nothing forever. The guard exists for the day they DO drift: a stamp assembled from
    // defaults would be a fabricated authority record, naming a principal nobody is bound to.
    //
    // It throws inside the turn's try block, so a turn that cannot be stamped is written as
    // completed{success:false} and read as a failure, rather than starting unstamped.
    const { stampFor, UnstampableMemberError } = await import('../src/stamp.js');
    await expect(stampFor(pool, 'nobody-at-all')).rejects.toThrow(UnstampableMemberError);

    const real = await stampFor(pool, 'sol');
    expect(real).toMatchObject({ member_id: 'sol', principal_id: 'principal:jerry' });
    expect(real.mandate_hash).toMatch(/^sha256:[0-9a-f]{64}$/);

    // A member with no mandate stamps NULL, not a placeholder. Omit, never stub: a zeroed hash
    // would read as a document, and the difference between "no mandate" and "some mandate I
    // cannot identify" is exactly what a receipt has to be able to say.
    const human = await stampFor(pool, 'prince');
    expect(human.mandate_hash).toBeNull();
  });
});
