# syntax=docker/dockerfile:1
# Farad Hall's images, from the repository root:
#   docker build -f deploy/docker/Dockerfile --target api   -t farad-hall/api .
#   docker build -f deploy/docker/Dockerfile --target caddy -t farad-hall/caddy .
# `api` is hall-api (Node); `caddy` is Caddy with the built web UI and deploy/Caddyfile.

FROM node:22-bookworm-slim AS build
WORKDIR /src
ENV CI=1
RUN corepack enable
# Dependencies first, so a code change does not reinstall them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/openapi/package.json packages/openapi/
COPY packages/protocol/package.json packages/protocol/
COPY packages/test-support/package.json packages/test-support/
COPY tools/device-sim/package.json tools/device-sim/
COPY apps/hall-api/package.json apps/hall-api/
COPY apps/hall-web/package.json apps/hall-web/
# Behind a TLS-intercepting proxy, pass its CA: docker build --secret id=ca_bundle,src=<ca.pem> …
RUN --mount=type=secret,id=ca_bundle,required=false \
    if [ -f /run/secrets/ca_bundle ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca_bundle; fi; \
    pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages packages
COPY tools tools
COPY apps apps
RUN pnpm --filter "@hall/api..." build && pnpm --filter @hall/web build
# A standalone copy of hall-api with its production dependencies (workspace packages included).
RUN --mount=type=secret,id=ca_bundle,required=false \
    if [ -f /run/secrets/ca_bundle ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca_bundle; fi; \
    pnpm --filter @hall/api deploy --prod --legacy --prefer-offline /out

FROM node:22-bookworm-slim AS api
ARG HALL_VERSION=dev
ENV NODE_ENV=production HALL_VERSION=${HALL_VERSION} HALL_PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.HALL_PORT || 8080) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/main.js"]

FROM caddy:2.10-alpine AS caddy
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/apps/hall-web/dist /srv/hall-web
