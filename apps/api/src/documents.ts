import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

/**
 * ═══ DOCUMENTS GIVEN TO A ROOM (S-UPLOAD) ═══
 *
 * The record layer. An upload is a promotion (S1.5): the row is written before anything can read the
 * content, and the room event is derived from the row rather than the other way round.
 *
 * Everything that DECIDES — who may upload, what is refused, which caps apply — lives in
 * `commands/document.ts`, because those are authority questions and this file is storage. What lives
 * here is the shape, the hash, the caps as constants, and the mechanical screen.
 */

/**
 * THE PER-DOCUMENT CAP, and 8,000 is not an arbitrary number.
 *
 * `server.ts:1167` already refuses a message body over 8,000 characters, so the system has ONE answer
 * to "how much text is one thing" rather than two that will drift. At this repo's measured 3.9
 * chars/token (ST-4's controlled pair), a document at the cap is ~2,050 tokens — which roughly
 * doubles a cycle's input when a document is present and costs nothing when it is not.
 *
 * REFUSED, NEVER TRUNCATED. A cut-off document is a different document, and the member reading it
 * cannot tell. Same rule as the order's task and the briefing.
 */
export const DOCUMENT_MAX_CHARS = 8000;

/**
 * THE ROOM TOTAL — three documents at the cap.
 *
 * A per-document cap that allows ten documents recreates the problem it prevents: ten capped
 * documents is 80,000 characters, which is worse than the 49,630-character report this slice exists
 * to refuse. So the room is capped too.
 *
 * WHY 24,000 AND NOT 8,000 OR 80,000. At 8,000 the room holds one document and "documents are many,
 * additive" is false — a handoff, a spec and a checklist is a normal set. At 24,000 the worst case is
 * ~6,150 tokens of standing reference, and a twelve-cycle loop carrying a full room costs about
 * $0.074 — under half the ~$0.153 that pinning the Fable report alone would have cost, so the
 * ruling's arithmetic still holds at the worst case rather than only at the typical one.
 */
export const ROOM_DOCUMENTS_MAX_CHARS = 24000;

export interface DocumentRow {
  id: string;
  room_id: string;
  uploaded_by: string;
  title: string;
  purpose: string;
  provenance: string;
  content: string;
  content_hash: string;
  size_chars: number;
  declared_type: string;
  created_at: string;
  /** NULL while the document is in the room; a timestamp once a person took it back. */
  removed_at: string | null;
}

const DOC_COLS = `id, room_id, uploaded_by, title, purpose, provenance, content, content_hash,
  size_chars, declared_type, created_at, removed_at`;

export function documentContentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * ═══ THE SCREEN IS MECHANICAL. IT IS NOT A CLASSIFIER. ═══
 *
 * Say plainly what this is for: it stops ACCIDENTS — a PDF dragged in by mistake, a screenshot, a zip
 * — and it stops nothing else. It cannot tell hostile text from friendly text and does not try. A
 * determined uploader who renames a binary and declares it text can defeat every check below by
 * construction, and that is FINE, because the defence against hostile content is not this function:
 * it is that promoted content is inert (RA-005) and cannot cause a structured emission (S1.8).
 *
 * Anyone who later reads this as a security boundary will widen it into one, so it says here that it
 * is not. Three mechanical checks, in the order a person would do them:
 *
 *   1. the DECLARED type, which is a claim by the uploader
 *   2. the FILENAME's extension, which is a convention
 *   3. a LOOK AT THE BYTES for the marks binaries start with, and for control characters that text
 *      does not contain
 */
const ALLOWED_TYPES: ReadonlySet<string> = new Set([
  'text/plain',
  'text/markdown',
  'text/x-markdown',
]);

const ALLOWED_EXTENSIONS: readonly string[] = ['.txt', '.md', '.markdown', '.text'];

/** Leading bytes that name a container this system will not read. Not exhaustive, and not meant to be. */
const BINARY_SIGNATURES: ReadonlyArray<[string, string]> = [
  ['%PDF-', 'a PDF'],
  ['PK\x03\x04', 'a zip or office archive'],
  ['PNG', 'a PNG image'],
  ['GIF8', 'a GIF image'],
  ['ÿØÿ', 'a JPEG image'],
  ['\x1f', 'a gzip archive'],
  ['\x00asm', 'a WebAssembly module'],
  ['ELF', 'an executable'],
];

export interface ScreenResult {
  ok: boolean;
  /** The mechanical reason, in a sentence a person can act on. Null when it passed. */
  reason: string | null;
}

/**
 * The mechanical screen. Returns why it refused, in words — never a code alone, because the person
 * who meets this is a person holding a file that did not go in.
 */
