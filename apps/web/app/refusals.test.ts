import { describe, expect, it } from 'vitest';
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
import { isCommandRefusal } from './refusals';

/**
 * The classifier that keeps a live room alive. A pure function, unit-tested here because the room's
 * error handler that consumes it is JSX that this repo's vitest config cannot render — but the
 * DECISION it makes (fatal vs. non-fatal) is the load-bearing part and lives in a function that can
 * be tested directly.
 */
describe('isCommandRefusal — the room survives a command refusal, and closes on a connection one', () => {
  it('every document and briefing refusal is a COMMAND refusal (non-fatal; the room stays open)', () => {
    for (const code of [
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
    ]) {
      expect(
        isCommandRefusal(code),
        `${code} should be non-fatal — a refused action, not a dead room`,
      ).toBe(true);
    }
  });

  it('connection and handshake refusals are NOT command refusals — they close the room, as before', () => {
    // The wire codes a bad handshake carries (from the ws-refused log lines). Classifying one of these
    // as a command refusal would make the room reconnect-loop on a room that does not exist.
    for (const code of [
      'room_not_found',
      'ticket_invalid',
      'ticket_required',
      'frame_unrecognised',
    ]) {
      expect(isCommandRefusal(code), `${code} must stay fatal`).toBe(false);
    }
  });
});
