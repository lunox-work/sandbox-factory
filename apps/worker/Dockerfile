# syntax=docker/dockerfile:1
FROM node:26-bookworm-slim@sha256:0042e17d232a87a2cd485be1da7900fca4d10a4ad11b29e9285da1d2e54798c9 AS python
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv tar && rm -rf /var/lib/apt/lists/*
COPY apps/worker/python/requirements.lock /tmp/requirements.lock
RUN python3 -m venv /opt/graphify && /opt/graphify/bin/pip install --no-cache-dir --require-hashes -r /tmp/requirements.lock
ENV PATH="/opt/graphify/bin:${PATH}"

FROM python AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY tooling/tsconfig/package.json ./tooling/tsconfig/
COPY tooling/coverage-guard/package.json ./tooling/coverage-guard/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/github/package.json ./packages/github/
COPY packages/jira/package.json ./packages/jira/
COPY packages/shared/package.json ./packages/shared/
COPY packages/client/package.json ./packages/client/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/extension/package.json ./apps/extension/
COPY apps/worker/package.json ./apps/worker/
RUN npm ci --ignore-scripts

FROM deps AS dev
COPY tooling ./tooling
COPY packages ./packages
COPY apps/worker ./apps/worker
COPY turbo.json ./
CMD ["npm", "run", "dev", "--workspace", "@sandbox-factory/worker"]

FROM dev AS build
RUN npx turbo run build --filter=@sandbox-factory/worker

FROM deps AS prod-deps
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM python AS runtime
WORKDIR /repo
ENV NODE_ENV=production PYTHONDONTWRITEBYTECODE=1
LABEL org.opencontainers.image.source="https://github.com/lunox-work/sandbox-factory"
COPY --from=prod-deps /repo ./
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/worker ./apps/worker
USER node
CMD ["node", "apps/worker/dist/main.js"]
