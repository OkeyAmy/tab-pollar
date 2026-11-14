# TAB — one image, four processes: API, web, depot, Caddy.
# Single origin is deliberate: cookies (SameSite=Strict), SSE, and Pollar OAuth
# all stay same-origin. Caddy routes /api and /depot.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG CADDY_IMAGE=caddy:2.8-alpine

# Global ARG → named stage, so `COPY --from=caddy` works.
FROM ${CADDY_IMAGE} AS caddy

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
WORKDIR /app

# better-sqlite3 may compile from source when no prebuild matches the exact
# Node ABI; keep python3/make/g++ available in the build stages.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# ── deps ─────────────────────────────────────────────────────────────────────
FROM base AS deps
# The registry can be slow/flaky from CI/VPS networks. Be patient and retry.
ENV npm_config_fetch_timeout=600000
ENV npm_config_fetch_retries=6
ENV npm_config_fetch_retry_mintimeout=20000
ENV npm_config_fetch_retry_maxtimeout=120000
# Use the Node headers that ship with the official image; avoids node-gyp
# downloading headers + SHASUMS from nodejs.org (which can time out).
ENV npm_config_nodedir=/usr/local
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/depot/package.json apps/depot/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/policy/package.json packages/policy/package.json
COPY packages/pollar/package.json packages/pollar/package.json
COPY packages/agent-kit/package.json packages/agent-kit/package.json
COPY packages/mcp/package.json packages/mcp/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store

# ── build ────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY . .

ARG NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_POLLAR_CHAIN=STELLAR
ARG NEXT_PUBLIC_SETTLEMENT_ASSET=USDC
ARG NEXT_PUBLIC_USDC_ISSUER
ARG NEXT_PUBLIC_DEPOT_URL=/depot

ENV NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY=$NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_POLLAR_CHAIN=$NEXT_PUBLIC_POLLAR_CHAIN
ENV NEXT_PUBLIC_SETTLEMENT_ASSET=$NEXT_PUBLIC_SETTLEMENT_ASSET
ENV NEXT_PUBLIC_USDC_ISSUER=$NEXT_PUBLIC_USDC_ISSUER
ENV NEXT_PUBLIC_DEPOT_URL=$NEXT_PUBLIC_DEPOT_URL
ENV API_BASE_URL=http://127.0.0.1:4000

RUN pnpm --filter @tab/web build
# The depot is served under /depot in production; its /api fetches are absolute.
RUN NEXT_BASE_PATH=/depot pnpm --filter @tab/depot build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM build AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production
ENV NEXT_BASE_PATH=/depot
ENV TAB_SIGNER_MODE=browser
ENV TAB_DEMO_MODE=1
ENV DATABASE_PATH=/data/tab.db
ENV PORT=4000
ENV API_BASE_URL=http://127.0.0.1:4000

VOLUME ["/data"]
EXPOSE 8080
CMD ["/usr/local/bin/entrypoint.sh"]
