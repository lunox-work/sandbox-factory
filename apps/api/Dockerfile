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

# ---- prod-deps -------------------------------------------------------------
# The runtime dependency tree, installed from the manifests alone.
#
# This used to be an `npm ci --omit=dev` at the end of the runtime stage, after
# the built sources had been copied in. Every commit changes those sources, so
# that layer could never be cached and the install ran on every deploy. Here its
# only inputs are the manifests and the lockfile, so it is rebuilt when a
# dependency changes and replayed from cache otherwise — the same property the
# `deps` stage above has.
FROM deps AS prod-deps
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---- build -----------------------------------------------------------------
FROM deps AS build
WORKDIR /repo

COPY tooling ./tooling
COPY packages ./packages
COPY apps/api ./apps/api
COPY turbo.json ./

# No build args here: nothing in this stage reads them. The API is a Node
# process that reads its provenance from the environment at boot, so the values
# belong in the runtime stage below, not compiled into anything.

# Turbo builds packages/core and packages/shared first, in dependency order.
RUN npx turbo run build --filter=@sandbox-factory/api

# ---- runtime ---------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production

# node_modules without devDependencies (typescript, turbo), plus the manifests
# and the workspace symlinks the API resolves its imports through. Copied first
# so the layers that change on every commit sit on top of the one that does not.
COPY --from=prod-deps /repo ./
COPY --from=build /repo/tooling ./tooling
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/api ./apps/api

# Unlike the web app, the API reads these at runtime rather than having them
# compiled in — it is a Node process with an environment, so there is nothing
# to bake. Redeclared here because ARGs do not cross stage boundaries, and
# promoted to ENV so the running process can read them.
ARG BUILD_VERSION
ARG BUILD_SHA
ARG BUILD_TIME
ARG BUILD_REF
ENV BUILD_VERSION=${BUILD_VERSION} \
    BUILD_SHA=${BUILD_SHA} \
    BUILD_TIME=${BUILD_TIME} \
    BUILD_REF=${BUILD_REF}

# node:alpine ships an unprivileged `node` user; root is never needed here.
USER node

EXPOSE 4000
# Exec form so the process gets PID 1 and receives SIGTERM directly, letting
# `docker stop` shut it down cleanly instead of killing it after a timeout.
CMD ["node", "apps/api/dist/server.js"]
