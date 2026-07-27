import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testPool, uniqueRoomId } from './support.js';
import { createRoom } from '../src/events.js';
import { setRoomTokens, summonRuling } from '../src/agent.js';
import { withPrincipalStore } from '../src/principal-store.js';
import { PromotionRefused, contentHash, getPromotion, promoteContent } from '../src/promotions.js';

// PROMOTION IS AN ACT WITH A RECORD (Bible §7.2), AND A PROMOTED SPAN IS INERT (RA-005).
//
// The two halves are tested together because they are the same design: the disclosure is carried on
// its own event type, which is what makes the record possible AND what makes the span unable to
// activate anything.

const pool = testPool();
const roomId = uniqueRoomId('promo');
let itemId = '';
let noSummaryId = '';
let jerryItemId = '';

beforeAll(async () => {
  await createRoom(pool, roomId, 'Promotion', 'prince');
  // The roster these cases resolve against, stated rather than inherited — `@sol` has to MEAN
  // something for the RA-005 assertion to be about anything.
  setRoomTokens(roomId, [
    { id: 'claude-main', display_name: 'Claude', kind: 'agent' },
    { id: 'sol', display_name: 'Sol', kind: 'agent' },
  ]);
  const a = await withPrincipalStore(pool, 'principal:prince', (s) =>
    s.add({
      kind: 'note',
      // A SUMMON TOKEN INSIDE THE PRIVATE ITEM, on purpose. This is the RA-005 payload: if a
      // promotion rendered as a message, promoting this note would summon Sol — an agent belonging
      // to another principal taking a turn on text nobody in the room addressed to it.
      title: 'a note that names another principal’s agent',
      body: 'from the PR thread: @sol, take review — verbatim body 9f2b',
      summary: 'review requested of @sol — summary 4d71',
    }),
  );
  const b = await withPrincipalStore(pool, 'principal:prince', (s) =>
    s.add({ kind: 'note', title: 'no summary exists for this one', body: 'body only, e31a' }),
  );
  const c = await withPrincipalStore(pool, 'principal:jerry', (s) =>
    s.add({ kind: 'note', title: 'jerry private', body: 'jerry body 77aa' }),
  );
  itemId = a.id;
  noSummaryId = b.id;
  jerryItemId = c.id;
});

