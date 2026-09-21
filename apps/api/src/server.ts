/**
 * Process entry point. Everything testable lives in routes.ts; this file only
 * wires config to a listening socket.
 */

import { serve } from "@hono/node-server";
import {
  createConnection,
  createEmailStore,
  createJiraConnectionStore,
  createOrganizationStore,
  createPostgresStore,
  createProfileStore,
  createTokenCipher,
} from "@sandbox-factory/db";

import { buildBanner } from "@sandbox-factory/shared";

import { createAuth } from "./auth.js";
import { appUrl, buildInfo, jiraOAuthConfig, parseEnv } from "./env.js";
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
const organizations = createOrganizationStore(connection.db);

const auth = createAuth({
  db: connection.db,
  emails,
  lookupEmail: (userId) => emails.primaryFor(userId),
  handles: { suggest: (email) => profiles.suggest(email) },
  organizations,
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

/**
 * Jira connections, if the second Atlassian app is configured.
 *
 * Undefined leaves the routes unmounted rather than stopping the process: a
 * deployment without those credentials should still serve everything else.
 * The cipher is built unconditionally, because `TOKEN_ENCRYPTION_KEY` is
 * required — an API that could boot without it would be one that could write
 * a token in the clear.
 */
const jiraOAuth = jiraOAuthConfig(env);
const jira =
  jiraOAuth === undefined
    ? undefined
    : {
        connections: createJiraConnectionStore(
          connection.db,
          createTokenCipher(env.TOKEN_ENCRYPTION_KEY),
        ),
        clientId: jiraOAuth.clientId,
        clientSecret: jiraOAuth.clientSecret,
        // The same secret Better Auth signs sessions with. A forged `state`
        // needs it, and it is already required to be 32 characters.
        secret: env.BETTER_AUTH_SECRET,
        apiUrl: env.BETTER_AUTH_URL,
        appUrl: appUrl(env),
      };

const app = createApp({
  store: createPostgresStore(connection.db),
  corsOrigins: env.CORS_ORIGINS,
  auth,
  emails,
  profiles,
  organizations,
  jira,
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
