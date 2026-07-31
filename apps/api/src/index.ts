import { loadRootEnv } from './env.js';
import { buildServer } from './server.js';
import { installProcessScrubGuards, makeScrubber, scrubError } from './scrub.js';

loadRootEnv();

// SLIVE-N3, the OTHER sink: the scrubbed pino stream covers app.log, but the boot path can throw to
// stderr WITHOUT touching it. `buildServer` runs makePool→pgConfig→new URL synchronously, and a
// malformed DATABASE_URL throws an error whose `.input` is the whole connection string — a field
// nobody named. One scrubber, snapshotted once here, guards both the process-level handlers and the
// boot/listen catches below; nothing reaches stderr unscrubbed.
const scrubber = makeScrubber();
installProcessScrubGuards(scrubber);

const port = Number(process.env.PORT ?? 3001);

try {
  // `warmOnBoot` is opt-in HERE and nowhere else: the test suite builds servers constantly,
  // and a warm-up wired into every buildServer would make real provider calls 20 files over.
  const app = buildServer({ warmOnBoot: true });

  app
    .listen({ port, host: '0.0.0.0' })
    .then((address) => {
      // A bind address (host:port), never a secret.
      console.log(`playroom-api listening on ${address}`);
    })
    .catch((err) => {
      // A listen/connect failure can carry the connection string; scrub before it reaches stderr.
      process.stderr.write(scrubError(err, scrubber) + '\n');
      process.exit(1);
    });
} catch (err) {
  // makePool→new URL runs synchronously inside buildServer; a malformed DATABASE_URL throws HERE,
  // before listen is ever reached. Scrub it rather than let it propagate raw to Node's handler.
  process.stderr.write(scrubError(err, scrubber) + '\n');
  process.exit(1);
}
