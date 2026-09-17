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
import { createApp } from "./routes.js";

const env = parseEnv();
const build = buildInfo(env);

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
  // The web origins are the ones a sign-in may return to. The API's own
  // origin is included because Better Auth compares the callback against this
  // list too, and it is not otherwise in CORS_ORIGINS.
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
});

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  // Logged on every boot, before anything can go wrong, so the first line in a
  // container's logs says which build produced everything below it. This is the
  // line to quote when reporting what a deployed instance was running — log
  // retention outlives the deployment that wrote it, while `GET /version` only
  // ever answers for the process running right now.
  console.log(buildBanner("sandbox-factory API", build));
  console.log(`API listening on http://localhost:${info.port}`);
});

// Drain the pool on shutdown. Without this the process hangs on SIGTERM with
// connections still open, and the container takes the full stop timeout to die.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void connection.close().then(() => process.exit(0));
    });
  });
}
