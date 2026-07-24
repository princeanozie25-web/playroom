import Fastify, { type FastifyInstance } from 'fastify';
import { PLAYROOM_VERSION } from '@playroom/shared';

// buildServer() returns a fresh, un-listening instance so tests can drive it
// with .inject() and no network. src/index.ts is the only place it binds a port.
export function buildServer(): FastifyInstance {
  const app = Fastify();

  app.get('/health', async () => ({
    ok: true,
    service: 'playroom-api',
    version: PLAYROOM_VERSION,
  }));

  return app;
}
