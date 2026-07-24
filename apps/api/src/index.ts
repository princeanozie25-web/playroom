import { loadRootEnv } from './env.js';
import { buildServer } from './server.js';

loadRootEnv();

const port = Number(process.env.PORT ?? 3001);
const app = buildServer();

app
  .listen({ port, host: '0.0.0.0' })
  .then((address) => {
    console.log(`playroom-api listening on ${address}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