export function screenDocument(input: {
  filename: string;
  declaredType: string;
  content: string;
}): ScreenResult {
  const type = input.declaredType.trim().toLowerCase().split(';')[0];
  if (!ALLOWED_TYPES.has(type)) {
    return {
      ok: false,
      reason:
        `this room takes text documents only, and "${input.declaredType}" is not one — ` +
        `send it as .txt or .md`,
    };
  }
  const lower = input.filename.trim().toLowerCase();
  if (!ALLOWED_EXTENSIONS.some((e) => lower.endsWith(e))) {
    return {
      ok: false,
      reason:
        `"${input.filename}" does not end in .txt or .md — the extension and the declared type ` +
        `must agree, so a mistake is caught before the content is stored`,
    };
  }
  for (const [sig, what] of BINARY_SIGNATURES) {
    if (input.content.startsWith(sig)) {
      return { ok: false, reason: `this looks like ${what}, not text — its first bytes say so` };
    }
  }
  // A NUL or a stray control byte is the cheapest evidence that something is not text. Tab, newline
  // and carriage return are text and are excluded from the check by name.
  const control = /[\x00-\x08\x0b\x0c\x0e-\x1f]/.exec(input.content);
  if (control) {
    return {
      ok: false,
      reason:
        `this contains a control character (0x${control[0].charCodeAt(0).toString(16).padStart(2, '0')}) ` +
        `that text does not — it is probably a binary file with a text extension`,
    };
  }
  return { ok: true, reason: null };
}

function toRow(r: DocumentRow & { created_at: Date; removed_at: Date | null }): DocumentRow {
  return {
    ...r,
    created_at: r.created_at.toISOString(),
    removed_at: r.removed_at ? r.removed_at.toISOString() : null,
  };
}

/** How many characters of ACTIVE document this room already holds — the room cap's input. */
export async function roomDocumentChars(pool: Pool, roomId: string): Promise<number> {
  const { rows } = await pool.query<{ total: string | null }>(
    `SELECT sum(size_chars) AS total FROM room_documents
      WHERE room_id = $1 AND removed_at IS NULL`,
    [roomId],
  );
  return Number(rows[0].total ?? 0);
}

/**
 * WRITE THE RECORD. Returns the stored row, which the command turns into the room's event — so the
 * event is derived from the record and the two cannot disagree (S1.5, and the shape promotions.ts
 * and briefings.ts both hold).
 */
export async function addDocument(
  pool: Pool,
  input: {
    roomId: string;
    uploadedBy: string;
    title: string;
    purpose: string;
    provenance: string;
    declaredType: string;
    content: string;
  },
): Promise<DocumentRow> {
  const id = `doc_${randomBytes(8).toString('hex')}`;
  const { rows } = await pool.query<DocumentRow & { created_at: Date; removed_at: Date | null }>(
    `INSERT INTO room_documents
       (id, room_id, uploaded_by, title, purpose, provenance, content, content_hash,
        size_chars, declared_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${DOC_COLS}`,
    [
      id,
      input.roomId,
      input.uploadedBy,
      input.title.trim(),
      input.purpose.trim(),
      input.provenance.trim(),
      input.content,
      documentContentHash(input.content),
      input.content.length,
      input.declaredType.trim(),
    ],
  );
  return toRow(rows[0]);
}

/** Every ACTIVE document in the room, oldest first — the order a reader met them in. */
export async function activeDocuments(pool: Pool, roomId: string): Promise<DocumentRow[]> {
  const { rows } = await pool.query<DocumentRow & { created_at: Date; removed_at: Date | null }>(
    `SELECT ${DOC_COLS} FROM room_documents
      WHERE room_id = $1 AND removed_at IS NULL ORDER BY created_at, id`,
    [roomId],
  );
  return rows.map(toRow);
}

export async function documentById(
  pool: Pool,
  roomId: string,
  id: string,
): Promise<DocumentRow | null> {
  const { rows } = await pool.query<DocumentRow & { created_at: Date; removed_at: Date | null }>(
    `SELECT ${DOC_COLS} FROM room_documents WHERE id = $1 AND room_id = $2`,
    [id, roomId],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * TAKE IT BACK. Stamps `removed_at` rather than deleting: absent and removed are different states,
 * and a reader of the log must be able to tell them apart. Returns the row iff this call is the one
 * that removed it, so a repeated removal is a no-op rather than a second event.
 */
export async function removeDocument(
  pool: Pool,
  roomId: string,
  id: string,
): Promise<DocumentRow | null> {
  const { rows } = await pool.query<DocumentRow & { created_at: Date; removed_at: Date | null }>(
    `UPDATE room_documents SET removed_at = now()
      WHERE id = $1 AND room_id = $2 AND removed_at IS NULL
      RETURNING ${DOC_COLS}`,
    [id, roomId],
  );
  return rows[0] ? toRow(rows[0]) : null;
}
