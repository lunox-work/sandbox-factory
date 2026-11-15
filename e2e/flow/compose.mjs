/**
 * The platform in one process: the API composed as `apps/api/src/server.ts`
 * composes it, and the worker's `executeRun` as `apps/worker/src/main.ts`
 * runs it, over one Postgres database and one object store. Only the edges
 * differ (`fakes.mjs`): the sizing model, the agents' model, graphify's
 * Python run, GitHub's REST API and Jira's client. Nothing starts a timer: the
 * profiler, the cutter and the preparer are swept by `settle()`, which also
 * claims and runs every queued run, so a step's background work is done
 * when it returns. A GitHub delivery's work after its answer (merge-back's
 * CI read-back) is awaited by `settle()` too, which then sweeps CI as the
 * reconciler would.
 *
 * Kept beside server.ts by hand: a dependency server.ts gains is one this
 * composition must gain too, or the flow stops reaching the step that
 * needs it.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createAnalysisRunStore,
  createApiTokenStore,
  createArtifactStore,
  createBountyContextStore,
  createBountyProfileStore,
  createBountyProposalStore,
  createBountyRunStore,
  createBountySpecStore,
  createBountyStore,
  createBountyWritebackStore,
  createConnection,
  createContributorStore,
  createContributorTokenStore,
  createDecisionConfirmationStore,
  createEmailStore,
  createGithubConnectionStore,
  createGithubGrantStore,
  createGithubRepoStore,
  createJiraBoardStore,
  createJiraConnectionStore,
  createJiraIssueStore,
  createModelUsageStore,
  createOrganizationStore,
  createProfileStore,
  createRateCardStore,
  createRepoSnapshotStore,
  createSandboxStore,
  createSubmissionMergeStore,
  createSubmissionStore,
  createTokenCipher,
  createWorkspaceSettingsStore,
} from "@sandbox-factory/db";
import { InstallationTokens } from "@sandbox-factory/github";
import { briefCharsEach, cutBrief } from "sandbox-factory";
import { npmPackageTypes } from "carveout/extract";

import { createAuth } from "../../apps/api/dist/auth.js";
import { createApp } from "../../apps/api/dist/routes.js";
import { decisionsConfirmUrl } from "../../apps/api/dist/pricing/decisions.js";
import { BountyExecutor } from "../../apps/api/dist/pricing/executor.js";
import { BountyProfiler } from "../../apps/api/dist/pricing/profiler.js";
import { RubricPricer } from "../../apps/api/dist/pricing/rubric.js";
import { SandboxCutter } from "../../apps/api/dist/sandbox/cutter.js";
import { SandboxPreparer } from "../../apps/api/dist/sandbox/preparer.js";
import { touchedSource } from "../../apps/api/dist/sandbox/routes.js";
import { versionService } from "../../apps/api/dist/sandbox/version-service.js";
import { syncGithub } from "../../apps/api/dist/bounties/context.js";
import {
  builtAt,
  connectedRepositories,
  heldCommits,
  heldContext,
} from "../../apps/api/dist/bounties/held-context.js";
import { installationClient } from "../../apps/api/dist/github/credential.js";
import { mergeBackTargets } from "../../apps/api/dist/github/merge-back.js";
import { MergeCiTracker } from "../../apps/api/dist/github/merge-ci.js";
import { GithubSnapshotter } from "../../apps/api/dist/github/snapshot.js";
import {
  JIRA_SIZE_PROMPT_VERSION,
  outlineLinesEach,
  repositoryOutline,
} from "../../apps/api/dist/sizing/index.js";
import {
  readBrief,
  readDocumentSet,
} from "../../apps/api/dist/sizing/brief.js";

import { executeRun } from "../../apps/worker/dist/run.js";
import { createTaskReader } from "../../apps/worker/dist/tasks.js";
import { meteredAgent } from "../../apps/worker/dist/agent/metered.js";
import { createLocalProcessProvider } from "../../apps/worker/dist/evaluation/local-process.js";
import { createAbstractionsAdapter } from "../../apps/worker/dist/tools/abstractions.js";
import { createBriefAdapter } from "../../apps/worker/dist/tools/brief.js";
import { createDataModelAdapter } from "../../apps/worker/dist/tools/data-model.js";
import { createDocumentsAdapter } from "../../apps/worker/dist/tools/documents.js";
import { createFixturesAdapter } from "../../apps/worker/dist/tools/fixtures.js";
import { createGraphifyAdapter } from "../../apps/worker/dist/tools/graphify.js";
import { createSandboxBuildAdapter } from "../../apps/worker/dist/tools/sandbox-build.js";
import { createSandboxImportAdapter } from "../../apps/worker/dist/tools/sandbox-import.js";
import { createScopeAdapter } from "../../apps/worker/dist/tools/scope.js";
import { createSliceAdapter } from "../../apps/worker/dist/tools/slice.js";
import { createStarterAdapter } from "../../apps/worker/dist/tools/starter.js";
import { createSubmissionGradeAdapter } from "../../apps/worker/dist/tools/submission-grade.js";

export const API_URL = "http://api.flow.test";
export const APP_URL = "http://app.flow.test";
/** The org's analysis cap, as `MAX_ACTIVE_RUNS_PER_ORG` defaults it. */
const MAX_ACTIVE = 3;
const describe = (error) =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

