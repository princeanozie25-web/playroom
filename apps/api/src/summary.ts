import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import type { AgentAdapter, AgentMessage, ServerEvent } from '@playroom/shared';
import { costUsd, getAdapterConfig, listAdapters } from '@playroom/adapters';
import type { RoomBus } from './bus.js';
import {
  appendRoomSummary,
  countMessagesAfter,
  latestRoomSummary,
  messageBatchAfter,
} from './events.js';
import { spendToday } from './spend.js';
import type { CommandLogger } from './commands/context.js';

/**
 * THE ROLLING SUMMARY — Bible §15's "fold oldest span into rolling summary", and S1.6.
 *
 * ── WHAT PROBLEM THIS ACTUALLY SOLVES ──
 *
 * Not cost. Assembly already caps common ground at the recent window, so a summon's tokens were
 * already flat as a room grew — MEASURED at ~1.2k for a 50-, 100- or 200-message room (S16-3). What
 * that cap did instead was DROP everything older: an agent summoned into a long room saw the last
 * few dozen messages and nothing before them. This restores the older span as a compressed,
 * attributed common-ground summary, so the room stays coherent over a long session while the window
 * stays bounded. It costs a little more per summon (the summary's own tokens) plus the occasional
 * summariser call — a coherence gain, not a saving, and the accounting says so (S16-3's report).
 *
 * ── MAINTAINED AHEAD OF THE SUMMON, NEVER DURING IT ──
 *
 * This runs off the MESSAGE path (postMessage dispatches it, fire-and-forget), not the summon path.
 * A summariser call is a model call and a slow one; on the summon path it would land on the first
 * token a member waits for and blow §7's budget (ADR-008). Assembly only READS the latest summary —
 * one indexed row — so the summon pays a query, not a completion. See agent.ts / assembly.ts.
 *
 * ── COMMON GROUND ONLY (law #3) ──
 *
 * It compresses `message` events and nothing else. There is no path from here to a principal store:
 * `messageBatchAfter` reads the room's own log, `withPrincipalStore` is never called, and the
 * summary lands as a `common-ground` part (principal_id null) in assembly. The §7.1 isolation test
 * is extended in summary.test.ts to plant a foreign store and prove none of it can reach the
 * summariser's input — RA-006's rule, that a new path gets its own coverage.
 */

// ── CONFIG (S1.6 item 6: the recent window is a fixed count, made config) ──
//
// WINDOW is how many messages every window keeps verbatim; BATCH is the slack that decides when a
// fold is worth a model call. A fold triggers when the un-summarised tail exceeds WINDOW + BATCH,
// and folds it back down to WINDOW — so the tail oscillates in [WINDOW, WINDOW + BATCH] and the
// summary is re-derived, not merely appended, keeping it flat (S16-3 item 16).
export const RECENT_WINDOW_MESSAGES = 24;
export const SUMMARY_TRIGGER_BATCH = 12;
// The bound that keeps the summary itself flat as the room grows: the summariser cannot emit more
// than this, so a 1000-message room's summary is the same size as a 50-message room's.
export const SUMMARY_MAX_OUTPUT_TOKENS = 320;
// Bound the summariser's INPUT on a burst or a first-time backfill of a long room: fold at most this
// many messages per run, and let the next message's maintenance catch the rest up. Without it, a
// room that reached 500 messages before its first fold would hand the summariser 476 messages at once.
const MAX_FOLD_PER_RUN = 40;

/** The author a summary carries as a common-ground part — not a member, not addressable. */
export const ROOM_SUMMARY_AUTHOR = 'context/room-summary';
/** How the previous summary is labelled when handed back to the summariser to extend. */
const EARLIER_SUMMARY_AUTHOR = 'earlier-summary';

// The summariser prompt and its SHA-256, read once from prompts/room-summary.v1.md — versioned and
// hash-logged like the room agent's prompt (§18.1), so a summary's reason is a diff, not archaeology.
let promptCache: { text: string; hash: string } | undefined;
export function summaryPrompt(): { text: string; hash: string } {
  if (!promptCache) {
    const path = fileURLToPath(new URL('../../../prompts/room-summary.v1.md', import.meta.url));
    const text = readFileSync(path, 'utf8');
    promptCache = { text, hash: createHash('sha256').update(text).digest('hex') };
  }
  return promptCache;
}

/**
 * Which adapter summarises: the first ENABLED adapter (adapters.yaml order).
 *
 * Not a hardcoded id — that was S0.5b's mistake, a member named in app code. The summary is a system
 * function, not a member's turn, and any capable adapter serves it; reading the registry keeps the
 * choice provider-neutral (§6) and lets adapters.yaml decide. Undefined when nothing is enabled, in
 * which case a room simply keeps dropping its oldest messages, as it did before this existed.
 */
export function summaryAdapterId(): string | undefined {
  return listAdapters()[0]?.id;
}

