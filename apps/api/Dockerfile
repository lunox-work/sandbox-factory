# syntax=docker/dockerfile:1

# Multi-stage build for the API.
#
# Built from the REPO ROOT, not apps/api — the workspace packages it imports
# live outside that directory, so a narrower context cannot see them:
#   docker build -f apps/api/Dockerfile .

# ---- deps ------------------------------------------------------------------
# Every workspace manifest, and nothing else. Docker caches this layer until a
# package.json or the lockfile changes, so editing source does not reinstall.
FROM node:22-alpine AS deps
WORKDIR /repo

COPY package.json package-lock.json ./
COPY tooling/tsconfig/package.json ./tooling/tsconfig/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/shared/package.json ./packages/shared/
COPY packages/client/package.json ./packages/client/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/extension/package.json ./apps/extension/

# --ignore-scripts skips husky's `prepare`, which fails outside a git work tree.
RUN npm ci --ignore-scripts

# ---- build -----------------------------------------------------------------
FROM deps AS build
WORKDIR /repo

COPY tooling ./tooling
COPY packages ./packages
COPY apps/api ./apps/api
COPY turbo.json ./

# Turbo builds packages/core and packages/shared first, in dependency order.
RUN npx turbo run build --filter=@sandbox-factory/api

# ---- runtime ---------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production

# Drops devDependencies (typescript, turbo) from the shipped image while
# keeping the workspace symlinks the API resolves its imports through.
COPY --from=build /repo/package.json /repo/package-lock.json ./
COPY --from=build /repo/tooling ./tooling
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/api ./apps/api
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# node:alpine ships an unprivileged `node` user; root is never needed here.
USER node

EXPOSE 4000
# Exec form so the process gets PID 1 and receives SIGTERM directly, letting
# `docker stop` shut it down cleanly instead of killing it after a timeout.
CMD ["node", "apps/api/dist/server.js"]
