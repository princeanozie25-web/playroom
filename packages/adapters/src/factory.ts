import type { AgentAdapter } from '@playroom/shared';
import { getAdapterConfig } from './registry.js';
import { AnthropicAdapter } from './anthropic/index.js';
import { OpenAIAdapter } from './openai/index.js';

// Construct a provider adapter by id — the ONLY place a provider is selected.
// Room and API code call this by id and receive a provider-neutral AgentAdapter.
export function createAdapter(id: string): AgentAdapter {
  const cfg = getAdapterConfig(id);
  if (!cfg.enabled) throw new Error(`adapter "${id}" is disabled`);
  switch (cfg.provider) {
    case 'anthropic':
      return new AnthropicAdapter(cfg);
    case 'openai':
      return new OpenAIAdapter(cfg);
    default:
      throw new Error(`no adapter implementation for provider "${cfg.provider}"`);
  }
}