// One maintenance run per room per process. A restart forgets this (S05a-N1's shape), which is why
// migration 019's unique index is the DURABLE half: two instances cannot both fold to the same seq.
const summarising = new Set<string>();

export interface SummaryDeps {
  pool: Pool;
  bus: RoomBus;
  adapterFactory: (id: string) => AgentAdapter;
  log: CommandLogger;
}

/**
 * Fold the oldest un-summarised messages into the rolling summary, if the tail has grown past the
 * window. Idempotent, cheap when there is nothing to do (two indexed reads and an early return), and
 * NEVER FATAL — a failure logs and leaves the previous summary in place, so the window falls back to
 * the recent messages, which is coherent enough. Returns the new summary event, or null when no fold
 * happened (below threshold, ceiling reached, lost the race, or an error).
 */
export async function maintainRoomSummary(
  deps: SummaryDeps,
  roomId: string,
): Promise<ServerEvent | null> {
  if (summarising.has(roomId)) return null;
  summarising.add(roomId);
  try {
    const prev = await latestRoomSummary(deps.pool, roomId);
    const floor = prev?.covers_through_seq ?? 0;
    const tail = await countMessagesAfter(deps.pool, roomId, floor);
    if (tail <= RECENT_WINDOW_MESSAGES + SUMMARY_TRIGGER_BATCH) return null;

    // A summariser call spends money on a real key, so it answers to the same ceiling a turn does
    // (S-LIVE). When the ceiling is reached no turns run anyway, so nothing needs the summary until
    // it resets — skipping is both the honest cap and the harmless one.
    const spend = await spendToday(deps.pool);
    if (spend.exceeded) {
      deps.log.warn(
        { room_id: roomId, spent_usd: spend.spent_usd, ceiling_usd: spend.ceiling_usd },
        'room summary skipped: daily spend ceiling reached',
      );
      return null;
    }

    const adapterId = summaryAdapterId();
    if (!adapterId) return null;

    const foldCount = Math.min(tail - RECENT_WINDOW_MESSAGES, MAX_FOLD_PER_RUN);
    const batch = await messageBatchAfter(deps.pool, roomId, floor, foldCount);
    if (batch.length === 0) return null; // a concurrent run already advanced the floor
    const newCoversSeq = batch[batch.length - 1].seq;

    // The summariser input: the earlier summary (to extend, not replace) followed by the batch,
    // EACH CARRYING ITS AUTHOR. The adapter renders a message as `author: body`, so attribution
    // reaches the model and the summary can keep who-said-what (item 10) rather than inventing a
    // single voice.
    const input: AgentMessage[] = [];
    if (prev) input.push({ author: EARLIER_SUMMARY_AUTHOR, body: prev.text });
    for (const m of batch) input.push({ author: m.author, body: m.body });

    const { text: sys, hash: promptHash } = summaryPrompt();
    const cfg = getAdapterConfig(adapterId);
    const adapter = deps.adapterFactory(adapterId);

    let text = '';
    let tokensIn: number | null = null;
    let tokensOut: number | null = null;
    for await (const chunk of adapter.stream(input, {
      systemPrompt: sys,
      maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
    })) {
      if (chunk.kind === 'text_delta') text += chunk.text;
      else if (chunk.kind === 'done') {
        tokensIn = chunk.tokens_in;
        tokensOut = chunk.tokens_out;
      } else throw new Error(`${chunk.error_class}: ${chunk.message}`);
    }
    text = text.trim();
    // An empty summary is worse than none — it would replace real coverage with a blank. Keep the
    // previous one and try again on the next message.
    if (text === '') {
      deps.log.warn({ room_id: roomId }, 'room summary skipped: summariser returned nothing');
      return null;
    }

    const cost =
      tokensIn != null && tokensOut != null
        ? Number(costUsd(cfg, tokensIn, tokensOut).toFixed(5))
        : null;
    const event = await appendRoomSummary(deps.pool, roomId, {
      summary_id: `sum_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      covers_through_seq: newCoversSeq,
      covers_message_count: (prev?.covers_message_count ?? 0) + batch.length,
      text,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: cost,
      prompt_hash: promptHash,
    });
    // Null means migration 019 refused it — another run folded to this exact seq first. Not an
    // error, and NOT re-published: a second summary row for one coverage point is the drift the
    // index exists to prevent.
    if (!event) {
      deps.log.info(
        { room_id: roomId, covers_through_seq: newCoversSeq },
        'room summary already folded to this point',
      );
      return null;
    }
    deps.bus.publish(roomId, event);
    deps.log.info(
      {
        room_id: roomId,
        covers_through_seq: newCoversSeq,
        folded: batch.length,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cost_usd: cost,
      },
      'room summary folded',
    );
    return event;
  } catch (err) {
    // NEVER FATAL. The summary is an optimisation over dropping; a failed fold leaves the previous
    // summary and the recent window, which is what the room ran on before this existed.
    deps.log.error({ err, room_id: roomId }, 'room summary maintenance failed');
    return null;
  } finally {
    summarising.delete(roomId);
  }
}
