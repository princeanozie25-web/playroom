# The Playroom web tier, for Fly.
#
# ── THE BUILD-TIME URL IS THE WHOLE DIFFICULTY ─────────────────────────────────────────
#
# `NEXT_PUBLIC_API_URL` is read in `Room.tsx`, which runs in the BROWSER, so Next inlines its value
# into the client bundle at BUILD time. It is what `socketUrl` turns into `wss://…` — meaning the
# api's public hostname has to be known before this image is built, not when it starts.
#
# That is a genuine chicken-and-egg on a first deploy, and it is why the api goes up first: its
# hostname is deterministic once its app exists (`playroom-api.fly.dev`), so it is passed in here as
# a build argument. Setting it as a runtime secret would compile in `http://localhost:3001` and the
# socket would try to reach the tester's own phone.
#
# The BFF routes (`/api/ws-ticket`, `/api/join`, `/api/rooms`) read the same variable on the SERVER,
# where a runtime value would work — but they must agree with the client, so both come from here.

FROM node:22-slim AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/fabric/package.json packages/fabric/
COPY packages/adapters/package.json packages/adapters/

# Full install: the build needs devDependencies (next, typescript, the transpiled workspace packages).
RUN pnpm install --frozen-lockfile

COPY . .

# The api's public origin, baked in. Declared as an ARG so it is visible in the build command rather
# than hidden in a file — a wrong value here produces a room that loads and never connects, which is
# the most confusing failure this deployment has available.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NODE_ENV=production

# `next.config` sends production output to `.next-prod` (SUI-N1: dev and prod sharing `.next`
# destroyed each other's builds). The runtime stage below has to look in the same place.
RUN pnpm --filter @playroom/web build

# ── RUNTIME ────────────────────────────────────────────────────────────────────────────
#
# The whole build is carried over rather than a standalone bundle. `output: 'standalone'` is not set
# in next.config, and turning it on as part of a deploy would change how the app is assembled on the
# same day it first faces strangers. Bigger image, identical artifact to the one `pnpm verify` built.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends dumb-init \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable

COPY --from=build /app /app

ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# `apps/web`'s start script pins `-p 3000`; Fly's internal_port matches it in web.fly.toml rather
# than the script being rewritten, so local and deployed run the identical command.
EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["pnpm", "--filter", "@playroom/web", "start"]
