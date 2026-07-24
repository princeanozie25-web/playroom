import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';

// One adapter's config from adapters.yaml. `provider` is named here — this package
// is the §6-exempt boundary; nothing outside packages/adapters/ reads it.
export const AdapterConfig = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  enabled: z.boolean(),
  max_output_tokens: z.number().int().positive(),
  cost_per_1k_in: z.number().nonnegative(),
  cost_per_1k_out: z.number().nonnegative(),
});
export type AdapterConfig = z.infer<typeof AdapterConfig>;

const RegistryFile = z.object({ adapters: z.array(AdapterConfig) });

// adapters.yaml lives at the repo root (resolved relative to this source file).
function defaultYamlPath(): string {
  return fileURLToPath(new URL('../../../adapters.yaml', import.meta.url));
}

export function loadRegistry(yamlPath: string = defaultYamlPath()): Map<string, AdapterConfig> {
  const parsed = RegistryFile.parse(parse(readFileSync(yamlPath, 'utf8')));
  return new Map(parsed.adapters.map((a) => [a.id, a]));
}

let cache: Map<string, AdapterConfig> | undefined;

export function getAdapterConfig(id: string): AdapterConfig {
  cache ??= loadRegistry();
  const cfg = cache.get(id);
  if (!cfg) throw new Error(`unknown adapter id: ${id}`);
  return cfg;
}

// Cost of a turn in USD, from the adapter's per-1k prices (§16/§17).
export function costUsd(cfg: AdapterConfig, tokensIn: number, tokensOut: number): number {
  return (tokensIn / 1000) * cfg.cost_per_1k_in + (tokensOut / 1000) * cfg.cost_per_1k_out;
}
