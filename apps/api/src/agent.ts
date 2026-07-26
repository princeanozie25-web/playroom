import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import type { AgentAdapter, AgentMessage, ServerEvent } from '@playroom/shared';
import { costUsd, getAdapterConfig, listAdapters } from '@playroom/adapters';
import type { RoomBus } from './bus.js';
import { appendAgentEvent, appendMessage, recentMessages } from './events.js';

const CONTEXT_MESSAGES = 30; // PM7 hard cap — last 30 room messages, nothing more

// The system prompt and its SHA-256, read once from prompts/room-agent.v1.md.
let promptCache: { text: string; hash: string } | undefined;
function systemPrompt(): { text: string; hash: string } {
  if (!promptCache) {
    const path = fileURLToPath(new URL('../../../prompts/room-agent.v1.md', import.meta.url));
    const text = readFileSync(path, 'utf8');
    promptCache = { text, hash: createHash('sha256').update(text).digest('hex') };
  }
  return promptCache;
}

// An actor is an agent iff its id is a known adapter id. Their messages never
// summon — that is the structural bar against agent-to-agent loops (§22a).
function isAgentActor(actorId: string): boolean {
  try {
    getAdapterConfig(actorId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Summon tokens, derived FROM THE ROSTER — never hardcoded.
 *
 * This file used to contain a hardcoded summon prefix and a literal member id, which
 * meant enabling a second member required editing app code. That
 * is the §6 anti-lock-in rule failing in the one place it is easiest to miss: the
 * interface was clean, the adapter boundary was clean, and the SELECTOR was hardcoded.
 * Bible §21.2's binary exit — "same prompt routes through either member via roster
 * config, no app-code change" — is only true because of this function.
 *
 * A member is addressable by `@<display_name>` or `@<id>`, lowercased. Built once per
 * process, same lifetime as the registry cache.
 */
let summonTokens: Map<string, string> | undefined;
function tokenTable(): Map<string, string> {
  if (!summonTokens) {
    summonTokens = new Map();
    for (const a of listAdapters()) {
      summonTokens.set(`@${a.display_name.toLowerCase()}`, a.id);
      summonTokens.set(`@${a.id.toLowerCase()}`, a.id);
    }
  }
  return summonTokens;
}

// Crude, temporary summon rule (§22): a human message whose FIRST WORD is `@<member>`
// summons that member. S0.5 replaces this with the real summon rule.
//
// Matching is on the first whitespace-delimited word, longest token first, so `@sol`
// cannot be shadowed by a member whose name is a prefix of another's.
export function summonedAdapterId(event: ServerEvent): string | null {
  if (event.event_type !== 'message') return null;
  if (event.actor_id === 'system') return null;
  if (isAgentActor(event.actor_id)) return null; // never agent-to-agent (§22a)
  const first = event.payload.body.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';
  if (!first.startsWith('@')) return null;
  // Strip trailing punctuation so "@sol," addresses Sol.
  const bare = first.replace(/[^a-z0-9@_-]+$/, '');
  return tokenTable().get(bare) ?? null;
}

// One in-flight agent turn per room (§22b).
const inFlight = new Set<string>();

// End time of the previous turn in THIS process — lets each turn record the gap
// since the last one, so cold-start/autosuspend effects are visible (S0.3c).
let lastTurnEndedAt: number | undefined;

export interface AgentTurnDeps {
  pool: Pool;
  bus: RoomBus;
  roomId: string;
  adapterId: string;
  adapterFactory: (id: string) => AgentAdapter;
  spans?: { t0: number; t1: number }; // S0.3c: command-entry + message-committed boundaries
}

// Run an agent turn as a sequence of persisted events: started → deltas →
// completed. Persist-before-fanout holds for every one (ADR-003). A failure is
// written as completed{success:false} with an error_class — never a silent hang.
export async function runAgentTurn(deps: AgentTurnDeps): Promise<void> {
  const { pool, bus, roomId, adapterId, adapterFactory, spans } = deps;
  const publish = (ev: ServerEvent): void => bus.publish(roomId, ev);

  // §22b: reject a second concurrent turn with an in-thread notice.
  if (inFlight.has(roomId)) {
    publish(
      await appendMessage(
        pool,
        roomId,
        'system',
        `sys-${randomUUID()}`,
        `${adapterId} is already replying in this room.`,
      ),
    );
    return;
  }
  inFlight.add(roomId);

  // S0.3c latency spans — performance.now() at boundaries only; no write is moved.
  const enteredAt = performance.now();
  const msSincePrev =
    lastTurnEndedAt !== undefined ? Math.round(enteredAt - lastTurnEndedAt) : null;
  const t0 = spans?.t0 ?? enteredAt; // executeCommand entry
  const t1 = spans?.t1 ?? enteredAt; // triggering message committed
  let tStreamInvoked: number | null = null;
  let tFirstChunk: number | null = null;
  let tFirstDeltaCommitted: number | null = null;
  let tFirstFanout: number | null = null;
  const span = (a: number | null, b: number | null): number | null =>
    a != null && b != null ? Math.round(a - b) : null;

  const { text: sys, hash: promptHash } = systemPrompt();
  const cfg = getAdapterConfig(adapterId);
  const turnId = randomUUID();
  const startedAt = Date.now();
  let assembled = '';
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;

  try {
    publish(
      await appendAgentEvent(pool, roomId, adapterId, 'agent.turn.started', {
        turn_id: turnId,
        adapter_id: adapterId,
      }),
    );

    const messages: AgentMessage[] = await recentMessages(pool, roomId, CONTEXT_MESSAGES);
    const adapter = adapterFactory(adapterId); // may throw (e.g. missing key) → caught below

    tStreamInvoked = performance.now(); // span boundary: stream() about to be invoked
    for await (const chunk of adapter.stream(messages, {
      systemPrompt: sys,
      maxOutputTokens: cfg.max_output_tokens,
    })) {
      if (chunk.kind === 'text_delta') {
        if (tFirstChunk === null) tFirstChunk = performance.now(); // span: first chunk from the SDK
        assembled += chunk.text;
        // Same persist-before-fanout sequence, only split to time it (S0.3c).
        const delta = await appendAgentEvent(pool, roomId, adapterId, 'agent.turn.delta', {
          turn_id: turnId,
          text: chunk.text,
        });
        if (tFirstDeltaCommitted === null) tFirstDeltaCommitted = performance.now(); // span: first delta committed
        publish(delta);
        if (tFirstFanout === null) tFirstFanout = performance.now(); // span: first delta frame written
      } else if (chunk.kind === 'done') {
        tokensIn = chunk.tokens_in;
        tokensOut = chunk.tokens_out;
      } else {
        throw new Error(`${chunk.error_class}: ${chunk.message}`);
      }
    }

    const timings: Record<string, number | null> = {
      t_command: span(t1, t0),
      t_assemble: span(tStreamInvoked, t1),
      t_provider_ttft: span(tFirstChunk, tStreamInvoked),
      t_persist_first: span(tFirstDeltaCommitted, tFirstChunk),
      t_fanout: span(tFirstFanout, tFirstDeltaCommitted),
      ttfd_total: span(tFirstFanout, t0),
      ms_since_prev_turn_in_process: msSincePrev,
    };
    const cost =
      tokensIn != null && tokensOut != null
        ? Number(costUsd(cfg, tokensIn, tokensOut).toFixed(5))
        : null;
    const latencyMs = Date.now() - startedAt;
    console.log(
      `[agent] turn=${turnId} room=${roomId} adapter=${adapterId} in=${tokensIn} out=${tokensOut} cost=$${cost} latency=${latencyMs}ms ttft=${timings.t_provider_ttft}ms ttfd=${timings.ttfd_total}ms`,
    );

    publish(
      await appendAgentEvent(
        pool,
        roomId,
        adapterId,
        'agent.turn.completed',
        {
          turn_id: turnId,
          adapter_id: adapterId,
          text: assembled,
          success: true,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          cost_usd: cost,
          error_class: null,
        },
        {
          adapter_id: adapterId,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          cost_usd: cost,
          latency_ms: latencyMs,
          prompt_hash: promptHash,
          success: true,
          error_class: null,
          timings,
        },
      ),
    );
  } catch (err) {
    const errorClass = err instanceof Error ? err.name : 'Error';
    const latencyMs = Date.now() - startedAt;
    publish(
      await appendAgentEvent(
        pool,
        roomId,
        adapterId,
        'agent.turn.completed',
        {
          turn_id: turnId,
          adapter_id: adapterId,
          text: assembled || `(${adapterId} could not respond)`,
          success: false,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          cost_usd: null,
          error_class: errorClass,
        },
        {
          adapter_id: adapterId,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          cost_usd: null,
          latency_ms: latencyMs,
          prompt_hash: promptHash,
          success: false,
          error_class: errorClass,
          timings: null,
        },
      ),
    );
  } finally {
    lastTurnEndedAt = performance.now();
    inFlight.delete(roomId);
  }
}
