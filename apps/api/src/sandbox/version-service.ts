import {
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
 * parameters carry every hash the output must bind to. Nothing here is
 * public; publication is phase 5D.
 */

import type { StoredArtifact, StoredSandbox } from "@sandbox-factory/db";
import {
  createSandboxVersionSchema,
  fixtureSetSchema,
} from "@sandbox-factory/shared";
import { createHash } from "node:crypto";
import type {
  AcceptanceTest,
  AliasRule,
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
  resolveScope,
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
  return sha256(
    canonicalJson({
      schemaVersion: 2,
      aliasRules: input.aliasRules,
      dependencyChoices: input.dependencyChoices,
      acceptanceTests: input.acceptanceTests,
      fixtures: input.fixtures ?? null,
    }),
  );
}

export function approvedTaskHash(snapshot: ApprovedTaskSnapshot): string {
  return sha256(canonicalJson(snapshot));
}

/** The owner is the path's; it is not repeated in the body. */

const failure = <T extends object>(
  body: T,
  reason: "invalid" | "not-found" | "conflict" | "unavailable",
) => ({ ok: false as const, body, reason });
function unknownChoices(
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
function fixturesRefused(error: FixturesFailure) {
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
function invalidFixtures(
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

export function versionService(options: SandboxRouteOptions) {
  /** The slice run's manifest and contract, verified against their recorded hashes. */
  async function sliceInputs(owner: string, sliceRunId: string) {
    const run = await options.runs.get(owner, sliceRunId);
    if (run === null || run.tool !== "slice")
      return { error: "not_found" } as const;
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
    if (input.proposalId !== undefined) {
      const proposal = await options.proposals.get(owner, input.proposalId);
      if (proposal === null)
        return failure({ error: "Not found." }, "not-found");
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
      ticketIds: sandbox.ticketIds,
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
        sourceSnapshotId: inputs.run.snapshotId,
        sliceRunId: inputs.run.id,
        manifestSha256: inputs.manifestSha256,
        contractSha256: inputs.contractSha256,
        transformConfigSha256: transformConfigHash({ ...input, fixtures }),
        approvedTaskSha256: approvedTaskHash(approvedTask),
        approvedTask,
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
        : failure({ error: "Not found." }, "not-found");
    return { ok: true as const, result };
  }
  return { sliceInputs, fixturesFromRun, create };
}
