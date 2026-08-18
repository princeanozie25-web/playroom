'use client';

import { useState, type FormEvent } from 'react';
import type { ServerErrorFrame } from '@playroom/shared';
import { HOOK, pr } from './hooks';

/**
 * ROOM TOOLS — the missing SURFACE for S1.7 briefings and S-UPLOAD documents (the SLIVE-N1 gap).
 *
 * The record, delivery and isolation of both shipped without a way to CREATE either from the app: a
 * briefing could only be set over a raw socket frame, a document only in-process. This is that
 * surface. It is deliberately PLAIN — functional wiring, not final design; a later design pass owns
 * the look, and this component is where it lands.
 *
 * ── THE GATE THAT MATTERS IS THE SERVER'S ──
 *
 * The parent renders this only for a human viewer, but that is convenience, not enforcement: the
 * server refuses a non-human by kind and a non-owner briefing by identity, whatever this shows. A
 * refused action arrives as a NON-FATAL notice here (see isCommandRefusal) — the room stays open and
 * the action simply did not happen, which is why the refusal shows in the tool rather than as the
 * room's dead-socket banner.
 */
export function RoomTools({
  send,
  refusal,
  onClear,
}: {
  /** Send a client frame over the room socket. The parent owns the socket; this owns the forms. */
  send: (frame: Record<string, unknown>) => void;
  /** The last command refusal (non-fatal), shown in place. Null when the last action was accepted. */
  refusal: ServerErrorFrame | null;
  /** Clear the notice — called before each submit so a stale refusal never lingers over a new try. */
  onClear: () => void;
}) {
  const [brief, setBrief] = useState({ content: '', purpose: '' });
  const [doc, setDoc] = useState({ title: '', purpose: '', provenance: '', content: '' });

  const submitBriefing = (e: FormEvent): void => {
    e.preventDefault();
    onClear();
    send({
      type: 'briefing_set',
      client_msg_id: crypto.randomUUID(),
      content: brief.content,
      purpose: brief.purpose,
    });
  };

  const submitDocument = (e: FormEvent): void => {
    e.preventDefault();
    onClear();
    send({
      type: 'document_upload',
      client_msg_id: crypto.randomUUID(),
      title: doc.title,
      purpose: doc.purpose,
      provenance: doc.provenance,
      // Text only, and the extension must agree with the type; the screen refuses the rest at the
      // server. Fixed to markdown here — a type picker is a design-pass concern, not a wiring one.
      declared_type: 'text/markdown',
      content: doc.content,
    });
  };

  return (
    <details className="room-tools" {...pr(HOOK.roomTools)}>
      <summary>Room tools — set a briefing, give a document</summary>

      {refusal ? (
        <p role="alert" className="room-tools-error" {...pr(HOOK.roomToolsError)}>
          <strong>{refusal.message}</strong> <span className="code">{refusal.code}</span>
        </p>
      ) : null}

      <form className="room-tools-briefing" onSubmit={submitBriefing}>
        <textarea
          className="what"
          placeholder="Room briefing — how work is done here"
          value={brief.content}
          onChange={(e) => setBrief({ ...brief, content: e.target.value })}
        />
        <input
          className="why"
          placeholder="Why (purpose)"
          value={brief.purpose}
          onChange={(e) => setBrief({ ...brief, purpose: e.target.value })}
        />
        <button type="submit" {...pr(HOOK.briefingSetSubmit)}>
          set briefing
        </button>
      </form>

      <form className="room-tools-document" onSubmit={submitDocument}>
        <input
          className="title"
          placeholder="Title"
          value={doc.title}
          onChange={(e) => setDoc({ ...doc, title: e.target.value })}
        />
        <input
          className="why"
          placeholder="Why (purpose)"
          value={doc.purpose}
          onChange={(e) => setDoc({ ...doc, purpose: e.target.value })}
        />
        <input
          className="provenance"
          placeholder="Filename (provenance), e.g. handoff.md"
          value={doc.provenance}
          onChange={(e) => setDoc({ ...doc, provenance: e.target.value })}
        />
        <textarea
          className="what"
          placeholder="The document text — .txt or .md, 8000 chars or fewer"
          value={doc.content}
          onChange={(e) => setDoc({ ...doc, content: e.target.value })}
        />
        <button type="submit" {...pr(HOOK.docUploadSubmit)}>
          give document
        </button>
      </form>
    </details>
  );
}
