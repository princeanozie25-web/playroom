// Boot the api's real entry graph the way the CONTAINER does — Node's ESM loader via tsx, not
// vitest's transform. S-PUSH's first deploy crash-looped on a CommonJS package imported by name:
// vitest synthesised the named exports and Node did not, so a green suite shipped a broken boot.
import '../apps/api/src/push-send.js';
import '../apps/api/src/interrupts.js';
import '../apps/api/src/server.js';

console.log('ESM BOOT CHECK: the api module graph loads under Node’s own loader');