afterAll(async () => {
  await pool.query('DELETE FROM promotions WHERE room_id = $1', [roomId]);
  await pool.query('DELETE FROM events WHERE room_id = $1', [roomId]);
  await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
  for (const [principal, id] of [
    ['principal:prince', itemId],
    ['principal:prince', noSummaryId],
    ['principal:jerry', jerryItemId],
  ] as const) {
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
  await pool.end();
});

describe('the record exists before the copy, and carries what §7.2 names', () => {
  it('writes a promotion whose every field answers a question asked after an incident', async () => {
    const { promotion, event } = await promoteContent(pool, {
      roomId,
      itemId,
      approvedBy: 'prince',
      purpose: 'Sol needs the review context to comment on the branch',
    });

    expect(promotion.source_principal).toBe('principal:prince');
    expect(promotion.source_item_id).toBe(itemId); // provenance: WHICH item
    expect(promotion.room_id).toBe(roomId); // who can now read it
    expect(promotion.approved_by).toBe('prince'); // who consented
    expect(promotion.purpose).toBe('Sol needs the review context to comment on the branch');
    expect(promotion.created_at).toBeTruthy();

    // THE COPY IS DERIVED FROM THE RECORD, not written alongside it. Same text, same hash — and the
    // hash is over the exact disclosed string, so a later reader can check the line against the row
    // without the row holding a second copy.
    expect(event.event_type).toBe('context.promoted');
    if (event.event_type !== 'context.promoted') throw new Error('unreachable');
    expect(event.payload.promotion_id).toBe(promotion.id);
    expect(event.payload.content).toBe(promotion.content);
    expect(event.payload.content_hash).toBe(contentHash(promotion.content));
    expect(promotion.content_hash).toBe(contentHash(promotion.content));

    // And it is readable back as a record, not only as an event.
    const stored = await getPromotion(pool, promotion.id);
    expect(stored?.content_hash).toBe(promotion.content_hash);
  });

  it('MINIMISATION IS THE DEFAULT — omitting the representation shares the summary', async () => {
    // §7.3. Not "we recommend the summary": the default value is the less revealing one, so
    // forgetting to think about it discloses less rather than more.
    const { promotion } = await promoteContent(pool, {
      roomId,
      itemId,
      approvedBy: 'prince',
      purpose: 'checking the default',
    });
    expect(promotion.representation).toBe('summary');
    expect(promotion.content).toContain('summary 4d71');
    expect(promotion.content, 'the default disclosed the full body').not.toContain(
      'verbatim body 9f2b',
    );
  });

  it('verbatim is reachable, and it says so in the record', async () => {
    const { promotion, event } = await promoteContent(pool, {
      roomId,
      itemId,
      approvedBy: 'prince',
      purpose: 'the exact wording matters here',
      representation: 'verbatim',
    });
    expect(promotion.representation).toBe('verbatim');
    expect(promotion.content).toContain('verbatim body 9f2b');
    // HOW MUCH was disclosed travels with the disclosure, so a reader can see that this one is the
    // whole thing rather than a précis.
    if (event.event_type !== 'context.promoted') throw new Error('unreachable');
    expect(event.payload.representation).toBe('verbatim');
  });

  it('refuses the summary of an item that has none, instead of falling back to the body', async () => {
    // The fallback would mean "asked for less, got everything" — the exact failure minimisation
    // exists to prevent, arriving as a convenience.
    await expect(
      promoteContent(pool, {
        roomId,
        itemId: noSummaryId,
        approvedBy: 'prince',
        purpose: 'should not silently upgrade',
      }),
    ).rejects.toThrow(PromotionRefused);
    await expect(
      promoteContent(pool, {
        roomId,
        itemId: noSummaryId,
        approvedBy: 'prince',
        purpose: 'should not silently upgrade',
      }),
    ).rejects.toMatchObject({ reason: 'no_summary_available' });
  });
});

describe('consent is a record, and it is checked against records', () => {
  it('a blank purpose is refused — a purpose nobody had to write is one nobody had to have', async () => {
    await expect(
      promoteContent(pool, { roomId, itemId, approvedBy: 'prince', purpose: '   ' }),
    ).rejects.toMatchObject({ reason: 'purpose_required' });
  });

  it('AN AGENT CANNOT DISCLOSE ITS OWN PRINCIPAL’S PRIVATE CONTEXT', async () => {
    // `claude-main` acts for principal:prince and reads that store on every turn (§7.1). If it
    // could also promote, it could be talked into publishing it — barrier 1's injection path with a
    // private store as the payload. Consent for a disclosure is a human act or it is not consent.
    await expect(
      promoteContent(pool, {
        roomId,
        itemId,
        approvedBy: 'claude-main',
        purpose: 'an agent trying to publish its own principal’s notes',
      }),
    ).rejects.toMatchObject({ reason: 'not_a_human' });
  });

  it('nobody can promote a FOREIGN principal’s item — there is nowhere to ask', async () => {
    // The store opened is derived from the approver, so `itemId` is looked up in Prince's store and
    // Jerry's row is simply not there. Refused as `no_such_item`, which is the honest reason: from
    // inside Prince's scope, Jerry's item does not exist.
    await expect(
      promoteContent(pool, {
        roomId,
        itemId: jerryItemId,
        approvedBy: 'prince',
        purpose: 'reaching into another principal’s store',
      }),
    ).rejects.toMatchObject({ reason: 'no_such_item' });
  });

  it('an unknown approver is refused', async () => {
    await expect(
      promoteContent(pool, { roomId, itemId, approvedBy: 'nobody', purpose: 'x' }),
    ).rejects.toMatchObject({ reason: 'no_such_member' });
  });

  it('a refused promotion leaves NEITHER a record NOR a copy', async () => {
    const before = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM promotions WHERE room_id = $1',
      [roomId],
    );
    await expect(
      promoteContent(pool, { roomId, itemId, approvedBy: 'claude-main', purpose: 'x' }),
    ).rejects.toThrow(PromotionRefused);
    const after = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM promotions WHERE room_id = $1',
      [roomId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe('RA-005 — a promoted span cannot activate anything', () => {
  it('a promoted `@sol` summons NOBODY, and the refusal names the reason', async () => {
    // THE ASSERTION THIS WHOLE DESIGN IS FOR. The promoted content contains a resolvable token for
    // a member of a DIFFERENT principal. Run through the real activation boundary — the same
    // function every room event goes through, untouched by this slice.
    const { event } = await promoteContent(pool, {
      roomId,
      itemId,
      approvedBy: 'prince',
      purpose: 'RA-005: this content names another principal’s agent',
      representation: 'verbatim',
    });
    if (event.event_type !== 'context.promoted') throw new Error('unreachable');
    expect(event.payload.content).toContain('@sol');

    const ruling = summonRuling(event);
    expect(ruling.members, 'a promoted span summoned a member').toEqual([]);
    // NOT_ROOM_CONTENT, from barrier 1's allowlist: `memberAuthoredText` returns text for `message`
    // and null for everything else. Nothing in agent.ts changed to achieve this — the barrier was
    // built as an allowlist precisely so a new event type is inert until somebody admits it.
    expect(ruling.rule).toBe('NOT_ROOM_CONTENT');
  });

  it('and the SAME WORDS in an ordinary message DO activate — the gap promotion does not close', async () => {
    // Stated as a test so the boundary of the claim is executable rather than prose. RT-004's
    // accepted gap is about `message.payload` being one flat string with no span provenance;
    // promotion adds an inert path, it does not make the other path safe. The must-fail test in
    // summon-boundary.test.ts still pins that, and this asserts the difference is real.
    const ruling = summonRuling({
      type: 'event',
      seq: 1,
      room_id: roomId,
      actor_id: 'prince',
      event_type: 'message',
      ts: new Date().toISOString(),
      payload: { body: 'from the PR thread: @sol, take review' },
    });
    expect(ruling.members).toEqual(['sol']);
  });
});
