# syntax=docker/dockerfile:1

# Multi-stage build for the web app: Vite build, served by nginx.
#
# Built from the REPO ROOT, not apps/web:
#   docker build -f apps/web/Dockerfile .

# ---- deps ------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /repo

COPY package.json package-lock.json ./
COPY tooling/tsconfig/package.json ./tooling/tsconfig/
COPY packages/core/package.json ./packages/core/
COPY packages/shared/package.json ./packages/shared/
COPY packages/client/package.json ./packages/client/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/extension/package.json ./apps/extension/

RUN npm ci --ignore-scripts

# ---- build -----------------------------------------------------------------
FROM deps AS build
WORKDIR /repo

COPY tooling ./tooling
COPY packages ./packages
COPY apps/web ./apps/web
COPY turbo.json ./
# Both files: `build` runs `tsc` first, which resolves the import through the
# .d.mts. Copying only the .mjs fails the type-check.
COPY scripts/build-info.mjs scripts/build-info.d.mts ./scripts/

# Build provenance. Consumed at build time, unlike the API's: Vite compiles the
# values into the bundle, so a cached bundle keeps reporting the build it is.
#
#   docker build -f apps/web/Dockerfile \
#     --build-arg BUILD_SHA="$(git rev-parse HEAD)" .
ARG BUILD_VERSION
ARG BUILD_SHA
ARG BUILD_TIME
ARG BUILD_REF
ENV BUILD_VERSION=${BUILD_VERSION} \
    BUILD_SHA=${BUILD_SHA} \
    BUILD_TIME=${BUILD_TIME} \
    BUILD_REF=${BUILD_REF}

RUN npx turbo run build --filter=@sandbox-factory/web

# ---- runtime ---------------------------------------------------------------
# The built app is static files; nothing from the Node image needs to ship.
FROM nginx:1.27-alpine AS runtime

COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/templates/default.conf.template

# Substituted into the template at container start, so one image works against
# any API host.
ENV API_URL=http://api:4000

EXPOSE 80
