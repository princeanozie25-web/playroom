import { Pool, type PoolConfig } from 'pg';

// Build a pg pool config from a connection URL. Hosted Postgres (Neon) requires
// TLS; local/CI Postgres does not offer it. We strip libpq-only query params
// (sslmode, channel_binding) that node-postgres ignores and decide TLS by host.
export function pgConfig(databaseUrl: string): PoolConfig {
  const u = new URL(databaseUrl);
  const host = u.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  u.search = '';
  return {
    connectionString: u.toString(),
    connectionTimeoutMillis: 20000,
    ...(isLocal ? {} : { ssl: { rejectUnauthorized: false } }),
  };
}

export function makePool(databaseUrl: string): Pool {
  return new Pool(pgConfig(databaseUrl));
}
