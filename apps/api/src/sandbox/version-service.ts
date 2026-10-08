import {
  AGENT_DEADLINE_MINUTES,
  boundaryContractSchema,
  sliceManifestSchema,
} from "@sandbox-factory/shared";
/**
 * Sandboxes and their versions, for the owning organization.
 *
 * A version is cut from a succeeded slice run: the route reads the run's
 * manifest and contract from private storage, verifies their hashes,
 * snapshots the approved task from the live proposal and spec, validates
 * the alias table, resolves the scope and writes the private provenance
 * in one store call. The build route queues a `sandbox_build` run whose
 * parameters carry every hash the output must bind to. A sandbox with no
 * repository has its versions generated: `generate` snapshots the task
 * from the bounty itself and queues the starter agent, which writes the
 * version and builds it. A version is published by the routes, which
 * check its build; nothing in this module makes anything public.
 */

import type {
  StoredAnalysisRun,
  StoredArtifact,
  StoredBounty,
  StoredSandbox,
  StoredVersionWithSource,
} from "@sandbox-factory/db";
import { generateId } from "@sandbox-factory/db";
import {
  createSandboxVersionSchema,
  fixtureSetSchema,
} from "@sandbox-factory/shared";
import { createHash } from "node:crypto";
import type {
  AcceptanceTest,
  AliasRule,
  ApprovedTaskContext,
  ApprovedTaskSnapshot,
  BoundaryContract,
  DependencyChoice,
  SandboxFixture,
  SliceManifest,
  VersionFixtures,
} from "sandbox-factory";
import {
  APPROVED_TASK_SCHEMA_VERSION,
  canonicalJson,
  fixtureProblems,
  isFixturesParams,
  normalizeStack,
  resolveScope,
  starterStackProblem,
  starterTaskReadiness,
  transformConfigOf,
  unknownDependencyChoices,
  validateAliasRules,
} from "sandbox-factory";

import type { z } from "zod";
import type { SandboxRouteOptions } from "./options.js";
const sha256 = (text: string | Uint8Array) =>
  createHash("sha256").update(text).digest("hex");

/** The canonical transform, hashed into `transformConfigSha256`. */
export function transformConfigHash(input: {
  readonly aliasRules: readonly AliasRule[];
  readonly dependencyChoices: Readonly<Record<string, DependencyChoice>>;
  readonly acceptanceTests: readonly AcceptanceTest[];
  readonly fixtures?: VersionFixtures | null;
}): string {
  return sha256(canonicalJson(transformConfigOf(input)));
}

/** Text cut to `max` characters, never inside a surrogate pair. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}
/** What a version's listing may carry, as a sliced version's request bounds it. */
const GENERATED_TITLE_MAX = 120;
const GENERATED_SUMMARY_MAX = 4_000;
const GENERATED_TAGS_MAX = 10;
const GENERATED_TAG_MAX = 32;
/** What a generated version starts with, until its run settles the rest. */
const EMPTY_SCOPE = {
  editablePaths: [],
  generatedPaths: [],
  permittedOperations: ["edit", "add"],
  dependencies: [],
  blockers: [],
} as const;

export function approvedTaskHash(snapshot: ApprovedTaskSnapshot): string {
  return sha256(canonicalJson(snapshot));
}

/** The owner is the path's; it is not repeated in the body. */

type FailureReason = "invalid" | "not-found" | "conflict" | "unavailable";
/** A refusal, as its body and a reason the routes answer with a status. */
export interface Failure {
  readonly ok: false;
  readonly body: object;
  readonly reason: FailureReason;
}
/** The status each refusal is answered with. */
export const FAILURE_STATUS = {
  invalid: 400,
  "not-found": 404,
  conflict: 409,
  unavailable: 502,
} as const satisfies Record<FailureReason, number>;
const failure = <T extends object>(body: T, reason: FailureReason) => ({
  ok: false as const,
  body,
  reason,
});
/** A dependency choice must name a package the slice requires. */
export function unknownChoices(
  manifest: SliceManifest,
  choices: Readonly<Record<string, DependencyChoice>>,
) {
  const names = unknownDependencyChoices(manifest, choices);
  return names.length === 0
    ? null
    : failure(
        {
          error:
            "A dependency choice names a package the slice does not require.",
          code: "dependency_choice_unknown",
          names,
        },
        "invalid",
      );
}

