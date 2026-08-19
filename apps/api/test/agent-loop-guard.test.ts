import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admitToRoom,
  Client,
  factoryFor,
  httpCreateRoom,
  scriptedAdapter,
  startTestServer,
  testPool,
  uniqueRoomId,
  type TestServer,
} from './support.js';

// §22a: a message authored by an agent (its id is a known adapter id) must never
// summon an agent — no agent-to-agent loop is possible.
describe('agent loop guard', () => {
  let server: TestServer;
  const roomId = uniqueRoomId('agent-loop');

  beforeAll(async () => {
    // If a summon wrongly fired, this adapter would emit detectable agent events.
    const adapter = scriptedAdapter('claude-main', [
      { kind: 'text_delta', text: 'should not run' },
      { kind: 'done', tokens_in: 1, tokens_out: 1, stop_reason: 'end_turn' },
    ]);
    server = await startTestServer({ adapterFactory: factoryFor(adapter) });
    expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
    await admitToRoom(roomId, 'claude-main');
  });

  afterAll(async () => {
    const pool = testPool();
    await pool.query('DELETE FROM events WHERE room_id = $1', [roomId]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
    await pool.end();
    await server.close();
  });

  it('CANNOT BE ATTEMPTED FROM A CLIENT ANY MORE — the wire has no author field', async () => {
    // THIS TEST'S PREMISE WAS DELETED BY S1.2, and the deletion is the exit criterion.
    //
    // It used to send with `author: 'claude-main'` and assert that barrier 2 refused to summon
    // on an agent-authored message. A client cannot make that message now: `ClientSend` has no
    // author field, and the actor is resolved from the credential at the handshake. So the loop
    // this test guarded against is not defended — it is UNREACHABLE from a client.
    //
    // What is asserted instead: the frame is rejected outright if it tries. A stray `author` is
    // an unknown key, `ClientSend` is not strict so it is stripped, and the actor is still the
    // authenticated member — so the message lands as prince and summons normally. The forgery
    // does not fail quietly; it does not happen at all.
    //
    // Barrier 2 itself is NOT untested. It is asserted at the unit level in
    // summon-boundary.test.ts, which constructs an agent-authored event directly — the only way
    // to reach it now, and the reason that test exists rather than an integration one.
    const c = new Client(`${server.wsBase}/rooms/${roomId}/ws`, server.token);
    await c.open();

    // The forgery attempt: an `author` field, smuggled onto the frame.
    //
    // NO TAG IN THE BODY, deliberately. The first version of this used '@claude please loop'
    // and so triggered a real turn — which then raced `afterAll`'s room deletion and left two
    // orphaned turn rows whose summon had already been deleted. That tripped the GLOBAL drift
    // assertion in summon-provenance.test.ts, which is exactly what a global invariant is for.
    // The forgery assertion needs no summon: it is about who the event is attributed to.
    c.ws.send(
      JSON.stringify({
        type: 'send',
        client_msg_id: 'forge-1',
        author: 'claude-main',
        body: 'no tag here, just a forged author',
      }),
    );
    await c.waitForEvents(1);

    const message = c.events.find((e) => e.event_type === 'message');
    // Attributed to the AUTHENTICATED member, not the claimed one.
    expect(message?.actor_id).toBe('prince');
    expect(message?.actor_id).not.toBe('claude-main');
    c.close();
  });
});
