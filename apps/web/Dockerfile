# =============================================================================
# Web image (Session 13, D6). Build from the repo root:
#   docker build -f apps/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_APP_URL=https://app.visorfans.com \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.visorfans.com \
#     --build-arg NEXT_PUBLIC_MEDIA_ORIGIN=https://<ref>.supabase.co \
#     --build-arg NEXT_PUBLIC_SENTRY_DSN=... --build-arg GIT_SHA=$(git rev-parse HEAD) .
#
# Every NEXT_PUBLIC_* value is INLINED at build time: changing one means
# rebuilding this image. None of them is a secret. The only secret the build
# can use — SENTRY_AUTH_TOKEN, for source-map upload — is a BuildKit secret
# mount (`--secret id=sentry_auth_token`), never a build arg or a layer.
# =============================================================================
ARG NODE_IMAGE=node:22.23.3-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

FROM ${NODE_IMAGE} AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter "@creator-platform/web..."

COPY packages/shared packages/shared
COPY apps/web apps/web

ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_DEFAULT_LOCALE=pt-BR
ARG NEXT_PUBLIC_MEDIA_ORIGIN
ARG NEXT_PUBLIC_SENTRY_DSN
ARG NEXT_PUBLIC_SENTRY_ENVIRONMENT=production
ARG NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE=0
ARG GIT_SHA=unknown
ARG SENTRY_ORG
ARG SENTRY_PROJECT_WEB
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL} \
    NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_DEFAULT_LOCALE=${NEXT_PUBLIC_DEFAULT_LOCALE} \
    NEXT_PUBLIC_MEDIA_ORIGIN=${NEXT_PUBLIC_MEDIA_ORIGIN} \
    NEXT_PUBLIC_SENTRY_DSN=${NEXT_PUBLIC_SENTRY_DSN} \
    NEXT_PUBLIC_SENTRY_ENVIRONMENT=${NEXT_PUBLIC_SENTRY_ENVIRONMENT} \
    NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE=${NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE} \
    NEXT_PUBLIC_SENTRY_RELEASE=${GIT_SHA} \
    SENTRY_ORG=${SENTRY_ORG} \
    SENTRY_PROJECT_WEB=${SENTRY_PROJECT_WEB} \
    NODE_ENV=production

# Source maps are uploaded only if the secret is mounted, then deleted by the
# Sentry plugin; the `find` below guarantees none reach the runtime image.
RUN --mount=type=secret,id=sentry_auth_token,required=false \
    SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token 2>/dev/null || true)" \
    pnpm --filter @creator-platform/web build \
 && find apps/web/.next -name '*.map' -delete

# ── runtime: Next standalone server only ────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static

ARG GIT_SHA=unknown
# 256 MiB heap: SSR of a handful of small pages with next-intl; idle RSS is
# ~100 MiB. The 384 MiB container limit leaves room for the runtime itself.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NODE_OPTIONS=--max-old-space-size=256
LABEL org.opencontainers.image.revision=${GIT_SHA} \
      org.opencontainers.image.source=https://github.com/soulevil09/creator-platform

USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
