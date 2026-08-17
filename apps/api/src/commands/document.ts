import {
  ERROR_DOCUMENT_MALFORMED,
  ERROR_DOCUMENT_NOT_HUMAN,
  ERROR_DOCUMENT_NOT_TEXT,
  ERROR_DOCUMENT_ROOM_FULL,
  ERROR_DOCUMENT_TOO_LARGE,
  ERROR_DOCUMENT_UNKNOWN,
} from '@playroom/shared';
import { appendDocumentAdded, appendDocumentRemoved } from '../events.js';
import { memberRecord } from '../members.js';
import {
  addDocument,
  documentById,
  removeDocument,
  roomDocumentChars,
  screenDocument,
  DOCUMENT_MAX_CHARS,
  ROOM_DOCUMENTS_MAX_CHARS,
} from '../documents.js';
import type { CommandContext, CommandDeps } from './context.js';

// ============================================================================
// GIVING A ROOM A DOCUMENT (S-UPLOAD).
//
// An upload is a promotion (S1.5): the record carries uploader, purpose, provenance and hash, it is
// written BEFORE anything can read the content, and the room's event is derived from it.
//
// ── AN AGENT MAY NEVER UPLOAD ────────────────────────────────────────────────────────
//
// The briefing's line and the order's, for the same reason: a member that can put text into every
// other member's context has a channel that routes around the mandate. It would not need a scope, it
// would not produce a decision, and the text would arrive in the next cycle's window as reference
// material a reader has no way to distinguish from something a person chose to give.
//
// Checked against the AUTHENTICATED member's kind, never a claim in the frame, and refused first —
// before the screen, before the caps, before anything is read. An agent's malformed upload gets
// `document_not_human`, not `document_malformed`: the refusal a caller sees should name the rule that
// actually stopped them, and for an agent that rule is always this one.
// ============================================================================

export type DocumentResult =
  { ok: true; documentId: string } | { ok: false; refusal: { code: string; message: string } };

const refuse = (code: string, message: string): DocumentResult => ({
  ok: false,
  refusal: { code, message },
});

