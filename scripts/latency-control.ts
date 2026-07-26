// scripts/latency-control.ts — the S0.3c CONTROL. Measures raw provider
// time-to-first-token by calling the provider through the AnthropicAdapter's thin
// SDK wrapper directly — NO room path (no DB, no events, no command layer). The
// only overhead over the bare SDK is a sub-millisecond transcript join. It isolates
// the provider baseline from Playroom overhead, so t_provider_ttft can be compared
// against it. A script, not a test: it needs a key and costs money, and it must
// NEVER run in CI or `pnpm verify`. Usage: pnpm exec tsx scripts/latency-control.ts [n]
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadRootEnv } from '../apps/api/src/env.js';
import { createAdapter, getAdapterConfig } from '../packages/adapters/src/index.js';

loadRootEnv();

// S0.5c: the control takes an ADAPTER ID, so ADR-008 can compare each member against its
// own provider baseline. It used to construct one adapter implementation by name, which
// made "the control" mean "the control for the first member" without saying so.
//   pnpm exec tsx scripts/latency-control.ts [n] [adapterId]
const N = Number(process.argv[2] ?? 50);
const adapterId = process.argv[3] ?? 'claude-main';
const cfg = getAdapterConfig(adapterId);
// Same system prompt as the room, for an equivalent request.
const sys = readFileSync(
  fileURLToPath(new URL('../prompts/room-agent.v1.md', import.meta.url)),
  'utf8',
);
const topics = ['the sky', 'coffee', 'the ocean', 'music', 'mountains'];

async function ttft(topic: string): Promise<number> {
  const adapter = createAdapter(adapterId);
  const t0 = performance.now();
  for await (const chunk of adapter.stream(
    [{ author: 'user', body: `reply with one short sentence about ${topic}` }],
    { systemPrompt: sys, maxOutputTokens: cfg.max_output_tokens },
  )) {
    if (chunk.kind === 'text_delta') return performance.now() - t0;
  }
  return performance.now() - t0;
}

async function main(): Promise<void> {
  const samples: number[] = [];
  for (let i = 0; i < N; i++) {
    samples.push(Math.round(await ttft(topics[i % topics.length])));
    await new Promise((r) => setTimeout(r, 300));
  }
  samples.sort((a, b) => a - b);
  const pct = (p: number) =>
    samples[Math.min(samples.length - 1, Math.ceil((p / 100) * samples.length) - 1)];
  console.log(
    `control provider TTFT ${adapterId} (n=${samples.length}): min=${samples[0]} p50=${pct(50)} p90=${pct(90)} p95=${pct(95)} max=${samples[samples.length - 1]}`,
  );
  console.log('samples=' + samples.join(','));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
