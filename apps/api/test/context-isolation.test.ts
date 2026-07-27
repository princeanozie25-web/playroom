import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentMessage } from '@playroom/shared';
import { testPool, uniqueRoomId } from './support.js';
import { appendMessage, createRoom } from '../src/events.js';
import {
  AssemblyInvariantError,
  assembleContext,
  assemblyShape,
  windowFor,
  type Assembly,
} from '../src/assembly.js';
import { withPrincipalStore } from '../src/principal-store.js';

/**
 * ═══ THE CI-BLOCKING TEST: A FOREIGN STORE IS UNREACHABLE FROM ASSEMBLY ═══
 *
 * Bible §7.1, and specifically its parenthetical — unreachable "including through summaries,
 * embeddings and promoted items". That parenthetical is the whole test, because the naive version
 * (does Jerry's note appear in Prince's window?) misses every interesting way this breaks. A
 * summary of Jerry's note is Jerry's context. A vector derived from it leaks it to anything that can
 * compare vectors. And content that was promoted into a room has legitimately changed status, so the
 * question there is not whether it appears but WHETHER IT APPEARS AS PRIVATE CONTEXT OR AS THE
 * PUBLIC, CONSENTED THING IT BECAME.
 *
 * ── WHAT MAKES THIS ONE DIFFERENT FROM THE OTHER 309 ──
 *
 * Nothing about how it runs: every test in this repo already blocks the merge, and calling this one
 * "CI-blocking" would be a decoration if that were the end of it. What is different is that it runs
 * AS ITS OWN CI JOB (`context-isolation` in .github/workflows/ci.yml), so:
 *
 *   - it cannot be lost in a wall of 300 passing lines, and a red run names the invariant in the
 *     job title rather than in a line an operator has to scroll to find;
 *   - it runs even when an earlier suite fails, because the jobs are independent — a failure
 *     somewhere else cannot leave the question of cross-principal leakage unanswered;
 *   - `fileParallelism: false` means the main suite is serial and slow; this job answers the one
 *     question that must never be answered late.
 *
 * ── POSITIVE CONTROL FIRST ──
 *
 * "Jerry's text was not in Prince's window" is satisfied by an assembly that reads no store at all,
 * a typo'd principal id, and an empty table. So the first assertion is that assembly DOES reach a
 * store and DOES return the right one's contents. Absence only means something once presence is
 * proven in the same run.
 */

const pool = testPool();

// Distinctive enough that finding it anywhere is unambiguous, and nonsense enough that no provider
// or prompt would produce it by chance.
const FOREIGN_MARKER = 'ZARQUON-JERRY-PRIVATE-7f3a91';
const FOREIGN_SUMMARY_MARKER = 'ZARQUON-JERRY-SUMMARY-b45e02';
const OWN_MARKER = 'ZARQUON-PRINCE-PRIVATE-1c8d44';
// A vector with values no ordinary embedding would hold, so a match cannot be coincidence.
const FOREIGN_EMBEDDING = [1337.25, -4242.5, 9999.125];

const PRINCE = 'principal:prince';
const JERRY = 'principal:jerry';
const PRINCE_MEMBER = 'claude-main'; // acts for principal:prince
const JERRY_MEMBER = 'sol'; // acts for principal:jerry

const roomId = uniqueRoomId('ctxiso');
let plantedIds: string[] = [];
const SYSTEM = { text: 'SYSTEM FRAME FOR THE ISOLATION TEST', hash: 'test-hash' };

beforeAll(async () => {
  await createRoom(pool, roomId, 'Context isolation', 'prince');
  // Common ground: an ordinary room message, so the window has a shared part to be non-empty by.
  await appendMessage(pool, roomId, 'prince', `ci-${roomId}-1`, 'what is the state of the branch?');

  // PLANT THE ATTACK DATA. All three indirect paths get something real to find: a body, a summary
  // of that body, and an embedding derived from it. Written through the scoped store, so the plant
  // holds no privilege the product does not.
  const jerry = await withPrincipalStore(pool, JERRY, (s) =>
    s.add({
      kind: 'note',
      title: `Jerry's private position ${FOREIGN_MARKER}`,
      body: `Do not merge without a co-signature. ${FOREIGN_MARKER}`,
      summary: `co-signature required ${FOREIGN_SUMMARY_MARKER}`,
      embedding: FOREIGN_EMBEDDING,
    }),
  );
  const prince = await withPrincipalStore(pool, PRINCE, (s) =>
    s.add({
      kind: 'note',
      title: `Prince's own note ${OWN_MARKER}`,
      body: `This one SHOULD appear in Prince's window. ${OWN_MARKER}`,
    }),
  );
  plantedIds = [jerry.id, prince.id];
});

