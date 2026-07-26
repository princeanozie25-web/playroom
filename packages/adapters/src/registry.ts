import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';

// One adapter's config from adapters.yaml. `provider` is named here — this package
// is the §6-exempt boundary; nothing outside packages/adapters/ reads it.
export const AdapterConfig = z
  .object({
    id: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    enabled: z.boolean(),
    max_output_tokens: z.number().int().positive(),
    cost_per_1k_in: z.number().nonnegative(),
    cost_per_1k_out: z.number().nonnegative(),
    // NO ROSTER FIELDS. `display_name` and `principal` lived here until S1.1a; they are
    // member records now (migration 007). `.strict()` below means a leftover copy in a
    // deployed adapters.yaml is a loud boot failure rather than a second, drifting source
    // of a member's name — which is the failure this move exists to end.
  })
  .strict(); // was z.object(): unknown keys were STRIPPED, so `cost_per_1k_ni: 0.001`
// parsed clean and priced the adapter at zero. A typo in an authority-or-money field
// becoming a silent default is the A4-F1 shape; .strict() makes it a loud boot failure.
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

/**
 * Every ENABLED adapter, in file order.
 *
 * This is what makes the §6 seam real rather than claimed: the summon rule builds its
 * token table from this list, so a second member becomes reachable by editing
 * adapters.yaml alone. Nothing outside this package needs to know a provider exists.
 */
export function listAdapters(): AdapterConfig[] {
  cache ??= loadRegistry();
  return [...cache.values()].filter((a) => a.enabled);
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
