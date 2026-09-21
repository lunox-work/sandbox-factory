/**
 * Process entry point. Everything testable lives in routes.ts; this file only
 * wires config to a listening socket.
 */

import { serve } from "@hono/node-server";
import {
  createBountyRunStore,
  createBountyWritebackStore,
  createConnection,
  createBountyProposalStore,
  createEmailStore,
  createJiraBoardStore,
  createJiraConnectionStore,
  createJiraIssueStore,
  createOrganizationStore,
  createProfileStore,
  createRateCardStore,
  createTokenCipher,
} from "@sandbox-factory/db";

import { buildBanner } from "@sandbox-factory/shared";

import { createAuth } from "./auth.js";
import { BountyExecutor } from "./bounty/executor.js";
import { BountyDelivery } from "./bounty/delivery.js";
import { BountyWatchdog } from "./bounty/watchdog.js";
import {
  appUrl,
  buildInfo,
  jiraOAuthConfig,
  parseEnv,
  sizingConfig,
} from "./env.js";
import { resolveImageDigest } from "./image-digest.js";
import { jiraClientFor, jiraClientsFor } from "./jira/credential.js";
import { createApp } from "./routes.js";
import { AnthropicSizer, JIRA_SIZE_PROMPT_VERSION } from "./sizing/index.js";

const env = parseEnv();

// Awaited before serving so `GET /version` never answers without a digest it
// would report a moment later. Safe to block on: it never throws and is bounded
// by a one-second timeout. See image-digest.ts.
const build = { ...buildInfo(env), imageDigest: await resolveImageDigest() };

const connection = createConnection({ url: env.DATABASE_URL });

const emails = createEmailStore(connection.db);
const profiles = createProfileStore(connection.db);
const organizations = createOrganizationStore(connection.db);
const jiraConnections = createJiraConnectionStore(
  connection.db,
  createTokenCipher(env.TOKEN_ENCRYPTION_KEY),
);
const jiraBoards = createJiraBoardStore(connection.db);
const bountyRuns = createBountyRunStore(connection.db);
const bountyProposals = createBountyProposalStore(connection.db);
const jiraIssues = createJiraIssueStore(connection.db);
const rateCards = createRateCardStore(connection.db);
const bountyWritebacks = createBountyWritebackStore(connection.db);

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
const sizing = sizingConfig(env);
const jiraClientOptions =
  jiraOAuth === undefined
    ? undefined
    : {
        connections: jiraConnections,
        clientId: jiraOAuth.clientId,
        clientSecret: jiraOAuth.clientSecret,
      };
const runClientFor = async (organizationId: string, connectionId: string) => {
  if (jiraClientOptions === undefined) {
    return { ok: false as const, reason: "reconnect" as const };
  }
  const result = await jiraClientFor(
    jiraClientOptions,
    organizationId,
    connectionId,
  );
  return result.ok
    ? { ok: true as const, client: result.client }
    : { ok: false as const, reason: result.failure.reason };
};
const bountyDelivery =
  jiraClientOptions === undefined
    ? undefined
    : new BountyDelivery({
        writebacks: bountyWritebacks,
        proposals: bountyProposals,
        issues: jiraIssues,
        boards: jiraBoards,
        connections: jiraConnections,
        clientsFor: async (organizationId, connectionId) => {
          const result = await jiraClientsFor(
            jiraClientOptions,
            organizationId,
            connectionId,
          );
          return result.ok
            ? {
                ok: true,
                client: result.client,
                writeClient: result.writeClient,
              }
            : { ok: false, reason: result.failure.reason };
        },
        onBackgroundError: (code) => console.error(code),
      });
const bountyExecutor =
  sizing === undefined || jiraClientOptions === undefined
    ? undefined
    : new BountyExecutor({
        boards: jiraBoards,
        runs: bountyRuns,
        proposals: bountyProposals,
        issues: jiraIssues,
        sizer: new AnthropicSizer({
          apiKey: sizing.apiKey,
          model: sizing.model,
        }),
        clientFor: runClientFor,
        ...(bountyDelivery === undefined
          ? {}
          : {
              onWritebackCreated: (organizationId, operationId) =>
                bountyDelivery.start(organizationId, operationId),
            }),
        onBackgroundError: (code) => console.error(code),
      });
const jira =
  jiraOAuth === undefined
    ? undefined
    : {
        connections: jiraConnections,
        boards: jiraBoards,
        proposals: bountyProposals,
        clientId: jiraOAuth.clientId,
        clientSecret: jiraOAuth.clientSecret,
        // The same secret Better Auth signs sessions with. A forged `state`
        // needs it, and it is already required to be 32 characters.
        secret: env.BETTER_AUTH_SECRET,
        apiUrl: env.BETTER_AUTH_URL,
        appUrl: appUrl(env),
      };

const app = createApp({
  corsOrigins: env.CORS_ORIGINS,
  auth,
  emails,
  profiles,
  organizations,
  jira,
  bounty: {
    rateCards,
    runs: bountyRuns,
    boards: jiraBoards,
    proposals: bountyProposals,
    issues: jiraIssues,
    connections: jiraConnections,
    writebacks: bountyWritebacks,
    ...(bountyDelivery === undefined ? {} : { delivery: bountyDelivery }),
    appUrl: appUrl(env),
    organizationSlug: async (organizationId) =>
      (await organizations.get(organizationId))?.slug,
    clientFor: runClientFor,
    ...(bountyExecutor === undefined
      ? {}
      : {
          executor: bountyExecutor,
          requestedModel: sizing?.model,
          promptVersion: JIRA_SIZE_PROMPT_VERSION,
        }),
  },
  buildInfo: build,
  originVerify: env.ORIGIN_VERIFY,
});

const bountyWatchdog = new BountyWatchdog({
  runs: bountyRuns,
  writebacks: bountyWritebacks,
  onError: (code) => console.error(code),
});
bountyWatchdog.start();

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
    bountyWatchdog.stop();
    server.close(() => {
      void connection.close().then(() => process.exit(0));
    });
  });
}
