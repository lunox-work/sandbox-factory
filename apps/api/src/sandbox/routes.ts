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

import { createHash } from "node:crypto";
import type {
  AnalysisRunStore,
  ArtifactStore,
  BountyProposalStore,
  BountySpecStore,
  ObjectStore,
  SandboxStore,
  StoredArtifact,
  StoredSandbox,
  StoredVersionSource,
  StoredVersionWithSource,
} from "@sandbox-factory/db";
import {
  analysisRunResponseSchema,
  createSandboxSchema,
  fixtureSetSchema,
  createSandboxVersionSchema,
  replayResponseSchema,
  sandboxListSchema,
  sandboxResponseSchema,
  sandboxVersionListSchema,
  sandboxVersionResponseSchema,
  updateSandboxVersionSchema,
} from "@sandbox-factory/shared";
import {
  APPROVED_TASK_SCHEMA_VERSION,
  approvedTaskReadiness,
  canonicalJson,
  fixtureProblems,
  isFixturesParams,
  replayOf,
  resolveScope,
  unknownDependencyChoices,
  validateAliasRules,
} from "sandbox-factory";
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
import type { Context, Hono } from "hono";
import { rankAtLeast } from "../routes.js";
import type { AuthVariables } from "../routes.js";

export interface SandboxRouteOptions {
  readonly sandboxes: SandboxStore;
  readonly runs: Pick<AnalysisRunStore, "get" | "enqueue">;
  readonly artifacts: Pick<ArtifactStore, "list">;
  readonly objects: Pick<ObjectStore, "get" | "remove">;
  readonly proposals: Pick<BountyProposalStore, "get">;
  readonly specs: Pick<BountySpecStore, "get">;
  readonly ensureWorker: () => Promise<void>;
  readonly maxActive?: number;
  readonly onLaunchError?: () => void;
  readonly now?: () => Date;
}

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
const sandboxDto = ({ organizationId: _owner, ...dto }: StoredSandbox) => dto;
const sourceDto = (source: StoredVersionSource) => ({
  sandboxVersionId: source.sandboxVersionId,
  sourceSnapshotId: source.sourceSnapshotId,
  sourceCommitSha: source.sourceCommitSha,
  sliceRunId: source.sliceRunId,
  manifestSha256: source.manifestSha256,
  contractSha256: source.contractSha256,
  transformConfigSha256: source.transformConfigSha256,
  approvedTaskSha256: source.approvedTaskSha256,
  aliasRules: source.aliasRules,
  dependencyChoices: source.dependencyChoices,
  acceptanceTests: source.acceptanceTests,
  fixtures: source.fixtures,
  approvedTask: source.approvedTask,
  scope: source.scope,
  harnessSha256: source.harnessSha256,
  toolchainDigest: source.toolchainDigest,
  buildRunId: source.buildRunId,
  roundTripRunId: source.roundTripRunId,
  disclosureRunId: source.disclosureRunId,
  approvedBy: source.approvedBy,
  approvedAt: source.approvedAt,
  createdAt: source.createdAt,
  updatedAt: source.updatedAt,
});
const versionResponse = (
  stored: StoredVersionWithSource,
  privileged: boolean,
) =>
  sandboxVersionResponseSchema.parse({
    version: stored.version,
    ...(privileged ? { source: sourceDto(stored.source) } : {}),
  });

/** A dependency choice must name a package the slice requires. */
function unknownChoices(
  c: Context,
  manifest: SliceManifest,
  choices: Readonly<Record<string, DependencyChoice>>,
): Response | null {
  const names = unknownDependencyChoices(manifest, choices);
  return names.length === 0
    ? null
    : c.json(
        {
          error:
            "A dependency choice names a package the slice does not require.",
          code: "dependency_choice_unknown",
          names,
        },
        400,
      );
}

type FixturesFailure =
  | "not_found"
  | "fixtures_not_ready"
  | "fixtures_mismatch"
  | "artifacts_unavailable";
/** Why fixtures could not be copied from a run, as the API reports it. */
function fixturesRefused(c: Context, error: FixturesFailure): Response {
  if (error === "not_found") return c.json({ error: "Not found." }, 404);
  if (error === "fixtures_not_ready")
    return c.json(
      {
        error: "The fixtures run has not succeeded.",
        code: "fixtures_not_ready",
      },
      409,
    );
  if (error === "fixtures_mismatch")
    return c.json(
      {
        error: "The fixtures were written for a different slice.",
        code: "fixtures_mismatch",
      },
      409,
    );
  return c.json(
    {
      error: "The fixture set could not be read.",
      code: "artifacts_unavailable",
    },
    502,
  );
}
/** Fixtures must name values the version's slice mocks. */
function invalidFixtures(
  c: Context,
  fixtures: readonly SandboxFixture[],
  contract: BoundaryContract,
): Response | null {
  const problems = fixtureProblems(fixtures, contract.outbound);
  return problems.length === 0
    ? null
    : c.json(
        {
          error: "The fixtures do not fit the slice.",
          code: "fixtures_invalid",
          problems,
        },
        400,
      );
}

