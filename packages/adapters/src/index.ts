// @playroom/adapters — the only package that names providers (roadmap §6).
// The adapter registry (config from adapters.yaml) + the provider adapter factory.
export * from './registry.js';
export * from './factory.js';
export type { ClientLike, StreamLike } from './transport.js';

// Adapter IMPLEMENTATIONS are exported for the conformance suite, which must construct
// each one directly with a stub transport. Production code never names an implementation:
// it calls createAdapter(id) and receives a provider-neutral AgentAdapter.
export * from './anthropic/index.js';
export * from './openai/index.js';

// The deterministic, credential-free adapter (ADR-022) — the offline analogue used to run and demonstrate a
// multi-model governed room without a real provider or a key. Not selected by createAdapter (that names real
// providers); constructed directly, or injected as an adapterFactory via mockAdapterFactory.
export * from './mock/index.js';
