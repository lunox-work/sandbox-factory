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

RUN npx turbo run build --filter=@sandbox-factory/web

# ---- runtime ---------------------------------------------------------------
# The built app is static files; nothing from the Node image needs to ship.
FROM nginx:1.27-alpine AS runtime

COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/templates/default.conf.template

# Substituted into the template at container start by the nginx entrypoint, so
# one image works against any API host.
ENV API_URL=http://api:4000

EXPOSE 80
