# =============================================================================
# API image (Session 13, D6). Build from the repo root:
#   docker build -f apps/api/Dockerfile --build-arg GIT_SHA=$(git rev-parse HEAD) .
#
# Base: node:22-bookworm-slim, pinned by digest. glibc (not Alpine/musl)
# because sharp's prebuilt libvips and Prisma's query/schema engines ship as
# glibc binaries; slim keeps the OS layer small.
# =============================================================================
ARG NODE_IMAGE=node:22.23.3-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

# ── build: install, bundle, prune ────────────────────────────────────────────
FROM ${NODE_IMAGE} AS build
# pnpm comes from Corepack at exactly the version in package.json#packageManager.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
# Prisma's engines check OpenSSL at generate time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /repo

# Manifests first, so the dependency layer is cached until the lockfile moves.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY apps/api/scripts/postinstall.mjs apps/api/scripts/
COPY apps/api/prisma apps/api/prisma
RUN pnpm install --frozen-lockfile --filter "@creator-platform/api..."

COPY packages/shared packages/shared
COPY apps/api apps/api
# Typecheck is CI's job; the image only bundles (esbuild, build.mjs).
RUN pnpm --filter @creator-platform/api build

# A pruned, self-contained production install: no devDependencies. `--legacy`
# is pnpm 10's deploy mode for workspaces without injected packages; the
# shared package is already inlined in the bundle, so nothing links back.
RUN pnpm --filter @creator-platform/api deploy --prod --legacy /out \
 && cd /out \
 && node node_modules/prisma/build/index.js generate --schema prisma/schema.prisma \
 && rm -rf src test scripts/load vitest.* tsconfig.json build.mjs .env.example

# ── runtime ──────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/prisma ./prisma
COPY --from=build /repo/apps/api/dist ./dist
# The release's own compose/Caddy config. deploy.sh extracts these per release,
# so a rollback rolls the infra back with the code (infra/compose.yaml).
COPY infra/compose.yaml infra/Caddyfile ./infra/

ARG GIT_SHA=unknown
# 256 MiB heap: the API's working set is small (JSON, Prisma rows); uploads and
# libvips buffers live OUTSIDE the V8 heap. With the 448 MiB container limit
# this leaves ~190 MiB for the Prisma engine, sharp and one buffered upload.
ENV NODE_ENV=production \
    API_PORT=4000 \
    NODE_OPTIONS=--max-old-space-size=256 \
    SENTRY_RELEASE=${GIT_SHA}
LABEL org.opencontainers.image.revision=${GIT_SHA} \
      org.opencontainers.image.source=https://github.com/soulevil09/creator-platform

# Non-root: the image's built-in unprivileged `node` user. Nothing is writable.
USER node
EXPOSE 4000

# Liveness only (no DB) — cheap enough for every 15 s.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# Migrations (one-off, compose profile `migrate`) use the pinned CLI:
#   node node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma
CMD ["node", "dist/index.js"]