export type FixturesFailure =
  | "not_found"
  | "fixtures_not_ready"
  | "fixtures_mismatch"
  | "artifacts_unavailable";
/** Why fixtures could not be copied from a run, as the API reports it. */
export function fixturesRefused(error: FixturesFailure) {
  if (error === "not_found")
    return failure({ error: "Not found." }, "not-found");
  if (error === "fixtures_not_ready")
    return failure(
      {
        error: "The fixtures run has not succeeded.",
        code: "fixtures_not_ready",
      },
      "conflict",
    );
  if (error === "fixtures_mismatch")
    return failure(
      {
        error: "The fixtures were written for a different slice.",
        code: "fixtures_mismatch",
      },
      "conflict",
    );
  return failure(
    {
      error: "The fixture set could not be read.",
      code: "artifacts_unavailable",
    },
    "unavailable",
  );
}
/** Fixtures must name values the version's slice mocks. */
export function invalidFixtures(
  fixtures: readonly SandboxFixture[],
  contract: BoundaryContract,
) {
  const problems = fixtureProblems(fixtures, contract.outbound);
  return problems.length === 0
    ? null
    : failure(
        {
          error: "The fixtures do not fit the slice.",
          code: "fixtures_invalid",
          problems,
        },
        "invalid",
      );
}

const starterInProgress = () =>
  failure(
    {
      error:
        "A version of this sandbox is already being generated. Wait for it to finish.",
      code: "starter_in_progress",
    },
    "conflict",
  );

