# syntax=docker/dockerfile:1

# API image. Build from the REPO ROOT so the workspace packages are in context:
#   docker build -f apps/api/Dockerfile .

# ---- deps ------------------------------------------------------------------
# Manifests only, so the install layer is cached until a dependency changes.
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
# Runtime dependency tree. A separate stage whose only inputs are the manifests,
# so it caches like `deps`. Do not move it into the runtime stage after the
# source COPY: it would then reinstall on every commit.
FROM deps AS prod-deps
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---- build -----------------------------------------------------------------
FROM deps AS build
WORKDIR /repo

COPY tooling ./tooling
COPY packages ./packages
COPY apps/api ./apps/api
COPY turbo.json ./

# No build args here: the API reads provenance from the environment at boot, so
# they belong in the runtime stage.

# Turbo builds the workspace dependencies first, in dependency order.
RUN npx turbo run build --filter=@sandbox-factory/api

# ---- runtime ---------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production

# Links the public GHCR mirror of this image (see cd.yml) to the repository,
# so the package page points back at the source it was built from.
LABEL org.opencontainers.image.source="https://github.com/lunox-work/sandbox-factory"

# Production node_modules, manifests and workspace symlinks. Copied first so
# the layers that change on every commit sit on top of the one that does not.
COPY --from=prod-deps /repo ./
COPY --from=build /repo/tooling ./tooling
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/api ./apps/api

# ARGs do not cross stage boundaries, so they are declared here, and promoted
# to ENV so the running process can read them.
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
# Exec form: node is PID 1 and receives SIGTERM directly, so it stops cleanly.
CMD ["node", "apps/api/dist/server.js"]
