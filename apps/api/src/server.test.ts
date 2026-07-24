import { describe, it, expect } from 'vitest';
import { buildServer } from './server.js';

describe('GET /health', () => {
  it('returns the health payload', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      service: 'playroom-api',
      version: '0.0.1',
    });

    await app.close();
  });
});