/** A store refusal of a draft change, as the API reports it. */
function refused(
  c: Context,
  reason: "not-found" | "frozen" | "conflict",
): Response {
  if (reason === "frozen")
    return c.json(
      {
        error: "A frozen version cannot change; create a new version.",
        code: "frozen",
      },
      409,
    );
  if (reason === "conflict")
    return c.json(
      {
        error: "The version changed in the meantime. Reload it and try again.",
        code: "version_changed",
      },
      409,
    );
  return c.json({ error: "Not found." }, 404);
}

export function mountSandboxRoutes(
  app: Hono<{ Variables: AuthVariables }>,
  options: SandboxRouteOptions,
): void {
  const base = "/api/v1/orgs/:orgId/sandboxes";
  const now = options.now ?? (() => new Date());
  const admin = (role: string) => rankAtLeast(role, "admin");

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
        manifest: JSON.parse(manifest.text) as SliceManifest,
        manifestSha256: manifest.artifact.sha256,
        contract: JSON.parse(contract.text) as BoundaryContract,
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

  app.post(base, async (c) => {
    if (!admin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can create a sandbox." },
        403,
      );
    const body = createSandboxSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!body.success)
      return c.json({ error: "Invalid sandbox request." }, 400);
    const result = await options.sandboxes.create(
      c.req.param("orgId"),
      body.data,
    );
    if (!result.ok)
      return result.reason === "repo_role"
        ? c.json(
            {
              error: "Only a source repository can back a sandbox.",
              code: "repo_role",
            },
            409,
          )
        : c.json({ error: "Not found." }, 404);
    return c.json(
      sandboxResponseSchema.parse({ sandbox: sandboxDto(result.sandbox) }),
      201,
    );
  });
  app.get(base, async (c) =>
    c.json(
      sandboxListSchema.parse({
        sandboxes: (await options.sandboxes.list(c.req.param("orgId"))).map(
          sandboxDto,
        ),
      }),
    ),
  );
  app.get(`${base}/versions/:vid`, async (c) => {
    const stored = await options.sandboxes.getVersion(
      c.req.param("orgId"),
      c.req.param("vid"),
    );
    return stored === null
      ? c.json({ error: "Not found." }, 404)
      : c.json(versionResponse(stored, admin(c.get("member").role)));
  });
  app.get(`${base}/:id`, async (c) => {
    const sandbox = await options.sandboxes.get(
      c.req.param("orgId"),
      c.req.param("id"),
    );
    return sandbox === null
      ? c.json({ error: "Not found." }, 404)
      : c.json(sandboxResponseSchema.parse({ sandbox: sandboxDto(sandbox) }));
  });
  app.get(`${base}/:id/versions`, async (c) => {
    const owner = c.req.param("orgId");
    const sandboxId = c.req.param("id");
    if ((await options.sandboxes.get(owner, sandboxId)) === null)
      return c.json({ error: "Not found." }, 404);
    return c.json(
      sandboxVersionListSchema.parse({
        versions: await options.sandboxes.listVersions(owner, sandboxId),
      }),
    );
  });

  /**
   * A draft version: provenance pinned to the slice run's exact artifacts,
   * the approved task copied from the proposal and spec as they are now.
   */
  app.post(`${base}/:id/versions`, async (c) => {
    if (!admin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can create a version." },
        403,
      );
    const owner = c.req.param("orgId");
    const sandbox = await options.sandboxes.get(owner, c.req.param("id"));
    if (sandbox === null) return c.json({ error: "Not found." }, 404);
    const body = createSandboxVersionSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!body.success)
      return c.json({ error: "Invalid version request." }, 400);
    const aliases = validateAliasRules(body.data.aliasRules);
    if (!aliases.ok)
      return c.json(
        {
          error: "Alias rules are invalid.",
          code: "alias_rules_invalid",
          problems: aliases.problems,
        },
        400,
      );
    const inputs = await sliceInputs(owner, body.data.sliceRunId);
    if ("error" in inputs)
      return inputs.error === "not_found"
        ? c.json({ error: "Not found." }, 404)
        : inputs.error === "slice_not_ready"
          ? c.json(
              {
                error: "The slice run has not succeeded.",
                code: "slice_not_ready",
              },
              409,
            )
          : c.json(
              {
                error: "The slice artifacts could not be read.",
                code: "artifacts_unavailable",
              },
              502,
            );
    const unknown = unknownChoices(
      c,
      inputs.manifest,
      body.data.dependencyChoices,
    );
    if (unknown !== null) return unknown;
    let fixtures: VersionFixtures | null = null;
    if (body.data.fixtureRunId !== undefined) {
      const copied = await fixturesFromRun(
        owner,
        body.data.fixtureRunId,
        inputs.run.id,
      );
      if ("error" in copied) return fixturesRefused(c, copied.error);
      const invalid = invalidFixtures(
        c,
        copied.fixtures.fixtures,
        inputs.contract,
      );
      if (invalid !== null) return invalid;
      fixtures = copied.fixtures;
    }
    let spec: ApprovedTaskSnapshot["spec"] = null;
    let pricing: ApprovedTaskSnapshot["pricing"] = null;
    if (body.data.proposalId !== undefined) {
      const proposal = await options.proposals.get(owner, body.data.proposalId);
      if (proposal === null) return c.json({ error: "Not found." }, 404);
      const revision = body.data.specRevision ?? proposal.specRevision;
      if (revision !== null) {
        const stored = await options.specs.get(owner, proposal.id, revision);
        if (stored === null)
          return c.json(
            {
              error: "The spec revision does not exist.",
              code: "spec_not_found",
            },
            404,
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
      title: body.data.title,
      summary: body.data.specSummary,
      spec,
      pricing,
      selectedBy: c.get("user").id,
      selectedAt: now().toISOString(),
      ticketIds: sandbox.ticketIds,
    };
    const scope = resolveScope({
      manifest: inputs.manifest,
      contract: inputs.contract,
      choices: body.data.dependencyChoices,
    });
    const result = await options.sandboxes.createVersion(owner, sandbox.id, {
      title: body.data.title,
      specSummary: body.data.specSummary,
      complexity: body.data.complexity,
      tags: body.data.tags,
      source: {
        sourceSnapshotId: inputs.run.snapshotId,
        sliceRunId: inputs.run.id,
        manifestSha256: inputs.manifestSha256,
        contractSha256: inputs.contractSha256,
        transformConfigSha256: transformConfigHash({ ...body.data, fixtures }),
        approvedTaskSha256: approvedTaskHash(approvedTask),
        approvedTask,
        aliasRules: body.data.aliasRules,
        dependencyChoices: body.data.dependencyChoices,
        acceptanceTests: body.data.acceptanceTests,
        fixtures,
        scope,
      },
    });
    if (!result.ok)
      return result.reason === "slice_mismatch"
        ? c.json(
            {
              error: "The slice run does not describe this sandbox's source.",
              code: "slice_mismatch",
            },
            409,
          )
        : c.json({ error: "Not found." }, 404);
    return c.json(versionResponse(result, true), 201);
  });

  /**
   * Draft changes. The transform hash follows the rules; evidence is
   * invalidated by the store. A transform change is merged onto the row as
   * read here, so the store refuses it if another change landed in between.
   */
  app.patch(`${base}/versions/:vid`, async (c) => {
    if (!admin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can change a version." },
        403,
      );
    const owner = c.req.param("orgId");
    const versionId = c.req.param("vid");
    const body = updateSandboxVersionSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!body.success) return c.json({ error: "Invalid version change." }, 400);
    const current = await options.sandboxes.getVersion(owner, versionId);
    if (current === null) return c.json({ error: "Not found." }, 404);
    const aliasRules = body.data.aliasRules ?? current.source.aliasRules;
    const dependencyChoices =
      body.data.dependencyChoices ?? current.source.dependencyChoices;
    const acceptanceTests =
      body.data.acceptanceTests ?? current.source.acceptanceTests;
    const aliases = validateAliasRules(aliasRules);
    if (!aliases.ok)
      return c.json(
        {
          error: "Alias rules are invalid.",
          code: "alias_rules_invalid",
          problems: aliases.problems,
        },
        400,
      );
    const fixturesChanged =
      body.data.fixtureRunId !== undefined || body.data.fixtures !== undefined;
    const transformChanged =
      body.data.aliasRules !== undefined ||
      body.data.dependencyChoices !== undefined ||
      body.data.acceptanceTests !== undefined ||
      fixturesChanged;
    let scope = current.source.scope;
    let fixtures = current.source.fixtures;
    const needsSlice =
      body.data.dependencyChoices !== undefined ||
      body.data.fixtures !== undefined ||
      typeof body.data.fixtureRunId === "string";
    if (needsSlice) {
      const inputs = await sliceInputs(owner, current.source.sliceRunId);
      if ("error" in inputs)
        return c.json(
          {
            error: "The slice artifacts could not be read.",
            code: "artifacts_unavailable",
          },
          502,
        );
      if (body.data.dependencyChoices !== undefined) {
        const unknown = unknownChoices(c, inputs.manifest, dependencyChoices);
        if (unknown !== null) return unknown;
        scope = resolveScope({
          manifest: inputs.manifest,
          contract: inputs.contract,
          choices: dependencyChoices,
        });
      }
      if (typeof body.data.fixtureRunId === "string") {
        const copied = await fixturesFromRun(
          owner,
          body.data.fixtureRunId,
          current.source.sliceRunId,
        );
        if ("error" in copied) return fixturesRefused(c, copied.error);
        fixtures = copied.fixtures;
      } else if (body.data.fixtures !== undefined)
        fixtures = { fixtureRunId: null, ...body.data.fixtures };
      if (fixtures !== null) {
        const invalid = invalidFixtures(c, fixtures.fixtures, inputs.contract);
        if (invalid !== null) return invalid;
      }
    }
    if (body.data.fixtureRunId === null) fixtures = null;
    const result = await options.sandboxes.updateDraft(
      owner,
      versionId,
      {
        ...(body.data.title === undefined ? {} : { title: body.data.title }),
        ...(body.data.specSummary === undefined
          ? {}
          : { specSummary: body.data.specSummary }),
        ...(body.data.complexity === undefined
          ? {}
          : { complexity: body.data.complexity }),
        ...(body.data.tags === undefined ? {} : { tags: body.data.tags }),
        ...(transformChanged
          ? {
              expectedTransformConfigSha256:
                current.source.transformConfigSha256,
              aliasRules,
              dependencyChoices,
              acceptanceTests,
              ...(fixturesChanged ? { fixtures } : {}),
              transformConfigSha256: transformConfigHash({
                aliasRules,
                dependencyChoices,
                acceptanceTests,
                fixtures,
              }),
              scope,
            }
          : {}),
      },
      now(),
    );
    if (!result.ok) return refused(c, result.reason);
    return c.json(versionResponse(result, true));
  });

  /**
   * Queues the build. Its parameters are the version's hashes, so a changed
   * draft is a new run. A draft changed between the read and the record
   * leaves a queued run with stale hashes, which the worker rejects.
   */
  app.post(`${base}/versions/:vid/build`, async (c) => {
    if (!admin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can build a version." },
        403,
      );
    const owner = c.req.param("orgId");
    const stored = await options.sandboxes.getVersion(
      owner,
      c.req.param("vid"),
    );
    if (stored === null) return c.json({ error: "Not found." }, 404);
    if (stored.version.frozenAt !== null)
      return c.json(
        { error: "A frozen version is not rebuilt.", code: "frozen" },
        409,
      );
    const task = approvedTaskReadiness(stored.source.approvedTask);
    if (!task.ready)
      return c.json(
        {
          error: "The approved task is not ready to build.",
          code: "task_not_ready",
          reasons: task.reasons,
        },
        409,
      );
    if (stored.source.scope.blockers.length > 0)
      return c.json(
        {
          error: "The scope has blockers.",
          code: "scope_blocked",
          blockers: stored.source.scope.blockers,
        },
        409,
      );
    const result = await options.runs.enqueue(
      owner,
      stored.source.sourceSnapshotId,
      {
        tool: "sandbox_build",
        params: {
          deadlineMinutes: 30,
          sliceRunId: stored.source.sliceRunId,
          sandboxVersionId: stored.version.id,
          manifestSha256: stored.source.manifestSha256,
          contractSha256: stored.source.contractSha256,
          transformConfigSha256: stored.source.transformConfigSha256,
          approvedTaskSha256: stored.source.approvedTaskSha256,
        },
        requestedBy: c.get("user").id,
        maxActive: options.maxActive ?? 3,
      },
    );
    if (!result.ok)
      return result.reason === "run_limit"
        ? c.json(
            {
              error: "The active analysis limit has been reached.",
              code: "run_limit",
            },
            409,
          )
        : c.json({ error: "Not found." }, 404);
    if (result.obsoleteLogKey !== undefined)
      await options.objects.remove(result.obsoleteLogKey).catch(() => {});
    const recorded = await options.sandboxes.recordBuild(
      owner,
      stored.version.id,
      result.run.id,
      stored.source.transformConfigSha256,
      now(),
    );
    if (!recorded.ok) return refused(c, recorded.reason);
    await options.ensureWorker().catch(() => options.onLaunchError?.());
    return c.json(analysisRunResponseSchema.parse({ run: result.run }), 202);
  });

  /** What a replay would use. Never the current branch head. */
  app.get(`${base}/versions/:vid/replay`, async (c) => {
    if (!admin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can read provenance." },
        403,
      );
    const context = await options.sandboxes.replayContext(
      c.req.param("orgId"),
      c.req.param("vid"),
    );
    if (context === null) return c.json({ error: "Not found." }, 404);
    return c.json(
      replayResponseSchema.parse(
        replayOf(context.source, context.snapshot, context.sliceRun),
      ),
    );
  });
}
