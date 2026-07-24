import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Load the repo-root .env into process.env for local dev and tests. No-op when it
// is absent (production and CI provide real environment variables instead).
export function loadRootEnv(): void {
  const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
}