export function versionService(options: SandboxRouteOptions) {
  /**
   * The context the bounty holds now, as a version's task freezes it: each
   * source's latest synced version, with what it said.
   */
  async function taskContext(
    owner: string,
    bounty: StoredBounty | string,
  ): Promise<ApprovedTaskContext> {
    const read = options.contextFor;
    if (read === undefined) return { jira: null, github: null };
    const found =
      typeof bounty === "string"
        ? await options.bounties.get(owner, bounty)
        : bounty;
    if (found === null) return { jira: null, github: null };
    const held = await read(owner, found);
    return {
      jira:
        held.jira === null
          ? null
          : { version: held.jira.version, content: held.jira.content },
      github:
        held.github === null
          ? null
          : { version: held.github.version, content: held.github.content },
    };
  }

  /** The slice run's manifest and contract, verified against their recorded hashes. */
  async function sliceInputs(owner: string, sliceRunId: string) {
    const run = await options.runs.get(owner, sliceRunId);
    if (run === null || run.tool !== "slice" || run.snapshotId === null)
      return { error: "not_found" } as const;
    const snapshotId = run.snapshotId;
    if (run.status !== "succeeded")
      return { error: "slice_not_ready" } as const;
    const artifacts = await options.artifacts.list(owner, run.id);
    const read = async (kind: StoredArtifact["kind"]) => {
      const artifact = artifacts.find((item) => item.kind === kind);
      if (artifact === undefined) return null;
      const bytes = await options.objects.get(artifact.objectKey);
      if (bytes === undefined || sha256(bytes) !== artifact.sha256) return null;
      return { artifact, text: Buffer.from(bytes).toString("utf8") };
    };
    const manifest = await read("slice_manifest");
    const contract = await read("boundary_contract");
    if (manifest === null || contract === null)
      return { error: "artifacts_unavailable" } as const;
    try {
      return {
        run,
        snapshotId,
        manifest: sliceManifestSchema.parse(JSON.parse(manifest.text)),
        manifestSha256: manifest.artifact.sha256,
        contract: boundaryContractSchema.parse(JSON.parse(contract.text)),
        contractSha256: contract.artifact.sha256,
      } as const;
    } catch {
      return { error: "artifacts_unavailable" } as const;
    }
  }

  /** A succeeded fixtures run's set, written for the given slice run. */
  async function fixturesFromRun(
    owner: string,
    fixtureRunId: string,
    sliceRunId: string,
  ): Promise<{ fixtures: VersionFixtures } | { error: FixturesFailure }> {
    const run = await options.runs.get(owner, fixtureRunId);
    if (run === null || !isFixturesParams(run.params))
      return { error: "not_found" };
    if (run.status !== "succeeded") return { error: "fixtures_not_ready" };
    if (run.params.sliceRunId !== sliceRunId)
      return { error: "fixtures_mismatch" };
    const artifact = (await options.artifacts.list(owner, run.id)).find(
      (item) => item.kind === "fixture_set",
    );
    if (artifact === undefined) return { error: "artifacts_unavailable" };
    const bytes = await options.objects.get(artifact.objectKey);
    if (bytes === undefined || sha256(bytes) !== artifact.sha256)
      return { error: "artifacts_unavailable" };
    let parsed;
    try {
      parsed = fixtureSetSchema.safeParse(
        JSON.parse(Buffer.from(bytes).toString("utf8")),
      );
    } catch {
      return { error: "artifacts_unavailable" };
    }
    if (!parsed.success) return { error: "artifacts_unavailable" };
    return {
      fixtures: {
        fixtureRunId: run.id,
        fixtures: parsed.data.fixtures,
        scenario: parsed.data.scenario,
      },
    };
  }

  async function create(
    owner: string,
    actor: string,
    sandbox: StoredSandbox,
    input: z.infer<typeof createSandboxVersionSchema>,
    now: Date,
  ) {
    // A version is a slice, and a slice needs a repository; the sandbox
    // itself does not, so this is where its absence is refused.
    if (sandbox.sourceRepoId === null)
      return failure(
        {
          error: "The sandbox has no repository to slice from.",
          code: "no_source",
        },
        "conflict",
      );
    const aliases = validateAliasRules(input.aliasRules);
    if (!aliases.ok)
      return failure(
        {
          error: "Alias rules are invalid.",
          code: "alias_rules_invalid",
          problems: aliases.problems,
        },
        "invalid",
      );
    const inputs = await sliceInputs(owner, input.sliceRunId);
    if ("error" in inputs)
      return inputs.error === "not_found"
        ? failure({ error: "Not found." }, "not-found")
        : inputs.error === "slice_not_ready"
          ? failure(
              {
                error: "The slice run has not succeeded.",
                code: "slice_not_ready",
              },
              "conflict",
            )
          : failure(
              {
                error: "The slice artifacts could not be read.",
                code: "artifacts_unavailable",
              },
              "unavailable",
            );
    const unknown = unknownChoices(inputs.manifest, input.dependencyChoices);
    if (unknown !== null) return unknown;
    let fixtures: VersionFixtures | null = null;
    if (input.fixtureRunId !== undefined) {
      const copied = await fixturesFromRun(
        owner,
        input.fixtureRunId,
        inputs.run.id,
      );
      if ("error" in copied) return fixturesRefused(copied.error);
      const invalid = invalidFixtures(
        copied.fixtures.fixtures,
        inputs.contract,
      );
      if (invalid !== null) return invalid;
      fixtures = copied.fixtures;
    }
    let spec: ApprovedTaskSnapshot["spec"] = null;
    let pricing: ApprovedTaskSnapshot["pricing"] = null;
    // The bounty version the task is taken from, while it is approved.
    let proposalVersion: number | null = null;
    if (input.proposalId !== undefined) {
      const proposal = await options.proposals.get(owner, input.proposalId);
      if (proposal === null)
        return failure({ error: "Not found." }, "not-found");
      // The frozen task names this sandbox's bounty, so its spec and price
      // must be that bounty's; a hash would otherwise bind one bounty's
      // name to another's terms.
      if (proposal.bountyId !== sandbox.bountyId)
        return failure(
          {
            error: "The proposal is for a different bounty.",
            code: "proposal_mismatch",
          },
          "conflict",
        );
      const revision = input.specRevision ?? proposal.specRevision;
      if (revision !== null) {
        const stored = await options.specs.get(owner, proposal.id, revision);
        if (stored === null)
          return failure(
            {
              error: "The spec revision does not exist.",
              code: "spec_not_found",
            },
            "not-found",
          );
        spec = {
          proposalId: proposal.id,
          specRevision: stored.revision,
          specHash: stored.specHash,
          draft: stored.draft,
        };
      }
      if (proposal.status === "approved") proposalVersion = proposal.version;
      pricing = {
        proposalId: proposal.id,
        proposalRevision: proposal.revision,
        complexity: proposal.complexity,
        amountMinor: proposal.amountMinor,
        currency: proposal.currency,
        status: proposal.status,
        decidedAt: proposal.decidedAt,
      };
    }
    const approvedTask: ApprovedTaskSnapshot = {
      schemaVersion: APPROVED_TASK_SCHEMA_VERSION,
      title: input.title,
      summary: input.specSummary,
      spec,
      pricing,
      selectedBy: actor,
      selectedAt: now.toISOString(),
      bountyId: sandbox.bountyId,
      context: await taskContext(owner, sandbox.bountyId),
    };
    const scope = resolveScope({
      manifest: inputs.manifest,
      contract: inputs.contract,
      choices: input.dependencyChoices,
    });
    const result = await options.sandboxes.createVersion(owner, sandbox.id, {
      title: input.title,
      specSummary: input.specSummary,
      complexity: input.complexity,
      tags: input.tags,
      source: {
        sourceSnapshotId: inputs.snapshotId,
        sliceRunId: inputs.run.id,
        manifestSha256: inputs.manifestSha256,
        contractSha256: inputs.contractSha256,
        transformConfigSha256: transformConfigHash({ ...input, fixtures }),
        approvedTaskSha256: approvedTaskHash(approvedTask),
        approvedTask,
        proposalVersion,
        aliasRules: input.aliasRules,
        dependencyChoices: input.dependencyChoices,
        acceptanceTests: input.acceptanceTests,
        fixtures,
        scope,
      },
    });
    if (!result.ok)
      return result.reason === "slice_mismatch"
        ? failure(
            {
              error: "The slice run does not describe this sandbox's source.",
              code: "slice_mismatch",
            },
            "conflict",
          )
        : result.reason === "no_source"
          ? failure(
              {
                error: "The sandbox has no repository to slice from.",
                code: "no_source",
              },
              "conflict",
            )
          : failure({ error: "Not found." }, "not-found");
    return { ok: true as const, result };
  }

  /**
   * A generated version: the task snapshotted from the bounty's own title
   * and description, with its live proposal's spec and price, and the
   * starter agent queued to write and build it. The proposal must be
   * approved: a bounty with none, or a draft one, is refused
   * `task_not_ready`, and so is a second one while another version's
   * starter is queued or running, `starter_in_progress`. The run is
   * queued first, naming the version's id, and the version is then made
   * pointing at it; a version that could not be made leaves a run whose
   * version does not exist, which the worker fails.
   */
  async function generate(
    owner: string,
    actor: string,
    sandbox: StoredSandbox,
    now: Date,
  ): Promise<
    | ReturnType<typeof failure>
    | {
        ok: true;
        result: StoredVersionWithSource;
        run: StoredAnalysisRun;
      }
  > {
    if (sandbox.sourceRepoId !== null)
      return failure(
        {
          error:
            "This sandbox is cut from its repository; slice a version instead.",
          code: "source_linked",
        },
        "conflict",
      );
    // One version is generated at a time. Each run names a version of its
    // own, so a second Generate, a double click, never matches the first in
    // the queue and would make a second version. While the newest version's
    // starter is still under way, that is refused; the store checks again
    // under the sandbox's lock, for two requests that pass here together.
    const newest = (await options.sandboxes.listVersions(owner, sandbox.id))[0];
    const latest =
      newest === undefined
        ? null
        : await options.sandboxes.getVersion(owner, newest.id);
    const starterRunId = latest?.source.starterRunId ?? null;
    const starter =
      starterRunId === null
        ? null
        : await options.runs.get(owner, starterRunId);
    if (starter?.status === "queued" || starter?.status === "running")
      return starterInProgress();
    const bounty = await options.bounties.get(owner, sandbox.bountyId);
    if (bounty === null) return failure({ error: "Not found." }, "not-found");
    // The stack it follows: what the bounty's repository was detected to
    // use, if it names one, and what the bounty adds.
    const repo =
      bounty.repoId === null
        ? null
        : await options.repos.get(owner, bounty.repoId);
    const stack = normalizeStack([...(repo?.stack ?? []), ...bounty.stack]);
    const unsupported = starterStackProblem(stack);
    if (unsupported !== null)
      return failure(
        { error: unsupported, code: "stack_unsupported" },
        "conflict",
      );
    let spec: ApprovedTaskSnapshot["spec"] = null;
    let pricing: ApprovedTaskSnapshot["pricing"] = null;
    // The bounty version the task is taken from, while it is approved.
    let proposalVersion: number | null = null;
    const proposalId = await options.proposals.liveForBounty(owner, bounty.id);
    const proposal =
      proposalId === null
        ? null
        : await options.proposals.get(owner, proposalId);
    if (proposal !== null) {
      const stored =
        proposal.specRevision === null
          ? null
          : await options.specs.get(owner, proposal.id, proposal.specRevision);
      if (stored !== null)
        spec = {
          proposalId: proposal.id,
          specRevision: stored.revision,
          specHash: stored.specHash,
          draft: stored.draft,
        };
      if (proposal.status === "approved") proposalVersion = proposal.version;
      pricing = {
        proposalId: proposal.id,
        proposalRevision: proposal.revision,
        complexity: proposal.complexity,
        amountMinor: proposal.amountMinor,
        currency: proposal.currency,
        status: proposal.status,
        decidedAt: proposal.decidedAt,
      };
    }
    const approvedTask: ApprovedTaskSnapshot = {
      schemaVersion: APPROVED_TASK_SCHEMA_VERSION,
      title: bounty.title,
      summary: bounty.description,
      spec,
      pricing,
      selectedBy: actor,
      selectedAt: now.toISOString(),
      bountyId: bounty.id,
      // What its sources add, which the starter agent is shown too.
      context: await taskContext(owner, bounty),
    };
    const task = starterTaskReadiness(approvedTask);
    if (!task.ready)
      return failure(
        {
          error: "The bounty is not ready to generate from.",
          code: "task_not_ready",
          reasons: task.reasons,
        },
        "conflict",
      );
    const approvedTaskSha256 = approvedTaskHash(approvedTask);
    const versionId = generateId("sbv");
    const queued = await options.runs.enqueue(owner, null, {
      tool: "sandbox_starter",
      params: {
        deadlineMinutes: AGENT_DEADLINE_MINUTES,
        agent: "starter",
        sandboxVersionId: versionId,
        approvedTaskSha256,
        stack,
      },
      requestedBy: actor,
      maxActive: options.maxActive ?? 3,
    });
    if (!queued.ok)
      return queued.reason === "run_limit"
        ? failure(
            {
              error: "The active analysis limit has been reached.",
              code: "run_limit",
            },
            "conflict",
          )
        : failure({ error: "Not found." }, "not-found");
    if (queued.obsoleteLogKey !== undefined)
      await options.objects.remove(queued.obsoleteLogKey).catch(() => {});
    const acceptanceTests: AcceptanceTest[] = [];
    const created = await options.sandboxes.createVersion(
      owner,
      sandbox.id,
      {
        id: versionId,
        title: clip(bounty.title.trim(), GENERATED_TITLE_MAX),
        specSummary: clip(bounty.description.trim(), GENERATED_SUMMARY_MAX),
        complexity: proposal?.complexity ?? "unsized",
        tags: stack
          .filter((name) => name.length <= GENERATED_TAG_MAX)
          .slice(0, GENERATED_TAGS_MAX),
        source: {
          origin: "starter",
          starterRunId: queued.run.id,
          transformConfigSha256: transformConfigHash({
            aliasRules: [],
            dependencyChoices: {},
            acceptanceTests,
          }),
          approvedTaskSha256,
          approvedTask,
          proposalVersion,
          aliasRules: [],
          dependencyChoices: {},
          acceptanceTests,
          scope: EMPTY_SCOPE,
        },
      },
      now,
    );
    if (!created.ok)
      return created.reason === "source_linked"
        ? failure(
            {
              error:
                "This sandbox is cut from its repository; slice a version instead.",
              code: "source_linked",
            },
            "conflict",
          )
        : created.reason === "starter_in_progress"
          ? starterInProgress()
          : failure({ error: "Not found." }, "not-found");
    return { ok: true as const, result: created, run: queued.run };
  }
  return { sliceInputs, fixturesFromRun, create, generate };
}
