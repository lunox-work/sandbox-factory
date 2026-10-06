import type { SandboxRouteOptions } from "./options.js";
import { transformConfigHash, versionService } from "./version-service.js";
export type { SandboxRouteOptions } from "./options.js";
export { approvedTaskHash, transformConfigHash } from "./version-service.js";
/**
 * Sandboxes and their versions, for the owning organization.
 *
 * A version is cut from a succeeded slice run: the route reads the run's
 * manifest and contract from private storage, verifies their hashes,
 * snapshots the approved task from the live proposal and spec, validates
 * the alias table, resolves the scope and writes the private provenance
 * in one store call. The build route queues a `sandbox_build` run whose
 * parameters carry every hash the output must bind to. A sandbox with no
 * repository has its versions generated instead: the starter route queues
 * an agent run that writes one from the bounty and builds it. Nothing here
 * is public; publication is phase 5D.
 */

import type {
  StoredSandbox,
  StoredVersionSource,
  StoredVersionWithSource,
} from "@sandbox-factory/db";
import {
  analysisRunResponseSchema,
  createSandboxSchema,
  createSandboxVersionSchema,
  generateStarterResponseSchema,
  publishVersionResponseSchema,
  publishVersionSchema,
  linkSandboxSourceSchema,
  replayResponseSchema,
  SANDBOX_FILE_TEXT_MAX_BYTES,
  sandboxFileContentSchema,
  sandboxFileListSchema,
  sandboxListSchema,
  sandboxResponseSchema,
  sandboxVersionListSchema,
  sandboxVersionResponseSchema,
  updateSandboxVersionSchema,
} from "@sandbox-factory/shared";
import type { Context, Hono } from "hono";
import type {
  BoundaryContract,
  DependencyChoice,
  SandboxFixture,
  SliceManifest,
} from "sandbox-factory";
import {
  approvedTaskReadiness,
  fixtureProblems,
  replayOf,
  resolveScope,
  unknownDependencyChoices,
  validateAliasRules,
} from "sandbox-factory";
import { rankAtLeast } from "../access.js";
import type { AuthVariables } from "../http-context.js";

