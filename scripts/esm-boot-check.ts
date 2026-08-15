// scripts/esm-boot-check.ts — DOES THE API ACTUALLY LOAD? Part of `pnpm verify` (S-DIAL, SPUSH-N1).
//
// Boot the api's real entry graph the way the CONTAINER does — Node's ESM loader via tsx, not
// vitest's transform. S-PUSH's first deploy crash-looped on a CommonJS package imported by name:
// vitest synthesised the named exports and Node did not, so 84 green test files shipped a boot that
// could not happen, and production was 502 until it was rolled forward.
//
// IT RUNS BEFORE THE TESTS, not after, because it is the cheapest possible check and the one whose
// failure invalidates every result that would follow it. A suite that passes against a module graph
// Node cannot instantiate is not evidence of anything.
//
// IT IMPORTS RATHER THAN LISTENS. Nothing here binds a port, connects a pool or reads a secret —
// module instantiation is the whole test, because that is exactly where the failure was.
import '../apps/api/src/push-send.js';
import '../apps/api/src/interrupts.js';
import '../apps/api/src/server.js';

console.log('ESM BOOT CHECK: the api module graph loads under Node’s own loader');
