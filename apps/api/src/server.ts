/**
 * Process entry point. Everything testable lives in routes.ts; this file only
 * wires config to a listening socket.
 */

import { serve } from "@hono/node-server";
import {
  createConnection,
  createEmailStore,
  createPostgresStore,
  createProfileStore,
} from "@sandbox-factory/db";

import { buildBanner } from "@sandbox-factory/shared";

import { createAuth } from "./auth.js";
import { appUrl, buildInfo, parseEnv } from "./env.js";
import { resolveImageDigest } from "./image-digest.js";
import { createApp } from "./routes.js";

const env = parseEnv();

// Awaited before serving so `GET /version` never answers without a digest it
// would report a moment later. Safe to block on: it never throws and is bounded
// by a one-second timeout. See image-digest.ts.
const build = { ...buildInfo(env), imageDigest: await resolveImageDigest() };

const connection = createConnection({ url: env.DATABASE_URL });

const emails = createEmailStore(connection.db);
const profiles = createProfileStore(connection.db);

const auth = createAuth({
  db: connection.db,
  emails,
  lookupEmail: (userId) => emails.primaryFor(userId),
  handles: { suggest: (email) => profiles.suggest(email) },
  baseUrl: env.BETTER_AUTH_URL,
  appUrl: appUrl(env),
  // The API's own origin is included because Better Auth checks the callback
  // against this list too, and it is not in CORS_ORIGINS.
  trustedOrigins: [...env.CORS_ORIGINS, env.BETTER_AUTH_URL],
  secret: env.BETTER_AUTH_SECRET,
  google: {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
  },
  github: {
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
  },
  atlassian: {
    clientId: env.ATLASSIAN_CLIENT_ID,
    clientSecret: env.ATLASSIAN_CLIENT_SECRET,
  },
  crossSubDomainCookies:
    env.AUTH_COOKIE_DOMAIN === undefined
      ? undefined
      : { domain: env.AUTH_COOKIE_DOMAIN },
});

const app = createApp({
  store: createPostgresStore(connection.db),
  corsOrigins: env.CORS_ORIGINS,
  auth,
  emails,
  profiles,
  buildInfo: build,
  originVerify: env.ORIGIN_VERIFY,
});

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  // First log line names the build. Logs outlive the deployment, whereas
  // `GET /version` only answers for the process running now.
  console.log(buildBanner("sandbox-factory API", build));
  console.log(`API listening on http://localhost:${info.port}`);
});

// Drain the pool on shutdown; otherwise open connections keep the process
// alive until the container's stop timeout.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void connection.close().then(() => process.exit(0));
    });
  });
}
