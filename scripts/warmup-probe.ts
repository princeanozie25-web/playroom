// scripts/warmup-probe.ts — WHICH WARM-UP MECHANISM ACTUALLY REMOVES THE PENALTY.
//
// S04-N1 attributes the first-turn penalty to TLS handshake and client init, which
// suggests a completion is not needed. That is a hypothesis, and assumptions about
// latency are what produced a five-sample P95 — so it gets measured.
//
// ONE INVOCATION IS ONE COLD SAMPLE. Connection state is per-process, so a fresh process
// per sample is the only way to measure a cold first turn more than once. The caller runs
// this in a loop; each run prints one JSON line.
//
//   pnpm tsx scripts/warmup-probe.ts <adapterId> <none|warm|mini>
//
//   none  control — construct the adapter, stream immediately
//   warm  adapter.warm() first: a model-catalogue read, ZERO tokens
//   mini  a max_tokens=1 completion first: the escalation, and it costs tokens
//
// A script, not a test: it needs keys and spends money, and must NEVER run in CI or
// `pnpm verify`. Same rule as latency-control.ts.
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadRootEnv } from '../apps/api/src/env.js';
import { createAdapter, getAdapterConfig } from '../packages/adapters/src/index.js';

loadRootEnv();

const adapterId = process.argv[2] ?? 'claude-main';
const mode = process.argv[3] ?? 'none';
if (!['none', 'warm', 'mini'].includes(mode)) throw new Error(`unknown mode: ${mode}`);

// The room's real system prompt, so the measured request is the same shape a turn makes.
const sys = readFileSync(
  fileURLToPath(new URL('../prompts/room-agent.v1.md', import.meta.url)),
  'utf8',
);

async function main(): Promise<void> {
  const cfg = getAdapterConfig(adapterId);
  const tConstruct = performance.now();
  const adapter = createAdapter(adapterId);
  const constructMs = performance.now() - tConstruct;

  let warmMs = 0;
  let warmTokens = 0;
  if (mode === 'warm') {
    const t = performance.now();
    await adapter.warm?.();
    warmMs = performance.now() - t;
  } else if (mode === 'mini') {
    // The escalation: a real completion, capped at one output token. Drained fully so the
    // connection is left in the same state a finished turn leaves it.
    const t = performance.now();
    for await (const chunk of adapter.stream([{ author: 'u', body: 'hi' }], {
      maxOutputTokens: 1,
    })) {
      if (chunk.kind === 'done') warmTokens = chunk.tokens_in + chunk.tokens_out;
    }
    warmMs = performance.now() - t;
  }

  // The measurement: time to FIRST TOKEN of a turn-shaped request, after whatever
  // warming the mode did. This is the number a member waits for.
  const t0 = performance.now();
  let ttft = 0;
  let tokens = 0;
  for await (const chunk of adapter.stream(
    [{ author: 'prince', body: 'reply with one short sentence about the sky' }],
    { systemPrompt: sys, maxOutputTokens: cfg.max_output_tokens },
  )) {
    if (chunk.kind === 'text_delta' && ttft === 0) ttft = performance.now() - t0;
    if (chunk.kind === 'done') tokens = chunk.tokens_in + chunk.tokens_out;
  }

  console.log(
    JSON.stringify({
      adapter: adapterId,
      mode,
      construct_ms: Math.round(constructMs),
      warm_ms: Math.round(warmMs),
      warm_tokens: warmTokens,
      ttft_ms: Math.round(ttft),
      turn_tokens: tokens,
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