export async function composePlatform({
  databaseUrl,
  objects,
  caller,
  agentModel,
  github,
  graphify,
  jira,
  npmCache,
  log,
}) {
  const connection = createConnection({ url: databaseUrl, max: 10 });
  const { db } = connection;
  const scratch = await mkdtemp(join(tmpdir(), "sandbox-factory-flow-"));
  /** Background faults, which `settle()` turns into a failed step. */
  const faults = [];
  const fault = (code, error) => {
    const line = error === undefined ? code : `${code} ${describe(error)}`;
    faults.push(line);
    log(`background: ${line}`);
  };

  const emails = createEmailStore(db);
  const profiles = createProfileStore(db);
  const organizations = createOrganizationStore(db);
  const tokenCipher = createTokenCipher(randomBytes(32).toString("base64"));
  const repoSnapshots = createRepoSnapshotStore(db);
  const modelUsage = createModelUsageStore(db);
  const bountyRuns = createBountyRunStore(db);
  const bountyProposals = createBountyProposalStore(db);
  const bountySpecs = createBountySpecStore(db);
  const bountyProfiles = createBountyProfileStore(db);
  const jiraIssues = createJiraIssueStore(db);
  const jiraBoards = createJiraBoardStore(db);
  const jiraConnections = createJiraConnectionStore(db, tokenCipher);
  const bounties = createBountyStore(db);
  const bountyContexts = createBountyContextStore(db);
  const rateCards = createRateCardStore(db);
  const githubConnections = createGithubConnectionStore(db);
  const githubRepos = createGithubRepoStore(db);
  const analysisRuns = createAnalysisRunStore(db);
  const artifacts = createArtifactStore(db);
  const sandboxStore = createSandboxStore(db);
  const submissions = createSubmissionStore(db);
  const apiTokens = createApiTokenStore(db);
  const contributorTokens = createContributorTokenStore(db);
  const contextFor = (organizationId, bounty) =>
    heldContext({ contexts: bountyContexts }, organizationId, bounty);

  const secret = randomBytes(32).toString("base64url");
  /** What the App signs its deliveries with; a step signs its own. */
  const webhookSecret = randomBytes(16).toString("hex");
  const oauth = { clientId: "flow-client", clientSecret: "flow-secret" };
  const auth = createAuth({
    db,
    emails,
    lookupEmail: (userId) => emails.primaryFor(userId),
    handles: { suggest: (email) => profiles.suggest(email) },
    organizations,
    baseUrl: API_URL,
    appUrl: APP_URL,
    trustedOrigins: [APP_URL, API_URL],
    secret,
    google: oauth,
    github: oauth,
    atlassian: oauth,
  });

  // GitHub: the App's token cache and the snapshotter, both on the fake.
  const installations = new InstallationTokens({
    appId: "1",
    privateKey: github.privateKey,
    fetch: github.fetch,
  });
  const snapshotter = new GithubSnapshotter({
    repos: githubRepos,
    snapshots: repoSnapshots,
    objects,
    installations,
    fetch: github.fetch,
    onError: (code, detail) => fault(code, detail),
  });
  const githubContext = {
    repos: githubRepos,
    snapshots: repoSnapshots,
    tree: (key) => snapshotter.tree(key),
    readerFor: async (organizationId, repo) => {
      const found = await githubConnections.get(
        organizationId,
        repo.connectionId,
      );
      return found === null || !found.healthy
        ? null
        : installationClient(
            installations,
            found.installationId,
            { kind: "repository", repositoryId: repo.externalId },
            github.fetch,
          );
    },
    documentsFor: (organizationId, snapshotId) =>
      readDocumentSet(
        { runs: analysisRuns, artifacts, objects },
        organizationId,
        snapshotId,
      ),
  };

  // Late-bound, as in server.ts: the executor's callbacks name the
  // profiler, which is built after it.
  let bountyProfiler;
  // Jira's client for a connection, as server.ts's `runClientFor` hands it
  // out; with no Jira, every connection needs reconnecting, as there.
  const runClientFor =
    jira === undefined
      ? async () => ({ ok: false, reason: "reconnect" })
      : (organizationId, connectionId) =>
          jira.clientFor(organizationId, connectionId);
  const bountyExecutor = new BountyExecutor({
    boards: jiraBoards,
    runs: bountyRuns,
    proposals: bountyProposals,
    issues: jiraIssues,
    bounties,
    specs: bountySpecs,
    caller,
    modelUsage,
    clientFor: runClientFor,
    contextFor,
    syncContextFor: async (organizationId, bounty, userId) => {
      const synced = await syncGithub(
        { contexts: bountyContexts, githubContext },
        organizationId,
        bounty,
        userId,
      );
      if (!synced.ok && synced.status === 502)
        fault("bounty_context_sync_failed", synced.code);
    },
    outlinesFor: async (organizationId, held) => {
      const repos = await connectedRepositories(githubRepos, organizationId);
      const commits = heldCommits(held);
      const read = await Promise.all(
        repos.map(async (repo) => {
          const at = builtAt(
            await repoSnapshots.built(organizationId, repo.id),
            commits.get(repo.fullName),
          );
          return {
            repo,
            snapshot:
              at === null
                ? null
                : await repoSnapshots.get(organizationId, at.id),
          };
        }),
      );
      const outlined = read.flatMap(({ repo, snapshot }) =>
        snapshot === null ? [] : [{ repo, snapshot }],
      );
      const maxLines = outlineLinesEach(outlined.length);
      const maxChars = briefCharsEach(outlined.length);
      return Promise.all(
        outlined.map(async ({ repo, snapshot }) => {
          const brief = await readBrief(
            { runs: analysisRuns, artifacts, objects },
            organizationId,
            snapshot.id,
          ).catch(() => null);
          return {
            repoId: repo.id,
            fullName: repo.fullName,
            snapshotId: snapshot.id,
            text:
              brief === null
                ? repositoryOutline(snapshot.facts, {
                    languages: snapshot.languages,
                    maxLines,
                  })
                : cutBrief(brief, maxChars),
          };
        }),
      );
    },
    profilingEnabled: () => bountyProfiler !== undefined,
    onProposalDrafted: () => bountyProfiler?.kick(),
    profileFor: (organizationId, proposalId) =>
      bountyProfiles.latest(organizationId, proposalId),
    onBackgroundError: fault,
  });

  /** Every publication the sandbox routes announce. */
  const published = [];
  /** Every submission webhook event owed: `[organizationId, type, key, data]`. */
  const events = [];
  const emitEvent = (...event) => {
    events.push(event);
  };
  /** A GitHub delivery's work after its answer, which `settle()` awaits. */
  const deliveries = [];
  let sandboxCutter;
  let sandboxPreparer;
  const merges = createSubmissionMergeStore(db);
  const decisions = createDecisionConfirmationStore(db);
  const contributors = createContributorStore(db);
  const sandbox = {
    sandboxes: sandboxStore,
    cuts: sandboxStore,
    submissions,
    merges,
    // As server.ts: invited contributors, the secret in the link's fragment.
    contributors,
    inviteUrl: (token) => `${APP_URL}/invite#${token}`,
    // As server.ts builds it, with the writer on the fake GitHub.
    mergeBack: mergeBackTargets({
      repos: githubRepos,
      connections: githubConnections,
      installations,
      fetch: github.fetch,
    }),
    onSubmissionEvent: emitEvent,
    runs: analysisRuns,
    artifacts,
    objects,
    previews: analysisRuns,
    proposals: bountyProposals,
    specs: bountySpecs,
    // As server.ts: builds and publication check the frozen spec's decisions.
    decisions,
    decisionsConfirmUrl: async (organizationId, bountyId) =>
      decisionsConfirmUrl(
        APP_URL,
        (await organizations.get(organizationId))?.slug,
        organizationId,
        bountyId,
      ),
    bounties,
    repos: githubRepos,
    organizationNames: async (organizationId) => {
      const found = await organizations.get(organizationId);
      return found === undefined ? [] : [found.name, found.slug];
    },
    contextFor,
    profiles: bountyProfiles,
    requestProfile: async (owner, input) => {
      await bountyProfiler?.request(owner, input);
    },
    onSliceApproved: () => {
      sandboxCutter?.kick();
      sandboxPreparer?.kick();
    },
    onPublished: (organizationId, publication) =>
      published.push({ organizationId, ...publication }),
    ensureWorker: async () => {},
    maxActive: MAX_ACTIVE,
    onLaunchError: () => fault("analysis_worker_launch_failed"),
  };
  // As server.ts: merge-back's CI read-back, told by the webhook and swept.
  const mergeCi = new MergeCiTracker({
    merges,
    targets: sandbox.mergeBack,
    submissions,
    emit: emitEvent,
    onError: fault,
  });
  const rubricPricer = new RubricPricer({
    proposals: bountyProposals,
    profiles: bountyProfiles,
    specs: bountySpecs,
    onError: fault,
  });
  bountyProfiler = new BountyProfiler({
    profiles: bountyProfiles,
    runs: analysisRuns,
    artifacts,
    snapshots: repoSnapshots,
    specs: bountySpecs,
    ensureWorker: async () => {},
    removeObject: (key) => objects.remove(key),
    maxActive: MAX_ACTIVE,
    onSettled: async (owner, profile) => {
      try {
        await rubricPricer.settled(owner, profile);
      } finally {
        sandboxCutter?.kick();
        sandboxPreparer?.kick();
      }
    },
    onError: fault,
  });
  sandboxCutter = new SandboxCutter({
    sandboxes: sandboxStore,
    slice: versionService(sandbox).slice,
    onError: fault,
  });
  sandboxPreparer = new SandboxPreparer({
    profiles: bountyProfiles,
    runs: analysisRuns,
    artifacts,
    proposals: bountyProposals,
    bounties,
    sandboxes: sandboxStore,
    touchedSource: (owner, bountyId) => touchedSource(sandbox, owner, bountyId),
    decisionsRefusal: (owner, bountyId, proposal) =>
      versionService(sandbox).decisionsRefusal(
        owner,
        bountyId,
        proposal,
        "preparing the sandbox",
      ),
    slice: versionService(sandbox).slice,
    onError: fault,
  });

  const app = createApp({
    corsOrigins: [APP_URL],
    auth,
    emails,
    profiles,
    organizations,
    // The App's routes, on the fake GitHub; the analysis routes mount
    // with them, as in server.ts.
    github: {
      connections: githubConnections,
      grants: createGithubGrantStore(db, tokenCipher),
      repos: githubRepos,
      installations,
      snapshots: { store: repoSnapshots, snapshotter },
      appSlug: "lunox-flow",
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret,
      webhookSecret,
      mergeCi,
      background: (work) => {
        deliveries.push(
          work.catch((error) => fault("github_webhook_failed", error)),
        );
      },
      secret,
      apiUrl: API_URL,
      appUrl: APP_URL,
      fetch: github.fetch,
      onBackgroundError: fault,
    },
    analysis: {
      runs: analysisRuns,
      artifacts,
      repos: githubRepos,
      snapshots: repoSnapshots,
      objects,
      tree: (key) => snapshotter.tree(key),
      ensureWorker: async () => {},
      maxActive: MAX_ACTIVE,
      onLaunchError: () => fault("analysis_worker_launch_failed"),
      proposals: bountyProposals,
      specs: bountySpecs,
      boards: jiraBoards,
    },
    sandbox,
    pricing: {
      rateCards,
      runs: bountyRuns,
      boards: jiraBoards,
      proposals: bountyProposals,
      specs: bountySpecs,
      decisions,
      issues: jiraIssues,
      bounties,
      contexts: bountyContexts,
      repos: githubRepos,
      githubContext,
      profiles: bountyProfiles,
      connections: jiraConnections,
      writebacks: createBountyWritebackStore(db),
      appUrl: APP_URL,
      organizationSlug: async (organizationId) =>
        (await organizations.get(organizationId))?.slug,
      clientFor: runClientFor,
      executor: bountyExecutor,
      requestedModel: caller.model,
      promptVersion: JIRA_SIZE_PROMPT_VERSION,
      onApproved: () => sandboxPreparer.kick(),
      rescore: (owner, profile) => rubricPricer.settled(owner, profile),
    },
    settings: {
      settings: createWorkspaceSettingsStore(db),
      onChanged: () => sandboxPreparer.kick(),
    },
    apiTokens,
    contributorTokens,
    publicUrl: API_URL,
  });

  // The worker, as main.ts builds it, on the local-process provider.
  const tasks = createTaskReader(bountyProposals, bountySpecs);
  // One npm cache for every job, kept between runs when `npmCache` names
  // one, as main.ts keeps the worker's under its home.
  const provider = createLocalProcessProvider(
    npmCache === undefined ? {} : { npmCache },
  );
  const packageTypes = npmPackageTypes({
    root: join(scratch, "package-types"),
  });
  const agent = {
    model: agentModel,
    limits: { maxTurns: 20, maxTokens: 4_000_000 },
  };
  const agentFor = (run) => meteredAgent(agent, run, modelUsage, fault);
  const adapterFor = (run) => {
    switch (run.tool) {
      case "graphify":
        return createGraphifyAdapter({ execute: graphify });
      case "abstractions":
        return createAbstractionsAdapter();
      case "data_model":
        return createDataModelAdapter();
      case "documents":
        return createDocumentsAdapter();
      case "brief":
        return createBriefAdapter();
      case "slice":
        return createSliceAdapter({ packageTypes });
      case "sandbox_build":
        return createSandboxBuildAdapter({ agent: agentFor(run), provider });
      case "scope":
        return createScopeAdapter(agentFor(run), { packageTypes });
      case "fixtures":
        return createFixturesAdapter(agentFor(run));
      case "sandbox_starter":
        return createStarterAdapter({ agent: agentFor(run), provider });
      case "submission_grade":
        return createSubmissionGradeAdapter({ provider });
      case "sandbox_import":
        return createSandboxImportAdapter({ provider });
    }
    throw new Error(`No adapter for ${run.tool}.`);
  };
  /** Every run the worker ran, in order, with how it ended. */
  const ranRuns = [];
  /**
   * Called with each run as soon as the worker has claimed it, before it
   * runs: what a step reads of a run's `running` state.
   */
  const claimed = new Set();

  /** Claims and runs queued runs, one at a time, until none is claimable. */
  async function drainRuns() {
    let count = 0;
    for (;;) {
      const run = await analysisRuns.claimNext(randomUUID(), new Date());
      if (run === null) return count;
      for (const listener of claimed) await listener(run);
      const started = performance.now();
      await executeRun(run, {
        runs: analysisRuns,
        artifacts,
        sandboxes: sandboxStore,
        submissions,
        tasks,
        objects,
        tool: adapterFor(run),
        source: {
          maxBytes: 50 * 1024 * 1024,
          maxFiles: 20_000,
          // The archive is in the bucket; a run that asks GitHub fails.
          token: async () => {
            throw new Error("The flow's worker never downloads from GitHub.");
          },
        },
      });
      const ended = await analysisRuns.get(run.organizationId, run.id);
      ranRuns.push({
        id: run.id,
        tool: run.tool,
        status: ended?.status,
        errorCode: ended?.errorCode ?? null,
        errorDetail: ended?.errorDetail ?? null,
        ms: Math.round(performance.now() - started),
      });
      log(
        `worker: ${run.tool} ${ended?.status}${ended?.errorCode ? ` (${ended.errorCode})` : ""} in ${Math.round(performance.now() - started)} ms`,
      );
      if (ended?.status === "failed") {
        // The run's own log, which says why: its last lines.
        const key = await analysisRuns
          .logKey(run.organizationId, run.id)
          .catch(() => null);
        const bytes = key === null ? undefined : await objects.get(key);
        if (bytes !== undefined)
          log(
            `worker:   ${Buffer.from(bytes).toString("utf8").split("\n").slice(-25).join("\n  ")}`,
          );
      }
      count += 1;
    }
  }

  /**
   * The platform's background work, until nothing moves: the profiler,
   * cutter and preparer each swept, then every queued run run, again and
   * again until a pass runs nothing.
   */
  async function settle(maxPasses = 25) {
    for (let pass = 0; pass < maxPasses; pass += 1) {
      await Promise.all(deliveries.splice(0));
      await mergeCi.sweep();
      await bountyProfiler.sweep();
      await sandboxCutter.sweep();
      await sandboxPreparer.sweep(true);
      if ((await drainRuns()) === 0) return;
    }
    throw new Error(`The platform did not settle in ${maxPasses} passes.`);
  }

  /** A sizing run, waited on until it ends. */
  async function waitForBountyRun(organizationId, runId, timeoutMs = 60_000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const run = await bountyRuns.get(organizationId, runId);
      if (run !== null && !["queued", "running"].includes(run.status))
        return run;
      if (Date.now() > until)
        throw new Error(`Sizing run ${runId} did not end.`);
      await delay(50);
    }
  }

  return {
    app,
    db,
    stores: {
      organizations,
      apiTokens,
      contributorTokens,
      githubConnections,
      githubRepos,
      repoSnapshots,
      analysisRuns,
      artifacts,
      sandboxes: sandboxStore,
      bountyProfiles,
      bountyProposals,
      modelUsage,
      submissions,
      merges,
      contributors,
      jiraConnections,
      jiraBoards,
    },
    snapshotter,
    objects,
    published,
    events,
    webhookSecret,
    mergeCi,
    faults,
    ranRuns,
    claimed,
    drainRuns,
    settle,
    waitForBountyRun,
    async close() {
      await Promise.allSettled([
        bountyProfiler.stop(),
        sandboxCutter.stop(),
        sandboxPreparer.stop(),
        snapshotter.stop(),
      ]);
      await connection.close();
      // The provider's own lockfile store; the named npm cache is kept.
      await provider.dispose();
      await rm(scratch, { recursive: true, force: true });
    },
  };
}
