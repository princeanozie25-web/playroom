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
  const canSetBriefing = brief.content.trim() !== '' && brief.purpose.trim() !== '';
  const canGiveDocument =
    doc.title.trim() !== '' &&
    doc.purpose.trim() !== '' &&
    doc.provenance.trim() !== '' &&
    doc.content.trim() !== '';

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
      <summary>
        <span className="room-tools-summary__title">Room tools</span>
        <span className="room-tools-summary__meta">Briefing and documents</span>
      </summary>

      {refusal ? (
        <p role="alert" className="room-tools-error" {...pr(HOOK.roomToolsError)}>
          <strong>{refusal.message}</strong> <span className="code">{refusal.code}</span>
        </p>
      ) : null}

      <div className="room-tools-panel">
        <section className="room-tool-section" aria-labelledby="briefing-tool-title">
          <div className="room-tool-section__head">
            <p className="room-tool-kicker">Common ground</p>
            <h2 id="briefing-tool-title">Set the room briefing</h2>
            <p>Give every member the same standing frame for future work.</p>
          </div>
          <form className="room-tools-briefing" onSubmit={submitBriefing}>
            <label htmlFor="room-briefing-content">Briefing</label>
            <textarea
              id="room-briefing-content"
              className="what"
              rows={4}
              required
              placeholder="How work should be done in this room"
              value={brief.content}
              onChange={(e) => setBrief({ ...brief, content: e.target.value })}
            />
            <label htmlFor="room-briefing-purpose">Purpose</label>
            <input
              id="room-briefing-purpose"
              className="why"
              required
              placeholder="Why this framing is needed"
              value={brief.purpose}
              onChange={(e) => setBrief({ ...brief, purpose: e.target.value })}
            />
            <button type="submit" disabled={!canSetBriefing} {...pr(HOOK.briefingSetSubmit)}>
              Set briefing
            </button>
          </form>
        </section>

        <section className="room-tool-section" aria-labelledby="document-tool-title">
          <div className="room-tool-section__head">
            <p className="room-tool-kicker">Room document</p>
            <h2 id="document-tool-title">Give a document</h2>
            <p>Attach bounded text with an explicit purpose and provenance.</p>
          </div>
          <form className="room-tools-document" onSubmit={submitDocument}>
            <div className="room-tool-field-row">
              <div>
                <label htmlFor="room-document-title">Title</label>
                <input
                  id="room-document-title"
                  className="title"
                  required
                  placeholder="Replay guard review"
                  value={doc.title}
                  onChange={(e) => setDoc({ ...doc, title: e.target.value })}
                />
              </div>
              <div>
                <label htmlFor="room-document-provenance">Filename</label>
                <input
                  id="room-document-provenance"
                  className="provenance"
                  required
                  placeholder="handoff.md"
                  value={doc.provenance}
                  onChange={(e) => setDoc({ ...doc, provenance: e.target.value })}
                />
              </div>
            </div>
            <label htmlFor="room-document-purpose">Purpose</label>
            <input
              id="room-document-purpose"
              className="why"
              required
              placeholder="What this document should help the room decide"
              value={doc.purpose}
              onChange={(e) => setDoc({ ...doc, purpose: e.target.value })}
            />
            <label htmlFor="room-document-content">Document text</label>
            <textarea
              id="room-document-content"
              className="what"
              rows={4}
              required
              maxLength={8000}
              aria-describedby="room-document-limit"
              placeholder="Plain text or Markdown, rendered as text"
              value={doc.content}
              onChange={(e) => setDoc({ ...doc, content: e.target.value })}
            />
            <p id="room-document-limit" className="room-tool-limit">
              {doc.content.length.toLocaleString()} / 8,000 characters
            </p>
            <button type="submit" disabled={!canGiveDocument} {...pr(HOOK.docUploadSubmit)}>
              Give document
            </button>
          </form>
        </section>
      </div>
    </details>
  );
}
