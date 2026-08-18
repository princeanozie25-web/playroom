import {
  ERROR_BRIEFING_ABSENT,
  ERROR_BRIEFING_MALFORMED,
  ERROR_BRIEFING_NOT_HUMAN,
  ERROR_BRIEFING_NOT_OWNER,
  ERROR_BRIEFING_NO_ROOM_OWNER,
  ERROR_BRIEFING_TOO_LARGE,
  ERROR_DOCUMENT_MALFORMED,
  ERROR_DOCUMENT_NOT_HUMAN,
  ERROR_DOCUMENT_NOT_TEXT,
  ERROR_DOCUMENT_ROOM_FULL,
  ERROR_DOCUMENT_TOO_LARGE,
  ERROR_DOCUMENT_UNKNOWN,
} from '@playroom/shared';

/**
 * IS THIS ERROR FRAME A COMMAND REFUSAL, and not a connection one?
 *
 * The room's socket error handler treats a refusal as FATAL — it stops reconnecting and declares the
 * room dead ("nothing you type here will be delivered"). That is right for a HANDSHAKE refusal
 * (room-not-found, a bad ticket): the server has closed the socket and retrying would loop. It is
 * WRONG for an in-session COMMAND refusal — an over-cap document, a not-owner briefing — which leaves
 * the socket open and the room perfectly alive; only the action failed. Killing a live room over one
 * is the A4-F1 shape in reverse: a working room reported broken.
 *
 * These are the refusals the room's OWN controls can provoke — S-UPLOAD's document frames and S1.7's
 * briefing frames (RoomTools). Named explicitly rather than matched by prefix, so a new family that
 * should be non-fatal is a deliberate addition here, not a silent reclassification. Everything else —
 * every handshake and connection refusal — stays fatal, exactly as before.
 */
const COMMAND_REFUSALS: ReadonlySet<string> = new Set([
  ERROR_DOCUMENT_NOT_HUMAN,
  ERROR_DOCUMENT_NOT_TEXT,
  ERROR_DOCUMENT_TOO_LARGE,
  ERROR_DOCUMENT_ROOM_FULL,
  ERROR_DOCUMENT_MALFORMED,
  ERROR_DOCUMENT_UNKNOWN,
  ERROR_BRIEFING_NOT_HUMAN,
  ERROR_BRIEFING_NOT_OWNER,
  ERROR_BRIEFING_NO_ROOM_OWNER,
  ERROR_BRIEFING_MALFORMED,
  ERROR_BRIEFING_TOO_LARGE,
  ERROR_BRIEFING_ABSENT,
]);

/** True when a refusal is an in-session command refusal (non-fatal); false for a connection refusal. */
export function isCommandRefusal(code: string): boolean {
  return COMMAND_REFUSALS.has(code);
}