const sandboxDto = ({ organizationId: _owner, ...dto }: StoredSandbox) => dto;
const sourceDto = (source: StoredVersionSource) => ({
  sandboxVersionId: source.sandboxVersionId,
  origin: source.origin,
  sourceSnapshotId: source.sourceSnapshotId,
  sourceCommitSha: source.sourceCommitSha,
  sliceRunId: source.sliceRunId,
  manifestSha256: source.manifestSha256,
  contractSha256: source.contractSha256,
  starterRunId: source.starterRunId,
  starterSha256: source.starterSha256,
  transformConfigSha256: source.transformConfigSha256,
  approvedTaskSha256: source.approvedTaskSha256,
  proposalVersion: source.proposalVersion,
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

/** UTF-8 text, or null for bytes a text view cannot show. */
function textOf(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

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

/** A store refusal to make a sandbox or link its repository. */
function sandboxRefused(
  c: Context,
  reason:
    | "not-found"
    | "bounty_not_found"
    | "bounty_has_sandbox"
    | "source_linked"
    | "repo_not_found"
    | "repo_role",
): Response {
  if (reason === "repo_role")
    return c.json(
      {
        error: "Only a source repository can back a sandbox.",
        code: "repo_role",
      },
      409,
    );
  if (reason === "bounty_has_sandbox")
    return c.json(
      { error: "This bounty already has a sandbox.", code: reason },
      409,
    );
  if (reason === "source_linked")
    return c.json(
      {
        error: "This sandbox is already cut from another repository.",
        code: reason,
      },
      409,
    );
  // Told apart from a missing bounty: a bounty can name a repository that
  // has since been disconnected, and is otherwise refused with no hint.
  if (reason === "repo_not_found")
    return c.json(
      {
        error: "The repository is not connected to this workspace any more.",
        code: reason,
      },
      404,
    );
  return reason === "bounty_not_found"
    ? c.json({ error: "Not found.", code: reason }, 404)
    : c.json({ error: "Not found." }, 404);
}

/**
 * A generated version is written and built by its starter run, in one go:
 * its transform has nothing to slice again, so it changes by generating a
 * new version instead.
 */
function generatedRefused(c: Context, what: string): Response {
  return c.json(
    {
      error: `A generated version's ${what} comes from its starter run; generate a new version instead.`,
      code: "generated_version",
    },
    409,
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

  const service = versionService(options);
  const { sliceInputs, fixturesFromRun } = service;

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
    if (!result.ok) return sandboxRefused(c, result.reason);
    return c.json(
      sandboxResponseSchema.parse({ sandbox: sandboxDto(result.sandbox) }),
      201,
    );
  });
  // A sandbox made without a repository gets one here, once.
  app.put(`${base}/:id/source`, async (c) => {
    if (!admin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can link a sandbox's repository." },
        403,
      );
    const body = linkSandboxSourceSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!body.success)
      return c.json({ error: "Invalid sandbox request." }, 400);
    const result = await options.sandboxes.linkSource(
      c.req.param("orgId"),
      c.req.param("id"),
      body.data.sourceRepoId,
    );
    if (!result.ok) return sandboxRefused(c, result.reason);
    return c.json(
      sandboxResponseSchema.parse({ sandbox: sandboxDto(result.sandbox) }),
    );
  });
  /**
   * A generated version, for a sandbox with no repository: the starter
   * agent writes it from the bounty and builds it. Answers with the draft
   * and its run, which the caller follows to see it finish.
   */
  app.post(`${base}/:id/starter`, async (c) => {
    if (!admin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can generate a version." },
        403,
      );
    const owner = c.req.param("orgId");
    const sandbox = await options.sandboxes.get(owner, c.req.param("id"));
    if (sandbox === null) return c.json({ error: "Not found." }, 404);
    const generated = await service.generate(
      owner,
      c.get("user").id,
      sandbox,
      now(),
    );
    if (!generated.ok) {
      const status = {
        invalid: 400,
        "not-found": 404,
        conflict: 409,
        unavailable: 502,
      } as const;
      return c.json(generated.body, status[generated.reason]);
    }
    await options.ensureWorker().catch(() => options.onLaunchError?.());
    return c.json(
      generateStarterResponseSchema.parse({
        version: generated.result.version,
        source: sourceDto(generated.result.source),
        run: generated.run,
      }),
      202,
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
    const created = await service.create(
      owner,
      c.get("user").id,
      sandbox,
      body.data,
      now(),
    );
    if (!created.ok) {
      const status = {
        invalid: 400,
        "not-found": 404,
        conflict: 409,
        unavailable: 502,
      } as const;
      return c.json(created.body, status[created.reason]);
    }
    return c.json(versionResponse(created.result, true), 201);
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
    const sliceRunId = current.source.sliceRunId;
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
    if (transformChanged && sliceRunId === null)
      return generatedRefused(c, "transform");
    let scope = current.source.scope;
    let fixtures = current.source.fixtures;
    const needsSlice =
      body.data.dependencyChoices !== undefined ||
      body.data.fixtures !== undefined ||
      typeof body.data.fixtureRunId === "string";
    if (needsSlice && sliceRunId !== null) {
      const inputs = await sliceInputs(owner, sliceRunId);
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
          sliceRunId,
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
   * Publishes a version: approves and freezes it, and makes it the
   * sandbox's published version until the date given, which must be
   * ahead. Only a version whose build passed, of a bounty whose proposal is
   * approved. No public repository is pushed yet; publication marks the
   * version contributors are to get.
   */
  app.post(`${base}/versions/:vid/publish`, async (c) => {
    if (!admin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can publish a version." },
        403,
      );
    const parsed = publishVersionSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json({ error: "Give the date the publication expires." }, 400);
    const at = now();
    const expiresAt = new Date(parsed.data.expiresAt);
    if (expiresAt.getTime() <= at.getTime())
      return c.json(
        {
          error: "The expiry date must be in the future.",
          code: "expiry_past",
        },
        400,
      );
    const result = await options.sandboxes.publishVersion(
      c.req.param("orgId"),
      c.req.param("vid"),
      c.get("user").id,
      expiresAt,
      at,
    );
    if (!result.ok)
      return result.reason === "not_ready"
        ? c.json(
            {
              error: "Only a version whose build passed can be published.",
              code: "not_ready",
            },
            409,
          )
        : result.reason === "bounty_not_approved"
          ? c.json(
              {
                error:
                  "This version was not built from an approved bounty, so it cannot be published.",
                code: "bounty_not_approved",
              },
              409,
            )
          : c.json({ error: "Not found." }, 404);
    return c.json(
      publishVersionResponseSchema.parse({
        sandbox: sandboxDto(result.sandbox),
        version: result.version.version,
        source: sourceDto(result.version.source),
      }),
    );
  });

  /** Back to a draft with no published version; versions stay frozen. */
  app.post(`${base}/:id/unpublish`, async (c) => {
    if (!admin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can unpublish a sandbox." },
        403,
      );
    const sandbox = await options.sandboxes.unpublish(
      c.req.param("orgId"),
      c.req.param("id"),
      now(),
    );
    return sandbox === null
      ? c.json({ error: "Not found." }, 404)
      : c.json(sandboxResponseSchema.parse({ sandbox: sandboxDto(sandbox) }));
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
    const { sourceSnapshotId, sliceRunId, manifestSha256, contractSha256 } =
      stored.source;
    if (
      sourceSnapshotId === null ||
      sliceRunId === null ||
      manifestSha256 === null ||
      contractSha256 === null
    )
      return generatedRefused(c, "build");
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
    const result = await options.runs.enqueue(owner, sourceSnapshotId, {
      tool: "sandbox_build",
      params: {
        deadlineMinutes: 30,
        sliceRunId,
        sandboxVersionId: stored.version.id,
        manifestSha256,
        contractSha256,
        transformConfigSha256: stored.source.transformConfigSha256,
        approvedTaskSha256: stored.source.approvedTaskSha256,
      },
      requestedBy: c.get("user").id,
      maxActive: options.maxActive ?? 3,
    });
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

  /**
   * The private sandbox a version's build wrote: the project, its hidden
   * tests and the build's own records, read-only. Owners and admins only,
   * since the hidden tests are among them.
   */
  app.get(`${base}/versions/:vid/files`, async (c) => {
    if (!admin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can read a version's files." },
        403,
      );
    const owner = c.req.param("orgId");
    const stored = await options.sandboxes.getVersion(
      owner,
      c.req.param("vid"),
    );
    if (stored === null) return c.json({ error: "Not found." }, 404);
    const runId = stored.source.buildRunId;
    const run = runId === null ? null : await options.runs.get(owner, runId);
    const files =
      run === null ? [] : await options.artifacts.list(owner, run.id);
    c.header("Cache-Control", "no-store");
    return c.json(
      sandboxFileListSchema.parse({
        run: run === null ? null : { id: run.id, status: run.status },
        files: files.map(({ path, sizeBytes, sha256 }) => ({
          path,
          sizeBytes,
          sha256,
        })),
      }),
    );
  });
  /**
   * One of those files as text. Read through the API rather than a signed
   * link, which the browser could not read across origins; named by its
   * path, matched against what the run recorded, never joined into a key.
   */
  app.get(`${base}/versions/:vid/files/content`, async (c) => {
    if (!admin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can read a version's files." },
        403,
      );
    const owner = c.req.param("orgId");
    const path = c.req.query("path");
    if (path === undefined || path === "")
      return c.json({ error: "Name a file with `path`." }, 400);
    const stored = await options.sandboxes.getVersion(
      owner,
      c.req.param("vid"),
    );
    const runId = stored?.source.buildRunId ?? null;
    if (runId === null) return c.json({ error: "Not found." }, 404);
    const file = (await options.artifacts.list(owner, runId)).find(
      (item) => item.path === path,
    );
    if (file === undefined) return c.json({ error: "Not found." }, 404);
    c.header("Cache-Control", "no-store");
    const answer = (
      text: string | null,
      omitted: "binary" | "too_large" | null,
    ) =>
      c.json(
        sandboxFileContentSchema.parse({
          path: file.path,
          sizeBytes: file.sizeBytes,
          text,
          omitted,
        }),
      );
    if (file.sizeBytes > SANDBOX_FILE_TEXT_MAX_BYTES)
      return answer(null, "too_large");
    const bytes = await options.objects.get(file.objectKey);
    if (bytes === undefined)
      return c.json(
        {
          error: "The file could not be read.",
          code: "artifacts_unavailable",
        },
        502,
      );
    const text = textOf(bytes);
    return text === null ? answer(null, "binary") : answer(text, null);
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
