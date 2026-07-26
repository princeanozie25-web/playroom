import { loadRootEnv } from './env.js';
import { buildServer } from './server.js';

loadRootEnv();

const port = Number(process.env.PORT ?? 3001);
// `warmOnBoot` is opt-in HERE and nowhere else: the test suite builds servers constantly,
// and a warm-up wired into every buildServer would make real provider calls 20 files over.
const app = buildServer({ warmOnBoot: true });

app
  .listen({ port, host: '0.0.0.0' })
  .then((address) => {
    console.log(`playroom-api listening on ${address}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