export async function uploadDocumentCommand(
  deps: CommandDeps,
  ctx: CommandContext,
  input: {
    roomId: string;
    clientMsgId: string;
    title: string;
    purpose: string;
    /** The original filename or origin, as given. Recorded as provenance; never trusted. */
    provenance: string;
    declaredType: string;
    content: string;
  },
): Promise<DocumentResult> {
  const base = { room_id: input.roomId, member: ctx.actorId };

  // 1. HUMAN ONLY. First, so an agent never reaches a refusal that suggests a fixable mistake.
  const actor = await memberRecord(deps.pool, ctx.actorId);
  if (!actor || actor.kind !== 'human') {
    deps.log.warn(
      { ...base, code: ERROR_DOCUMENT_NOT_HUMAN },
      'upload refused: only a human may give a room a document',
    );
    return refuse(
      ERROR_DOCUMENT_NOT_HUMAN,
      'only a human may give a room a document — a member that could would have a channel into ' +
        'every other member’s context that no mandate governs',
    );
  }

  // 2. THE FIELDS THAT MAKE IT PLACEABLE. A document with no purpose is reference material nobody
  //    can judge the relevance of, including the member reading it.
  const title = input.title.trim();
  const purpose = input.purpose.trim();
  const provenance = input.provenance.trim();
  if (!title || !purpose || !provenance || input.content.length === 0) {
    return refuse(
      ERROR_DOCUMENT_MALFORMED,
      'a document needs a title, a purpose, a provenance and some content — the purpose is what ' +
        'lets a reader decide whether it is relevant to them',
    );
  }

  // 3. THE PER-DOCUMENT CAP, refused here and never truncated later. A cut-off document is a
  //    different document and the member reading it cannot tell.
  if (input.content.length > DOCUMENT_MAX_CHARS) {
    deps.log.warn(
      { ...base, size: input.content.length, code: ERROR_DOCUMENT_TOO_LARGE },
      'upload refused: over the per-document cap',
    );
    return refuse(
      ERROR_DOCUMENT_TOO_LARGE,
      `a document must be ${DOCUMENT_MAX_CHARS} characters or fewer (this one is ` +
        `${input.content.length}) — it is pinned into every summon, so its size is paid on every turn`,
    );
  }

  // 4. THE MECHANICAL SCREEN. It stops accidents, not attacks — see documents.ts, which says so in
  //    the code rather than only here.
  const screen = screenDocument({
    filename: provenance,
    declaredType: input.declaredType,
    content: input.content,
  });
  if (!screen.ok) {
    deps.log.warn({ ...base, code: ERROR_DOCUMENT_NOT_TEXT }, 'upload refused: not text');
    return refuse(ERROR_DOCUMENT_NOT_TEXT, screen.reason!);
  }

  // 5. THE ROOM TOTAL. A per-document cap that allows ten documents recreates the problem it
  //    prevents, so the room is capped too — and it is refused at upload, where a person can act on
  //    it, rather than at assembly, where a member would silently get less than the room holds.
  const held = await roomDocumentChars(deps.pool, input.roomId);
  if (held + input.content.length > ROOM_DOCUMENTS_MAX_CHARS) {
    deps.log.warn(
      { ...base, held, adding: input.content.length, code: ERROR_DOCUMENT_ROOM_FULL },
      'upload refused: the room total would be exceeded',
    );
    return refuse(
      ERROR_DOCUMENT_ROOM_FULL,
      `this room already holds ${held} of ${ROOM_DOCUMENTS_MAX_CHARS} characters of documents, and ` +
        `this one is ${input.content.length} — remove one first, since every document here is paid ` +
        `on every summon`,
    );
  }

  // 6. THE RECORD, THEN THE EVENT DERIVED FROM IT.
  const doc = await addDocument(deps.pool, {
    roomId: input.roomId,
    uploadedBy: ctx.actorId,
    title,
    purpose,
    provenance,
    declaredType: input.declaredType,
    content: input.content,
  });
  const event = await appendDocumentAdded(deps.pool, input.roomId, ctx.actorId, {
    document_id: doc.id,
    title: doc.title,
    purpose: doc.purpose,
    provenance: doc.provenance,
    content_hash: doc.content_hash,
    size_chars: doc.size_chars,
    declared_type: doc.declared_type,
    uploaded_by: doc.uploaded_by,
  });
  deps.bus.publish(input.roomId, event);
  deps.log.info(
    { ...base, document_id: doc.id, size: doc.size_chars },
    'document given to the room',
  );
  return { ok: true, documentId: doc.id };
}

/**
 * TAKE A DOCUMENT BACK. Human-only for the same reason as giving one: an agent that could remove a
 * document could remove the framing another member is working from.
 */
export async function removeDocumentCommand(
  deps: CommandDeps,
  ctx: CommandContext,
  input: { roomId: string; clientMsgId: string; documentId: string },
): Promise<DocumentResult> {
  const base = { room_id: input.roomId, member: ctx.actorId };
  const actor = await memberRecord(deps.pool, ctx.actorId);
  if (!actor || actor.kind !== 'human') {
    deps.log.warn({ ...base, code: ERROR_DOCUMENT_NOT_HUMAN }, 'remove refused: not a human');
    return refuse(ERROR_DOCUMENT_NOT_HUMAN, 'only a human may take a document back');
  }
  const existing = await documentById(deps.pool, input.roomId, input.documentId);
  if (!existing || existing.removed_at !== null) {
    return refuse(
      ERROR_DOCUMENT_UNKNOWN,
      'no such document in this room, or it was already taken back',
    );
  }
  const removed = await removeDocument(deps.pool, input.roomId, input.documentId);
  if (!removed) {
    // Lost a race with another removal. The first one evented; a second event would say it happened
    // twice, which it did not.
    return refuse(ERROR_DOCUMENT_UNKNOWN, 'that document was already taken back');
  }
  const event = await appendDocumentRemoved(deps.pool, input.roomId, ctx.actorId, {
    document_id: removed.id,
    title: removed.title,
    content_hash: removed.content_hash,
    removed_by: ctx.actorId,
  });
  deps.bus.publish(input.roomId, event);
  deps.log.info({ ...base, document_id: removed.id }, 'document taken back');
  return { ok: true, documentId: removed.id };
}
