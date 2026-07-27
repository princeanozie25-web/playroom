# The Playroom api, for Fly.
#
# ── WHY THE WHOLE WORKSPACE IS COPIED ──────────────────────────────────────────────────
#
# The api is not a self-contained bundle and deliberately so. Three things it reads at runtime live
# OUTSIDE `apps/api`, resolved relative to its own source files:
#
#   prompts/room-agent.v1.md   read once and HASHED — `prompt_hash` on every turn is the hash of
#                              this file, and the film's claim rests on it being the real one
#   mandates/*.json            loaded at boot; each member's mandate hash is the hash of its file
#   adapters.yaml              the only file in the repository that names a provider (§6)
#
# A bundler would inline or drop them and the hashes would stop meaning anything. So the image keeps
# the repository's shape, and `import.meta.url`-relative reads resolve exactly as they do locally.
#
# ── AND WHY IT RUNS UNDER tsx RATHER THAN A BUILD ──────────────────────────────────────
#
# There is no `build` script for the api and never has been: `pnpm dev` is `tsx watch src/index.ts`,
# and `pnpm typecheck` is what proves the types. Inventing a bundling step here, on a deploy with a
# deadline, would mean the deployed artifact is built by a path nothing has ever exercised. Running
# the same entrypoint the tests and the film run is the conservative choice; the cost is tsx in the
# image and a slightly slower boot, paid once.

FROM node:22-slim

# `dumb-init`: Fastify's SIGTERM handling wants a real init to reap it, and a container whose PID 1
# ignores signals takes the full grace period to stop on every deploy.
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# pnpm via corepack, pinned by the repo's `packageManager` field.
RUN corepack enable

# Manifests first, so a dependency install is cached across code-only deploys.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/fabric/package.json packages/fabric/
COPY packages/adapters/package.json packages/adapters/

# The api's own dependencies plus the workspace packages it imports. NOT `--prod`: `tsx` is a root
# devDependency and it is the entrypoint, so pruning it would remove the thing that starts.
RUN pnpm install --frozen-lockfile --filter @playroom/api... --filter .

# The source, the prompts, the mandates and the adapter registry.
COPY . .

# Fastify already reads `process.env.PORT ?? 3001` and binds 0.0.0.0 (apps/api/src/index.ts), so
# nothing about the server changed to be deployable.
ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["dumb-init", "--"]
CMD ["pnpm", "--filter", "@playroom/api", "exec", "tsx", "src/index.ts"]
