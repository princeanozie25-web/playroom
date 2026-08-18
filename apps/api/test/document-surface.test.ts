import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  ERROR_DOCUMENT_NOT_HUMAN,
  ERROR_DOCUMENT_TOO_LARGE,
  ERROR_DOCUMENT_UNKNOWN,
  ClientDocumentUpload,
} from '@playroom/shared';
import {
  Client,
  expectEvent,
  httpCreateRoom,
  issueTestCredential,
  startTestServer,
  testPool,
  uniqueRoomId,
  type TestServer,
} from './support.js';
import { activeDocuments, DOCUMENT_MAX_CHARS } from '../src/documents.js';

/**
 * ═══ S-UPLOAD — THE UPLOAD SURFACE, ON THE WIRE ═══
 *
 * SU-1 wrote the record, SU-2 delivered it, SU-3 proved it isolated and inert — but nothing could GIVE
 * a room a document except in-process code. `document-upload.test.ts` owns the GATE (who may upload,
 * what is refused) against the command directly; this file owns the WIRE: the `document_upload` and
 * `document_remove` frames reaching that same command.
 *
 * The one property the wire ADDS is the one worth a security test: the uploader is the AUTHENTICATED
 * socket member, never a claim the frame can make. So an agent socket is refused BY KIND — over the
 * wire, before the screen and the caps — exactly as a direct call is, and the frame has no field that
 * could name an uploader at all.
 */

const pool = testPool();
const rooms: string[] = [];
let server: TestServer | undefined;

/** A valid upload frame. Spread and override per test. */
const DOC = {
  type: 'document_upload' as const,
  client_msg_id: 'ws-doc-1',
  title: 'Handoff',
  purpose: 'what the next cycle needs to know',
  provenance: 'handoff.md',
  declared_type: 'text/markdown',
  content: 'the pipeline is red because the token expired on Tuesday',
};

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
  // The agent credential issued for the refusal probe — deleted, not left to accumulate (S12-N3).
  await pool.query("DELETE FROM member_credentials WHERE label = 'doc-agent'");
  for (const id of rooms) {
    await pool.query('DELETE FROM room_documents WHERE room_id = $1', [id]);
    await pool.query('DELETE FROM events WHERE room_id = $1', [id]);
    await pool.query('DELETE FROM room_members WHERE room_id = $1', [id]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [id]);
  }
  rooms.length = 0;
});
afterAll(async () => {
  await pool.end();
});

/** A fresh server + room whose owner is the token's member (prince). */
async function room(prefix: string): Promise<{ roomId: string; server: TestServer }> {
  server = await startTestServer();
  const roomId = uniqueRoomId(prefix);
  rooms.push(roomId);
  expect((await httpCreateRoom(server.httpBase, roomId, server.token)).status).toBe(201);
  return { roomId, server };
}

describe('the upload surface: a document is given to a room over the wire', () => {
  it('the owner uploads over the socket, and the room receives a document.added derived from the row', async () => {
    const { roomId, server: s } = await room('doc-ws');
    const c = new Client(`${s.wsBase}/rooms/${roomId}/ws`, s.token);
    await c.open();
    c.ws.send(JSON.stringify(DOC));
    await c.waitForType('document.added');
    c.close();

    // THE RECORD holds it, uploaded by the AUTHENTICATED member (prince) — not a field in the frame.
    const docs = await activeDocuments(pool, roomId);
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe('Handoff');
    expect(docs[0].uploaded_by).toBe('prince');
    expect(docs[0].content).toContain('the token expired on Tuesday');

    // THE EVENT is derived from the row — same id — so the copy and the record cannot disagree.
    const evt = expectEvent(c.ofType('document.added')[0], 'document.added');
    expect(evt.payload.document_id).toBe(docs[0].id);
  });

  it('an AGENT socket is refused BY KIND over the wire — the uploader is the socket, not the frame', async () => {
    const { roomId, server: s } = await room('doc-ws-agent');
    // claude-main is an agent, enrolled into the room by creation, so it can open the socket — and is
    // refused at the upload by KIND, before the screen and the caps, exactly as a direct call is. There
    // is no field it could set to give a room a document as a human, because the frame has none.
    const agentToken = await issueTestCredential('claude-main', 'doc-agent');
    const c = new Client(`${s.wsBase}/rooms/${roomId}/ws`, agentToken);
    await c.open();
    c.ws.send(JSON.stringify({ ...DOC, client_msg_id: 'ws-doc-agent' }));
    const err = await c.waitForError((e) => e.code === ERROR_DOCUMENT_NOT_HUMAN);
    expect(err.code).toBe(ERROR_DOCUMENT_NOT_HUMAN);
    c.close();
    // Nothing was written — an agent's upload leaves no row.
    expect(await activeDocuments(pool, roomId)).toHaveLength(0);
  });

  it('a refusal reaches the client as an error frame — an over-cap document is refused, not truncated', async () => {
    const { roomId, server: s } = await room('doc-ws-cap');
    const c = new Client(`${s.wsBase}/rooms/${roomId}/ws`, s.token);
    await c.open();
    c.ws.send(
      JSON.stringify({
        ...DOC,
        client_msg_id: 'ws-doc-cap',
        content: 'x'.repeat(DOCUMENT_MAX_CHARS + 1),
      }),
    );
    const err = await c.waitForError((e) => e.code === ERROR_DOCUMENT_TOO_LARGE);
    expect(err.code).toBe(ERROR_DOCUMENT_TOO_LARGE);
    c.close();
    expect(await activeDocuments(pool, roomId)).toHaveLength(0);
  });

  it('the owner takes a document back over the wire; removing an unknown one is refused by its own reason', async () => {
    const { roomId, server: s } = await room('doc-ws-remove');
    const c = new Client(`${s.wsBase}/rooms/${roomId}/ws`, s.token);
    await c.open();
    c.ws.send(JSON.stringify(DOC));
    await c.waitForType('document.added');
    const [doc] = await activeDocuments(pool, roomId);

    c.ws.send(
      JSON.stringify({ type: 'document_remove', client_msg_id: 'ws-doc-rm', document_id: doc.id }),
    );
    await c.waitForType('document.removed');
    expect(await activeDocuments(pool, roomId)).toHaveLength(0);

    // A removal that names an unknown document is refused — absent and removed stay distinguishable.
    c.ws.send(
      JSON.stringify({
        type: 'document_remove',
        client_msg_id: 'ws-doc-rm-unknown',
        document_id: 'doc_does_not_exist',
      }),
    );
    const err = await c.waitForError((e) => e.code === ERROR_DOCUMENT_UNKNOWN);
    expect(err.code).toBe(ERROR_DOCUMENT_UNKNOWN);
    c.close();
  });

  it('the frame carries the document and NOTHING about who gave it — the uploader is structural', () => {
    // The send frame's no-author property, one region over. There is no field on the upload frame that
    // could name an uploader, so an agent cannot give a room a document AS a human however it forms the
    // frame — the strongest form of the human-only rule, structural rather than checked.
    const keys = Object.keys(ClientDocumentUpload.shape).sort();
    expect(keys).toEqual([
      'client_msg_id',
      'content',
      'declared_type',
      'provenance',
      'purpose',
      'title',
      'type',
    ]);
    for (const forbidden of [
      'actor',
      'author',
      'member',
      'member_id',
      'principal',
      'uploaded_by',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
