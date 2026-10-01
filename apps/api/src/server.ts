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
  createBountySpecStore,
  createEmailStore,
  createGithubConnectionStore,
  createGithubGrantStore,
  createGithubRepoStore,
  createJiraBoardStore,
  createJiraConnectionStore,
  createJiraIssueStore,
  createObjectStore,
  createOrganizationStore,
  createProfileStore,
  createRateCardStore,
  createTokenCipher,
} from "@sandbox-factory/db";

import { InstallationTokens } from "@sandbox-factory/github";
import { buildBanner } from "@sandbox-factory/shared";

import { createAuth } from "./auth.js";
import { createAvatarService } from "./avatars/service.js";
import { BountyExecutor } from "./bounty/executor.js";
import { BountyDelivery } from "./bounty/delivery.js";
import { BountyWatchdog } from "./bounty/watchdog.js";
import {
  appUrl,
  buildInfo,
  deepseekSizingConfig,
  githubAppConfig,
  githubAppMissing,
  jiraOAuthConfig,
  objectStoreConfig,
  parseEnv,
  sizingConfig,
} from "./env.js";
import { GithubReconciler } from "./github/reconcile.js";
import { resolveImageDigest } from "./image-digest.js";
import { jiraClientFor, jiraClientsFor } from "./jira/credential.js";
import { createApp } from "./routes.js";
import {
  AnthropicCaller,
  DeepSeekCaller,
  FallbackCaller,
  JIRA_SIZE_PROMPT_VERSION,
  type StructuredCaller,
} from "./sizing/index.js";

const env = parseEnv();

// Awaited before serving so `GET /version` never answers without a digest it
// would report a moment later. Safe to block on: it never throws and is bounded
// by a one-second timeout. See image-digest.ts.
const build = { ...buildInfo(env), imageDigest: await resolveImageDigest() };

const connection = createConnection({ url: env.DATABASE_URL });

const emails = createEmailStore(connection.db);
const profiles = createProfileStore(connection.db);
const organizations = createOrganizationStore(connection.db);
const tokenCipher = createTokenCipher(env.TOKEN_ENCRYPTION_KEY);
const jiraConnections = createJiraConnectionStore(connection.db, tokenCipher);
const jiraBoards = createJiraBoardStore(connection.db);
const bountyRuns = createBountyRunStore(connection.db);
const bountyProposals = createBountyProposalStore(connection.db);
const bountySpecs = createBountySpecStore(connection.db);
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
const deepseekSizing = deepseekSizingConfig(env);

/**
 * The model a run calls, or undefined when neither provider is configured.
 * With both, the DeepSeek adapter answers whenever an Anthropic call fails;
 * with one, that one serves alone. Every spec and every sized ticket records
 * the model that actually answered, so a handover stays visible after the
 * fact.
 */
const caller: StructuredCaller | undefined = (() => {
  const anthropic =
    sizing === undefined
      ? undefined
      : new AnthropicCaller({ apiKey: sizing.apiKey, model: sizing.model });
  const deepseek =
    deepseekSizing === undefined
      ? undefined
      : new DeepSeekCaller({
          apiKey: deepseekSizing.apiKey,
          model: deepseekSizing.model,
          ...(deepseekSizing.baseUrl === undefined
            ? {}
            : { baseUrl: deepseekSizing.baseUrl }),
        });

  if (anthropic !== undefined && deepseek !== undefined) {
    return new FallbackCaller({
      primary: anthropic,
      fallback: deepseek,
      onFallback: (code) => console.warn(`sizing_fallback ${code}`),
    });
  }
  return anthropic ?? deepseek;
})();
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
  caller === undefined || jiraClientOptions === undefined
    ? undefined
    : new BountyExecutor({
        boards: jiraBoards,
        runs: bountyRuns,
        proposals: bountyProposals,
        issues: jiraIssues,
        specs: bountySpecs,
        caller,
        clientFor: runClientFor,
        ...(bountyDelivery === undefined
          ? {}
          : {
              onWritebackCreated: (organizationId, operationId) =>
                bountyDelivery.start(organizationId, operationId),
            }),
        onBackgroundError: (code, error) => console.error(code, error),
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

/**
 * The GitHub App, if all six of its values are set; see `githubAppConfig`.
 *
 * One installation-token cache for the process, shared by the routes, the
 * webhook and the sweep, so a token minted for one is reused by the others
 * rather than minted again. Tokens live only here, in memory.
 */
const githubApp = githubAppConfig(env);
const githubMissing = githubAppMissing(env);
if (githubMissing.length > 0) {
  console.warn(
    `GitHub is off: ${githubMissing.join(", ")} unset while the rest of the App is set.`,
  );
}
const github =
  githubApp === undefined
    ? undefined
    : {
        connections: createGithubConnectionStore(connection.db),
        grants: createGithubGrantStore(connection.db, tokenCipher),
        repos: createGithubRepoStore(connection.db),
        installations: new InstallationTokens({
          appId: githubApp.appId,
          privateKey: githubApp.privateKey,
        }),
        appSlug: githubApp.slug,
        clientId: githubApp.clientId,
        clientSecret: githubApp.clientSecret,
        webhookSecret: githubApp.webhookSecret,
        // The same secret Jira's state is signed with; `purpose` in the
        // state is what keeps the two flows' states apart.
        secret: env.BETTER_AUTH_SECRET,
        apiUrl: env.BETTER_AUTH_URL,
        appUrl: appUrl(env),
        onBackgroundError: (code: string, error: unknown) =>
          console.error(code, error),
      };
const githubReconciler =
  github === undefined
    ? undefined
    : new GithubReconciler({
        repos: github.repos,
        connections: github.connections,
        installations: github.installations,
        onError: (code, detail) =>
          console.error(detail === undefined ? code : `${code} ${detail}`),
      });

/**
 * Avatar storage, when a bucket is configured: SeaweedFS locally, S3 in
 * production. Undefined leaves the upload routes unmounted and everyone on
 * their identicon or provider picture.
 */
const storage = objectStoreConfig(env);
const avatars =
  storage === undefined
    ? undefined
    : createAvatarService({ store: createObjectStore(storage) });

const app = createApp({
  corsOrigins: env.CORS_ORIGINS,
  auth,
  emails,
  profiles,
  organizations,
  jira,
  github,
  bounty: {
    rateCards,
    runs: bountyRuns,
    boards: jiraBoards,
    proposals: bountyProposals,
    specs: bountySpecs,
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
          // The caller's own model, not the Anthropic pair's: on a
          // DeepSeek-only deploy that pair is unset, and a missing
          // `requestedModel` makes every run refuse to start.
          requestedModel: caller?.model,
          promptVersion: JIRA_SIZE_PROMPT_VERSION,
        }),
  },
  avatars,
  buildInfo: build,
  originVerify: env.ORIGIN_VERIFY,
});

const bountyWatchdog = new BountyWatchdog({
  runs: bountyRuns,
  writebacks: bountyWritebacks,
  onError: (code) => console.error(code),
});
bountyWatchdog.start();
githubReconciler?.start();

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
    // The sweep finishes the repository it is on before the pool closes.
    void Promise.resolve(githubReconciler?.stop()).then(() => {
      server.close(() => {
        void connection.close().then(() => process.exit(0));
      });
    });
  });
}