afterAll(async () => {
  // Planted rows removed through the same policy that governs them: each delete is scoped to the
  // principal that owns the row, because there is no privileged path here to clean up with.
  for (const [principal, id] of [
    [JERRY, plantedIds[0]],
    [PRINCE, plantedIds[1]],
  ] as const) {
    if (!id) continue;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE playroom_context');
      await c.query('SELECT set_config($1, $2, true)', ['playroom.principal_id', principal]);
      await c.query('DELETE FROM principal_context WHERE id = $1', [id]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  }
  await pool.query('DELETE FROM events WHERE room_id = $1', [roomId]);
  await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
  await pool.end();
});

/** Everything a provider would see, as one string: authors, bodies and the system frame. */
function flatten(w: { systemPrompt: string; messages: AgentMessage[] }): string {
  return [w.systemPrompt, ...w.messages.map((m) => `${m.author}: ${m.body}`)].join('\n');
}

async function assembleFor(memberId: string, principalId: string): Promise<Assembly> {
  return assembleContext(pool, {
    memberId,
    principalId,
    roomId,
    task: null,
    system: SYSTEM,
    commonGroundLimit: 30,
  });
}

describe('THE CORPUS — proven present before anything is proven absent', () => {
  it('assembly reaches a store at all, and reaches the RIGHT one', async () => {
    const assembly = await assembleFor(PRINCE_MEMBER, PRINCE);
    const shape = assemblyShape(assembly);
    const window = windowFor(assembly);

    // What this test searched, and how much of it there was — reported so a future reader can see
    // the assertions below were not made against an empty window.
    console.log(
      `[ctx-iso] corpus: common_ground=${shape.common_ground} own_store=${shape.own_store} ` +
        `task=${shape.task}; window chars=${flatten(window).length}; ` +
        `planted foreign items=1 (body+summary+embedding), own items>=1`,
    );

    expect(shape.common_ground, 'no common ground — the window is empty').toBeGreaterThan(0);
    expect(
      shape.own_store,
      'assembly read NO private store — absence below would be vacuous',
    ).toBeGreaterThan(0);
    // THE POSITIVE CONTROL: Prince's own marker IS in Prince's window.
    expect(flatten(window)).toContain(OWN_MARKER);
  });

  it('and the foreign store really does hold the planted content — it exists to be found', async () => {
    const theirs = await withPrincipalStore(pool, JERRY, (s) => s.items());
    const planted = theirs.find((i) => i.title.includes(FOREIGN_MARKER));
    expect(
      planted,
      'the attack data was never written; the leak tests would pass trivially',
    ).toBeDefined();
    expect(planted?.body).toContain(FOREIGN_MARKER);
    expect(planted?.summary).toContain(FOREIGN_SUMMARY_MARKER);
    expect(planted?.embedding).toEqual(FOREIGN_EMBEDDING);
  });
});

describe("a foreign store cannot reach the window — through any of §7.1's three paths", () => {
  it('PATH 1, the body: Jerry’s note is absent from Prince’s window', async () => {
    const window = windowFor(await assembleFor(PRINCE_MEMBER, PRINCE));
    expect(flatten(window)).not.toContain(FOREIGN_MARKER);
  });

  it('PATH 2a, the summary: the shorter form is still Jerry’s context, and is also absent', async () => {
    // The path a well-meaning optimisation opens. "Summarise everyone's context and put the summary
    // in the window" sounds like minimisation and is a cross-principal read with fewer characters.
    const window = windowFor(await assembleFor(PRINCE_MEMBER, PRINCE));
    expect(flatten(window)).not.toContain(FOREIGN_SUMMARY_MARKER);
  });

  it('PATH 2b, the embedding: no derived vector rides in, and none can', async () => {
    const assembly = await assembleFor(PRINCE_MEMBER, PRINCE);
    const window = windowFor(assembly);
    const text = flatten(window);
    for (const v of FOREIGN_EMBEDDING) {
      expect(text, `the vector component ${v} reached the window`).not.toContain(String(v));
    }
    // AND STRUCTURALLY, which is the stronger half: a window message is exactly two strings, so
    // there is nowhere for a vector to travel even if something wanted to send one. A future field
    // added to AgentMessage would fail this.
    for (const m of window.messages) {
      expect(Object.keys(m).sort()).toEqual(['author', 'body']);
      expect(typeof m.author).toBe('string');
      expect(typeof m.body).toBe('string');
    }
  });

  it('PATH 3, promoted items: there is NO promotion source, so promoted text can only be common ground', async () => {
    // Where this path is closed, at this commit. Assembly reads three sources and `own-store` is the
    // only private one; a promotion is therefore not a way into someone's window as PRIVATE context.
    // It can only become common ground — the room's own log, which every member of the room already
    // reads, and which is exactly what a promotion is FOR.
    //
    // Concretely: the same words, put in the room the way a promotion puts them there, appear as
    // common ground attributed to the actor who shared them, and NOT as a private part attributed
    // to Jerry's store.
    await appendMessage(
      pool,
      roomId,
      'prince',
      `ci-${roomId}-promo`,
      `sharing from my notes: co-signature required ${FOREIGN_SUMMARY_MARKER}`,
    );
    const assembly = await assembleFor(PRINCE_MEMBER, PRINCE);
    const shared = assembly.parts.filter((p) => p.source === 'common-ground');
    const priv = assembly.parts.filter((p) => p.source !== 'common-ground');
    expect(
      shared.some((p) => p.messages.some((m) => m.body.includes(FOREIGN_SUMMARY_MARKER))),
    ).toBe(true);
    expect(
      priv.some((p) => p.messages.some((m) => m.body.includes(FOREIGN_SUMMARY_MARKER))),
      'promoted text arrived as PRIVATE context, not as the shared thing it became',
    ).toBe(false);
    // Every private part in the window belongs to the principal being summoned. This is the general
    // form of the claim, and it is what makes the three cases above instances rather than a list.
    for (const p of assembly.parts) {
      if (p.principal_id !== null) expect(p.principal_id).toBe(PRINCE);
    }
    // S15-3 adds the promotion RECORD (§7.2: purpose, consent, provenance, content hash) and RA-005,
    // that a promoted span cannot activate a summon. What is asserted here is the reachability half,
    // which is what §7.1 governs; the record and the inertness are that commit's, not this one's.
  });

  it('AND THE REVERSE DIRECTION — Jerry’s agent cannot see Prince’s store either', async () => {
    // Run because a boundary tested one way round can be a comparison keyed to the wrong side. The
    // positive control here is Jerry's own marker, present in Jerry's window.
    const window = windowFor(await assembleFor(JERRY_MEMBER, JERRY));
    const text = flatten(window);
    expect(text, 'Jerry’s own note is missing — this direction is vacuous').toContain(
      FOREIGN_MARKER,
    );
    expect(text).not.toContain(OWN_MARKER);
  });
});

describe('the invariant is enforced by the code, and it FIRES', () => {
  // A check nobody has seen fail is a check nobody knows works. These hand-build the assemblies that
  // `assembleContext` cannot produce, which is the point: the assertion exists for the commit that
  // makes it producible.
  const base = (parts: Assembly['parts']): Assembly => ({
    member_id: PRINCE_MEMBER,
    principal_id: PRINCE,
    system: SYSTEM,
    parts,
  });

  it('refuses a window containing a foreign private part', () => {
    const bad = base([
      { source: 'own-store', principal_id: JERRY, messages: [{ author: 'x', body: 'leak' }] },
    ]);
    expect(() => windowFor(bad)).toThrow(AssemblyInvariantError);
    try {
      windowFor(bad);
    } catch (err) {
      expect((err as AssemblyInvariantError).found).toEqual([JERRY]);
      // The message names the boundary that was about to be crossed, not just that something failed.
      expect(String(err)).toContain('§7.1');
    }
  });

  it('refuses a window that MERGES two stores, even if one of them is ours', () => {
    expect(() =>
      windowFor(
        base([
          { source: 'own-store', principal_id: PRINCE, messages: [{ author: 'x', body: 'mine' }] },
          { source: 'own-store', principal_id: JERRY, messages: [{ author: 'x', body: 'theirs' }] },
        ]),
      ),
    ).toThrow(AssemblyInvariantError);
  });

  it('refuses a shared part that names a principal — a private source mislabelled', () => {
    expect(() =>
      windowFor(
        base([
          { source: 'common-ground', principal_id: JERRY, messages: [{ author: 'x', body: 'y' }] },
        ]),
      ),
    ).toThrow(AssemblyInvariantError);
  });

  it('refuses an UNDECLARED source — a new input cannot slip in unnoticed', () => {
    const smuggled = {
      source: 'vector-cache' as unknown as 'own-store',
      principal_id: null,
      messages: [{ author: 'x', body: 'y' }],
    };
    expect(() => windowFor(base([smuggled]))).toThrow(/unknown source/);
  });

  it('refuses a private part that names NOBODY — an unprovable part is refused', () => {
    expect(() =>
      windowFor(
        base([{ source: 'own-store', principal_id: null, messages: [{ author: 'x', body: 'y' }] }]),
      ),
    ).toThrow(AssemblyInvariantError);
  });
});
