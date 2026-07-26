// An injectable provider client, used ONLY by the adapter conformance suite.
//
// WHERE THE TEST BOUNDARY SITS, and why here. An adapter's job is TRANSLATION: turn one
// provider's stream into provider-neutral AgentTurnChunks. Parsing that provider's SSE
// wire format is the vendor SDK's job. Stubbing at the HTTP layer would mean asserting
// that Anthropic's parser parses a fixture we hand-wrote — which tests the fixture.
// Stubbing the client means the adapter's real translation loop runs against
// provider-shaped events, which is the code we own and the code that can break.
//
// The stub is necessarily provider-SHAPED (each provider's event stream differs), which
// is exactly why each adapter supplies its own fixture and the suite supplies only the
// assertions. Production passes nothing; `createAdapter` has no parameter for it.
export interface StreamLike<Event, Final> {
  [Symbol.asyncIterator](): AsyncIterator<Event>;
  finalMessage(): Promise<Final>;
}

/** A stand-in for a provider client, parameterised over that provider's shapes. */
export interface ClientLike<Params, Event, Final> {
  stream(params: Params): StreamLike<Event, Final>;
}
