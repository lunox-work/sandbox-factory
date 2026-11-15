import type { SandboxRouteOptions } from "./options.js";
import type { Failure } from "./version-service.js";
import {
  FAILURE_STATUS,
  fixturesRefused,
  invalidFixtures,
  transformConfigHash,
  unknownChoices,
  versionService,
} from "./version-service.js";
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
 * an agent run that writes one from the bounty and builds it. Publishing
 * makes a built version the sandbox's current one until a date; no public
 * repository is pushed yet.
 */

import type {
  StoredSandbox,
  StoredVersionSource,
  StoredVersionWithSource,
} from "@sandbox-factory/db";
import {
  analysisRunResponseSchema,
  approveSliceSchema,
  createSandboxSchema,
  createSandboxVersionSchema,
  generateStarterResponseSchema,
  publishVersionResponseSchema,
  publishVersionSchema,
  replayResponseSchema,
  SANDBOX_FILE_TEXT_MAX_BYTES,
  sandboxFileContentSchema,
  sandboxFileListSchema,
  createUploadSchema,
  submissionFilesResponseSchema,
  uploadResponseSchema,
  UPLOAD_BODY_MAX_BYTES,
  mergeBackStatusResponseSchema,
  mergeSubmissionSchema,
  submissionListSchema,
  submissionResponseSchema,
  type MergeBackStatusDto,
  sandboxListSchema,
  sandboxResponseSchema,
  sandboxSliceResponseSchema,
  sandboxVersionListSchema,
  sandboxVersionResponseSchema,
  sliceVersionResponseSchema,
  startSandboxResponseSchema,
  updateSandboxVersionSchema,
} from "@sandbox-factory/shared";
import type { Context, Hono } from "hono";
import { inWebSession } from "../analysis/routes.js";
import {
  replayOf,
  resolveScope,
  stepHeldBy,
  stepHeldReason,
  validateAliasRules,
} from "sandbox-factory";
import { isAtLeastAdmin } from "../access.js";
import { connectedRepositories } from "../bounties/held-context.js";
import type { AuthVariables } from "../http-context.js";
import { textOf } from "../object-text.js";
import { setRetryAfter } from "../quota.js";
import { createHash } from "node:crypto";
import {
  layoutOf,
  organizationNames,
  parseSubmittedFiles,
  uploadObjectKey,
  workspaceVocabulary,
  type SandboxBuildManifest,
} from "sandbox-factory";
import { generateId } from "@sandbox-factory/db";
import { bodyLimit } from "hono/body-limit";
import { changedSubmissionFiles, checkUpload } from "./uploads.js";
import {
  archiveResponse,
  handoutFilesResponse,
  handoutResponse,
} from "./handout.js";
import { mountContributorRoutes } from "./contributors.js";
import { zip } from "./zip.js";
import {
  gradeSubmission,
  receiveFiles,
  RETRY_REFUSALS,
  submissionOf,
  type SubmissionContributor,
} from "./submission-service.js";
import { folderBodyLimit, receiveFolder } from "./folder-upload.js";
import type {
  StoredSubmission,
  StoredSubmissionMerge,
} from "@sandbox-factory/db";
import { BranchConflictError, GithubAuthError } from "@sandbox-factory/github";

const sandboxDto = ({ organizationId: _owner, ...dto }: StoredSandbox) => dto;
/**
 * A version's source as the API answers it. `hideTests` (any credential but
 * a person's web session: how an agent reaches the platform) answers its
 * hidden tests as none, as the handout does: an agent that could read them
 * could pass them without the work.
 */
const sourceDto = (source: StoredVersionSource, hideTests: boolean) => ({
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
  contextVersions: { ...source.contextVersions },
  aliasRules: source.aliasRules,
  dependencyChoices: source.dependencyChoices,
  acceptanceTests: hideTests ? [] : source.acceptanceTests,
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
  hideTests: boolean,
) =>
  sandboxVersionResponseSchema.parse({
    version: stored.version,
    ...(privileged ? { source: sourceDto(stored.source, hideTests) } : {}),
  });

/** A refusal the version service settled on, answered with its status. */
const failed = (c: Context, refusal: Failure): Response => {
  if (refusal.reason === "quota") setRetryAfter(c, refusal.body);
  return c.json(refusal.body, FAILURE_STATUS[refusal.reason]);
};

/**
 * The repository a bounty's sandbox is cut from: the one its live
 * proposal's sizing said the work touches, while the workspace still has
 * it. Null when it touches none, which a generated version is for, or
 * several, which are generated from until they can be cut together.
 */
export async function touchedSource(
  options: Pick<SandboxRouteOptions, "proposals" | "repos">,
  owner: string,
  bountyId: string,
): Promise<string | null> {
  const proposalId = await options.proposals.liveForBounty(owner, bountyId);
  const proposal =
    proposalId === null ? null : await options.proposals.get(owner, proposalId);
  if (proposal === null || proposal.repositories.length === 0) return null;
  const connected = new Set(
    (await connectedRepositories(options.repos, owner)).map(({ id }) => id),
  );
  const touched = proposal.repositories.filter(({ repoId }) =>
    connected.has(repoId),
  );
  const [only] = touched;
  return touched.length === 1 && only !== undefined ? only.repoId : null;
}

export { matchesEtag } from "./handout.js";

/**
 * A grading run's `private/merge-patch.json`, or null when it is not
 * JSON of that shape: a base commit and whole files by path.
 */
export function mergePatchOf(bytes: Uint8Array): {
  commitSha: string;
  files: { path: string; text: string }[];
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return null;
  }
  const { commitSha, files } = (parsed ?? {}) as {
    commitSha?: unknown;
    files?: unknown;
  };
  if (
    typeof commitSha !== "string" ||
    !/^[0-9a-f]{4,64}$/.test(commitSha) ||
    !Array.isArray(files) ||
    !files.every(
      (file: unknown) =>
        typeof file === "object" &&
        file !== null &&
        typeof (file as { path?: unknown }).path === "string" &&
        (file as { path: string }).path !== "" &&
        typeof (file as { text?: unknown }).text === "string",
    )
  )
    return null;
  return {
    commitSha,
    files: (files as { path: string; text: string }[]).map(
      ({ path, text }) => ({ path, text }),
    ),
  };
}

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
        error: "This sandbox is already sliced from another repository.",
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

/**
 * The request body limit for an upload, answered in this API's shape
 * before the body is read. `createApp` mounts it ahead of the idempotency
 * middleware, which reads the body to hash it; here it guards the route
 * wherever it is mounted.
 */
export const uploadBodyLimit = bodyLimit({
  maxSize: UPLOAD_BODY_MAX_BYTES,
  onError: (c) =>
    c.json(
      {
        error: `An upload is at most ${UPLOAD_BODY_MAX_BYTES} bytes.`,
        code: "upload_too_large",
      },
      413,
    ),
});
export const UPLOADS_ROUTE = "/api/v1/orgs/:orgId/sandboxes/uploads";

export function mountSandboxRoutes(
  app: Hono<{ Variables: AuthVariables }>,
  options: SandboxRouteOptions,
): void {
  const base = "/api/v1/orgs/:orgId/sandboxes";
  const now = options.now ?? (() => new Date());

  const service = versionService(options);
  const { sliceInputs, fixturesFromRun } = service;

  /*
    A sandbox is changed only while its bounty's scope and price stand
    approved: the refusal, or null when they do. Unpublishing is the way
    back, and is never held. A bounty gone is answered by the route.
  */
  const held = async (owner: string, bountyId: string) => {
    const bounty = await options.bounties.get(owner, bountyId);
    if (bounty === null) return null;
    const proposalId = await options.proposals.liveForBounty(owner, bountyId);
    const proposal =
      proposalId === null
        ? null
        : await options.proposals.get(owner, proposalId);
    const heldBy = stepHeldBy("sandbox", bounty, proposal);
    return heldBy === null
      ? null
      : {
          code: "step_held",
          heldBy,
          error: stepHeldReason("sandbox", heldBy),
        };
  };
  // The same, for a version, by the sandbox it belongs to.
  const versionHeld = async (owner: string, sandboxId: string) => {
    const sandbox = await options.sandboxes.get(owner, sandboxId);
    return sandbox === null ? null : held(owner, sandbox.bountyId);
  };

  app.post(base, async (c) => {
    if (!isAtLeastAdmin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can create a sandbox." },
        403,
      );
    const body = createSandboxSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!body.success)
      return c.json({ error: "Invalid sandbox request." }, 400);
    const owner = c.get("member").organizationId;
    const refusal = await held(owner, body.data.bountyId);
    if (refusal !== null) return c.json(refusal, 409);
    const result = await options.sandboxes.create(owner, {
      bountyId: body.data.bountyId,
      sourceRepoId: await touchedSource(options, owner, body.data.bountyId),
    });
    if (!result.ok) return sandboxRefused(c, result.reason);
    return c.json(
      sandboxResponseSchema.parse({ sandbox: sandboxDto(result.sandbox) }),
      201,
    );
  });
  /**
   * A bounty's sandbox made and its first version begun, in one step: the
   * sandbox itself has nothing to choose, its repository being its
   * sizing's. With one, a version is sliced as `/:id/slice` slices it;
   * without, it is generated as `/:id/starter` generates it. A refusal
   * after the sandbox is made leaves it made, for its own routes to go on
   * from.
   */
  app.post(`${base}/start`, async (c) => {
    if (!isAtLeastAdmin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can create a sandbox." },
        403,
      );
    const body = createSandboxSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!body.success)
      return c.json({ error: "Invalid sandbox request." }, 400);
    const owner = c.get("member").organizationId;
    const refusal = await held(owner, body.data.bountyId);
    if (refusal !== null) return c.json(refusal, 409);
    // Its first version would be refused on unconfirmed decisions: refused
    // here, before the sandbox is made, so nothing is left half made.
    const proposalId = await options.proposals.liveForBounty(
      owner,
      body.data.bountyId,
    );
    const undecided = await service.decisionsRefusal(
      owner,
      body.data.bountyId,
      proposalId === null
        ? null
        : await options.proposals.get(owner, proposalId),
      "starting the sandbox",
    );
    if (undecided !== null) return failed(c, undecided);
    const made = await options.sandboxes.create(owner, {
      bountyId: body.data.bountyId,
      sourceRepoId: await touchedSource(options, owner, body.data.bountyId),
    });
    if (!made.ok) return sandboxRefused(c, made.reason);
    const { sandbox } = made;
    const actor = c.get("user").id;
    if (sandbox.sourceRepoId === null) {
      const generated = await service.generate(owner, actor, sandbox, now());
      if (!generated.ok) return failed(c, generated);
      await options.ensureWorker().catch(() => options.onLaunchError?.());
      return c.json(
        startSandboxResponseSchema.parse({
          sandbox: sandboxDto(sandbox),
          slice: null,
          version: generated.result.version,
          source: sourceDto(generated.result.source, !inWebSession(c)),
          run: generated.run,
        }),
        201,
      );
    }
    const sliced = await service.slice(owner, actor, sandbox, now());
    if (!sliced.ok) return failed(c, sliced);
    return c.json(
      startSandboxResponseSchema.parse({
        sandbox: sandboxDto(sandbox),
        slice: sliced.slice,
        version: sliced.result?.version ?? null,
        source:
          sliced.result === null
            ? null
            : sourceDto(sliced.result.source, !inWebSession(c)),
        run: sliced.run,
      }),
      201,
    );
  });
  /*
    A sandbox made without a repository gets one here, once: the one its
    bounty's sizing has since said the work touches.
  */
  app.put(`${base}/:id/source`, async (c) => {
    if (!isAtLeastAdmin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can link a sandbox's repository." },
        403,
      );
    const owner = c.get("member").organizationId;
    const sandbox = await options.sandboxes.get(owner, c.req.param("id"));
    if (sandbox === null) return c.json({ error: "Not found." }, 404);
    const refusal = await held(owner, sandbox.bountyId);
    if (refusal !== null) return c.json(refusal, 409);
    const sourceRepoId = await touchedSource(options, owner, sandbox.bountyId);
    if (sourceRepoId === null)
      return c.json(
        {
          error:
            "A sandbox is cut from the one connected repository the bounty's sizing says its work touches. It is not sized yet, or names none or several.",
          code: "no_touched_repository",
        },
        409,
      );
    const result = await options.sandboxes.linkSource(
      owner,
      sandbox.id,
      sourceRepoId,
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
    if (!isAtLeastAdmin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can generate a version." },
        403,
      );
    const owner = c.get("member").organizationId;
    const sandbox = await options.sandboxes.get(owner, c.req.param("id"));
    if (sandbox === null) return c.json({ error: "Not found." }, 404);
    const refusal = await held(owner, sandbox.bountyId);
    if (refusal !== null) return c.json(refusal, 409);
    const generated = await service.generate(
      owner,
      c.get("user").id,
      sandbox,
      now(),
    );
    if (!generated.ok) return failed(c, generated);
    await options.ensureWorker().catch(() => options.onLaunchError?.());
    return c.json(
      generateStarterResponseSchema.parse({
        version: generated.result.version,
        source: sourceDto(generated.result.source, !inWebSession(c)),
        run: generated.run,
      }),
      202,
    );
  });
  /**
   * Where a linked sandbox's next slice stands: its sizing's profile of
   * the approved spec revision in its repository. Owners and admins only,
   * as the runs behind it are private provenance.
   */
  app.get(`${base}/:id/slice`, async (c) => {
    if (!isAtLeastAdmin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can read a sandbox's slice." },
        403,
      );
    const owner = c.get("member").organizationId;
    const sandbox = await options.sandboxes.get(owner, c.req.param("id"));
    if (sandbox === null) return c.json({ error: "Not found." }, 404);
    const state = await service.sliceState(owner, sandbox);
    return c.json(sandboxSliceResponseSchema.parse({ slice: state.slice }));
  });
  /**
   * A sliced version, for a linked sandbox: cut from its sizing's slice
   * once that is ready, and built. Until then, the slice is asked for and
   * answered with where it stands, 202, for the caller to follow.
   */
  app.post(`${base}/:id/slice`, async (c) => {
    if (!isAtLeastAdmin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can slice a version." },
        403,
      );
    const owner = c.get("member").organizationId;
    const sandbox = await options.sandboxes.get(owner, c.req.param("id"));
    if (sandbox === null) return c.json({ error: "Not found." }, 404);
    const refusal = await held(owner, sandbox.bountyId);
    if (refusal !== null) return c.json(refusal, 409);
    const sliced = await service.slice(owner, c.get("user").id, sandbox, now());
    if (!sliced.ok) return failed(c, sliced);
    return c.json(
      sliceVersionResponseSchema.parse({
        slice: sliced.slice,
        version: sliced.result?.version ?? null,
        source:
          sliced.result === null
            ? null
            : sourceDto(sliced.result.source, !inWebSession(c)),
        run: sliced.run,
      }),
      sliced.result === null ? 202 : 201,
    );
  });
  /**
   * Approves the slice a linked sandbox's sizing waits on: one wider than
   * the profiler cuts unasked, named exactly as `GET .../slice` showed it.
   * The profile is then built from it and a version cut and built, as the
   * approver. Owners and admins only.
   */
  app.post(`${base}/:id/slice/approve`, async (c) => {
    if (!isAtLeastAdmin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can approve a slice." },
        403,
      );
    const owner = c.get("member").organizationId;
    const sandbox = await options.sandboxes.get(owner, c.req.param("id"));
    if (sandbox === null) return c.json({ error: "Not found." }, 404);
    const refusal = await held(owner, sandbox.bountyId);
    if (refusal !== null) return c.json(refusal, 409);
    const body = approveSliceSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!body.success) return c.json({ error: "Invalid slice approval." }, 400);
    const approved = await service.approveSlice(
      owner,
      c.get("user").id,
      sandbox,
      body.data,
      now(),
    );
    if (!approved.ok) return failed(c, approved);
    return c.json(sandboxSliceResponseSchema.parse({ slice: approved.slice }));
  });
  app.get(base, async (c) =>
    c.json(
      sandboxListSchema.parse({
        sandboxes: (
          await options.sandboxes.list(c.get("member").organizationId)
        ).map(sandboxDto),
      }),
    ),
  );
  app.get(`${base}/versions/:vid`, async (c) => {
    const stored = await options.sandboxes.getVersion(
      c.get("member").organizationId,
      c.req.param("vid"),
    );
    return stored === null
      ? c.json({ error: "Not found." }, 404)
      : c.json(
          versionResponse(
            stored,
            isAtLeastAdmin(c.get("member").role),
            !inWebSession(c),
          ),
        );
  });
  app.get(`${base}/:id`, async (c) => {
    const sandbox = await options.sandboxes.get(
      c.get("member").organizationId,
      c.req.param("id"),
    );
    return sandbox === null
      ? c.json({ error: "Not found." }, 404)
      : c.json(sandboxResponseSchema.parse({ sandbox: sandboxDto(sandbox) }));
  });
  app.get(`${base}/:id/versions`, async (c) => {
    const owner = c.get("member").organizationId;
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
    if (!isAtLeastAdmin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can create a version." },
        403,
      );
    const owner = c.get("member").organizationId;
    const sandbox = await options.sandboxes.get(owner, c.req.param("id"));
    if (sandbox === null) return c.json({ error: "Not found." }, 404);
    const refusal = await held(owner, sandbox.bountyId);
    if (refusal !== null) return c.json(refusal, 409);
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
    if (!created.ok) return failed(c, created);
    return c.json(versionResponse(created.result, true, !inWebSession(c)), 201);
  });

  /**
   * Draft changes. The transform hash follows the rules; evidence is
   * invalidated by the store. A transform change is merged onto the row as
   * read here, so the store refuses it if another change landed in between.
   */
  app.patch(`${base}/versions/:vid`, async (c) => {
    if (!isAtLeastAdmin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can change a version." },
        403,
      );
    const owner = c.get("member").organizationId;
    const versionId = c.req.param("vid");
    const body = updateSandboxVersionSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!body.success) return c.json({ error: "Invalid version change." }, 400);
    const current = await options.sandboxes.getVersion(owner, versionId);
    if (current === null) return c.json({ error: "Not found." }, 404);
    const refusal = await versionHeld(owner, current.version.sandboxId);
    if (refusal !== null) return c.json(refusal, 409);
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
        const unknown = unknownChoices(inputs.manifest, dependencyChoices);
        if (unknown !== null) return failed(c, unknown);
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
        if ("error" in copied) return failed(c, fixturesRefused(copied.error));
        fixtures = copied.fixtures;
      } else if (body.data.fixtures !== undefined)
        fixtures = { fixtureRunId: null, ...body.data.fixtures };
      if (fixtures !== null) {
        const invalid = invalidFixtures(fixtures.fixtures, inputs.contract);
        if (invalid !== null) return failed(c, invalid);
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
    return c.json(versionResponse(result, true, !inWebSession(c)));
  });

  /**
   * Publishes a version: approves and freezes it, and makes it the
   * sandbox's published version until the date given, which must be
   * ahead. Only a version whose build passed, of a bounty whose proposal is
   * approved, whose spec's decisions are confirmed and whose build's
   * publication gates passed (`service.publication`), which a first
   * publication records on its source. No public repository is pushed
   * yet; publication marks the version contributors are to get.
   */
  app.post(`${base}/versions/:vid/publish`, async (c) => {
    if (!isAtLeastAdmin(c.get("member").role))
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
    const owner = c.get("member").organizationId;
    const publishing = await options.sandboxes.getVersion(
      owner,
      c.req.param("vid"),
    );
    const refusal =
      publishing === null
        ? null
        : await versionHeld(owner, publishing.version.sandboxId);
    if (refusal !== null) return c.json(refusal, 409);
    // Its spec's decisions confirmed, and the gates its build recorded.
    const gated =
      publishing === null
        ? null
        : await service.publication(owner, c.get("user").id, publishing, at);
    if (gated !== null && !gated.ok) return failed(c, gated);
    const result = await options.sandboxes.publishVersion(
      owner,
      c.req.param("vid"),
      c.get("user").id,
      expiresAt,
      at,
      gated?.evidence,
    );
    if (!result.ok)
      return result.reason === "build_changed"
        ? c.json(
            {
              error:
                "The version was built again while it was being published. Reload it and publish again.",
              code: "version_changed",
            },
            409,
          )
        : result.reason === "not_ready"
          ? c.json(
              {
                error: "Only a version whose build passed can be published.",
                code: "not_ready",
              },
              409,
            )
          : result.reason === "price_not_approved"
            ? c.json(
                {
                  error:
                    "This version was not built from an approved price, so it cannot be published.",
                  code: "price_not_approved",
                },
                409,
              )
            : c.json({ error: "Not found." }, 404);
    options.onPublished?.(owner, {
      sandboxId: result.sandbox.id,
      versionId: result.version.version.id,
      version: result.version.version.version,
      expiresAt,
      at,
    });
    return c.json(
      publishVersionResponseSchema.parse({
        sandbox: sandboxDto(result.sandbox),
        version: result.version.version,
        source: sourceDto(result.version.source, !inWebSession(c)),
        ...(gated?.gates === undefined ? {} : { gates: gated.gates }),
      }),
    );
  });

  /** Back to a draft with no published version; versions stay frozen. */
  app.post(`${base}/:id/unpublish`, async (c) => {
    if (!isAtLeastAdmin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can unpublish a sandbox." },
        403,
      );
    const sandbox = await options.sandboxes.unpublish(
      c.get("member").organizationId,
      c.req.param("id"),
      now(),
    );
    return sandbox === null
      ? c.json({ error: "Not found." }, 404)
      : c.json(sandboxResponseSchema.parse({ sandbox: sandboxDto(sandbox) }));
  });

  /**
   * Queues the build. Its parameters are the version's hashes, so a changed
   * draft is a new run, and an unchanged one is the same run again. A draft
   * changed or frozen between the read and the record is refused, and the
   * store cancels the run if it is still queued, so it does not hold one of
   * the organization's active slots for a build nothing will record.
   */
  app.post(`${base}/versions/:vid/build`, async (c) => {
    if (!isAtLeastAdmin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can build a version." },
        403,
      );
    const owner = c.get("member").organizationId;
    const stored = await options.sandboxes.getVersion(
      owner,
      c.req.param("vid"),
    );
    if (stored === null) return c.json({ error: "Not found." }, 404);
    const refusal = await versionHeld(owner, stored.version.sandboxId);
    if (refusal !== null) return c.json(refusal, 409);
    const built = await service.build(owner, c.get("user").id, stored, now());
    if (!built.ok) return failed(c, built);
    return c.json(analysisRunResponseSchema.parse({ run: built.run }), 202);
  });

  /**
   * The private sandbox a version's build wrote: the project, its hidden
   * tests and the build's own records, read-only. Owners and admins only,
   * since the hidden tests are among them.
   */
  app.get(`${base}/versions/:vid/files`, async (c) => {
    if (!isAtLeastAdmin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can read a version's files." },
        403,
      );
    const owner = c.get("member").organizationId;
    const stored = await options.sandboxes.getVersion(
      owner,
      c.req.param("vid"),
    );
    if (stored === null) return c.json({ error: "Not found." }, 404);
    const runId = stored.source.buildRunId;
    const run = runId === null ? null : await options.runs.get(owner, runId);
    const { files, provisional } =
      run === null
        ? { files: [], provisional: false }
        : await filesOf(owner, run.id);
    c.header("Cache-Control", "no-store");
    return c.json(
      sandboxFileListSchema.parse({
        run: run === null ? null : { id: run.id, status: run.status },
        files: files.filter(readable(c)).map(({ path, sizeBytes, sha256 }) => ({
          path,
          sizeBytes,
          sha256,
        })),
        provisional,
      }),
    );
  });
  /**
   * Which of a build's files this request may read: all of them in a
   * person's web session, and outside one (an API token, an OAuth client, a
   * CLI's device session: how an agent reaches the platform) none under
   * `private/`, where the hidden tests and the name table are. The handout
   * gives an agent their count and commitment hash instead.
   */
  const readable =
    (c: Context) =>
    (file: { readonly path: string }): boolean =>
      inWebSession(c) || !file.path.startsWith("private/");
  /**
   * What a build run wrote: its artifacts once it has committed them, and
   * until then, what it has generated before its baseline, as provisional.
   */
  async function filesOf(owner: string, runId: string) {
    const committed = await options.artifacts.list(owner, runId);
    if (committed.length > 0 || options.previews === undefined)
      return { files: committed, provisional: false };
    const preview = await options.previews.preview(owner, runId);
    return preview === null
      ? { files: committed, provisional: false }
      : { files: preview.files, provisional: true };
  }
  /**
   * One of those files as text. Read through the API rather than a signed
   * link, which the browser could not read across origins; named by its
   * path, matched against what the run recorded, never joined into a key.
   */
  app.get(`${base}/versions/:vid/files/content`, async (c) => {
    if (!isAtLeastAdmin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can read a version's files." },
        403,
      );
    const owner = c.get("member").organizationId;
    const path = c.req.query("path");
    if (path === undefined || path === "")
      return c.json({ error: "Name a file with `path`." }, 400);
    const stored = await options.sandboxes.getVersion(
      owner,
      c.req.param("vid"),
    );
    const runId = stored?.source.buildRunId ?? null;
    if (runId === null) return c.json({ error: "Not found." }, 404);
    const file = (await filesOf(owner, runId)).files
      .filter(readable(c))
      .find((item) => item.path === path);
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

  /*
    The handout, its archive and its pages of files (`handout.ts`): owners
    and admins, drafts too, as the version page shows them. An invited
    contributor reads the same answers for their version from
    `contributors.ts`.
  */
  const readsHandout = (c: Context<{ Variables: AuthVariables }>) =>
    isAtLeastAdmin(c.get("member").role)
      ? undefined
      : c.json(
          { error: "Only owners and admins can read a version's handout." },
          403,
        );
  app.get(`${base}/versions/:vid/handout`, async (c) => {
    const denied = readsHandout(c);
    if (denied !== undefined) return denied;
    return handoutResponse(
      c,
      options,
      c.get("member").organizationId,
      c.req.param("vid"),
    );
  });
  app.get(`${base}/versions/:vid/archive`, async (c) => {
    const denied = readsHandout(c);
    if (denied !== undefined) return denied;
    return archiveResponse(
      c,
      options,
      c.get("member").organizationId,
      c.req.param("vid"),
    );
  });
  app.get(`${base}/versions/:vid/handout/files`, async (c) => {
    const denied = readsHandout(c);
    if (denied !== undefined) return denied;
    return handoutFilesResponse(
      c,
      options,
      c.get("member").organizationId,
      c.req.param("vid"),
    );
  });

  /*
    Submissions against a published (frozen) version, by the workspace's
    owners and admins (`submission-service.ts`). The same files against the
    same version, from the same person, are the submission already made.
    An invited contributor submits from `contributors.ts`; their
    submissions are listed here with who made them.
  */
  /** Who each of a version's invited contributors is, by assignment. */
  const contributorsOf = async (owner: string, versionId: string) =>
    new Map(
      (
        (await options.contributors?.listAssignments(owner, versionId)) ?? []
      ).map((assignment) => [
        assignment.id,
        {
          assignmentId: assignment.id,
          userId: assignment.user.id,
          name: assignment.user.name,
          email: assignment.user.email,
        },
      ]),
    );
  const contributorOf = async (
    owner: string,
    stored: StoredSubmission,
  ): Promise<SubmissionContributor> =>
    stored.assignmentId === null
      ? null
      : ((await contributorsOf(owner, stored.sandboxVersionId)).get(
          stored.assignmentId,
        ) ?? null);
  /**
   * The caller's role, then the shared checks and storage of the files:
   * `files[]` JSON, or the zipped project folder (`folder-upload.ts`).
   */
  const submittedFiles = async (
    c: Context<{ Variables: AuthVariables }>,
    versionOf: (owner: string) => Promise<string | null>,
    receive: typeof receiveFiles = receiveFiles,
  ) => {
    if (!isAtLeastAdmin(c.get("member").role))
      return {
        response: c.json({ error: "Only owners and admins can submit." }, 403),
      };
    const owner = c.get("member").organizationId;
    const received = await receive(c, options, owner, () => versionOf(owner));
    if ("response" in received) return received;
    return {
      store: received.store,
      owner,
      versionId: received.versionId,
      input: {
        submittedBy: c.get("user").id,
        patchKey: received.patchKey,
        patchSha256: received.patchSha256,
      },
    };
  };
  const graded = async (
    c: Context<{ Variables: AuthVariables }>,
    owner: string,
    made: { submission: StoredSubmission; created: boolean },
    regrade = false,
  ) =>
    gradeSubmission(c, options, owner, made, {
      regrade,
      requestedBy: c.get("user").id,
      answer: async (submission, status) =>
        c.json(
          submissionResponseSchema.parse({
            submission: submissionOf(
              submission,
              null,
              await contributorOf(owner, submission),
            ),
          }),
          status,
        ),
    });
  const submitToVersion =
    (receive: typeof receiveFiles) =>
    async (c: Context<{ Variables: AuthVariables }>) => {
      const files = await submittedFiles(
        c,
        async () => c.req.param("vid") ?? null,
        receive,
      );
      if ("response" in files) return files.response;
      const created = await files.store.create(files.owner, {
        sandboxVersionId: files.versionId,
        ...files.input,
      });
      if (!created.ok)
        return created.reason === "not_frozen"
          ? c.json(
              {
                error: "Only a published version takes submissions.",
                code: "not_frozen",
              },
              409,
            )
          : c.json({ error: "Not found." }, 404);
      return graded(c, files.owner, created);
    };
  app.post(`${base}/versions/:vid/submissions`, submitToVersion(receiveFiles));
  // The same as a zipped project folder; session only (not in the public
  // registry). An invited contributor's twin also takes their contributor
  // credential.
  app.post(
    `${base}/versions/:vid/submissions/zip`,
    folderBodyLimit,
    submitToVersion(receiveFolder),
  );
  /*
    One retry of a failed or errored submission, against the same version.
    What the contributor was told is the first one's scenario keys
    (`failedScenarios`), never a hidden test. An errored one retried with
    its own files is graded again in place, its retry kept. An invited
    contributor's submission is theirs to retry (`contributor_submission`).
  */
  const retrySubmission =
    (receive: typeof receiveFiles) =>
    async (c: Context<{ Variables: AuthVariables }>) => {
      const sid = c.req.param("sid") ?? "";
      const files = await submittedFiles(
        c,
        async (owner) =>
          (await options.submissions?.get(owner, sid))?.sandboxVersionId ??
          null,
        receive,
      );
      if ("response" in files) return files.response;
      const made = await files.store.retry(files.owner, sid, files.input);
      if (!made.ok)
        return made.reason === "not-found"
          ? c.json({ error: "Not found." }, 404)
          : c.json(
              { error: RETRY_REFUSALS[made.reason], code: made.reason },
              409,
            );
      return graded(c, files.owner, made, made.regrade === true);
    };
  app.post(`${base}/submissions/:sid/retry`, retrySubmission(receiveFiles));
  app.post(
    `${base}/submissions/:sid/retry/zip`,
    folderBodyLimit,
    retrySubmission(receiveFolder),
  );
  /*
    An errored submission graded again with its own files: its run could
    not finish, which is the platform's failure, not the contributor's, so
    its one retry is not spent. The same as retrying it with the same files,
    for a caller that does not hold them (the web app).
  */
  app.post(`${base}/submissions/:sid/regrade`, async (c) => {
    if (!isAtLeastAdmin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can grade a submission again." },
        403,
      );
    if (options.submissions === undefined)
      return c.json({ error: "Not found." }, 404);
    const owner = c.get("member").organizationId;
    const found = await options.submissions.get(owner, c.req.param("sid"));
    if (found === null) return c.json({ error: "Not found." }, 404);
    if (found.status !== "errored")
      return c.json(
        {
          error: "Only a submission that could not be graded is graded again.",
          code: "not_errored",
        },
        409,
      );
    return graded(c, owner, { submission: found, created: false }, true);
  });
  app.get(`${base}/submissions/:sid`, async (c) => {
    if (!isAtLeastAdmin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can read a submission." },
        403,
      );
    const owner = c.get("member").organizationId;
    const found = await options.submissions?.get(owner, c.req.param("sid"));
    if (found === undefined || found === null)
      return c.json({ error: "Not found." }, 404);
    const merge = (await options.merges?.get(owner, found.id)) ?? null;
    return c.json(
      submissionResponseSchema.parse({
        submission: submissionOf(
          found,
          merge,
          await contributorOf(owner, found),
        ),
      }),
    );
  });
  app.get(`${base}/versions/:vid/submissions`, async (c) => {
    if (!isAtLeastAdmin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can read submissions." },
        403,
      );
    const owner = c.get("member").organizationId;
    const versionId = c.req.param("vid");
    const listed = (await options.submissions?.list(owner, versionId)) ?? [];
    const merges = new Map(
      (
        (await options.merges?.list(
          owner,
          listed.map((item) => item.id),
        )) ?? []
      ).map((merge) => [merge.submissionId, merge]),
    );
    const contributors = listed.some((item) => item.assignmentId !== null)
      ? await contributorsOf(owner, versionId)
      : new Map<string, NonNullable<SubmissionContributor>>();
    return c.json(
      submissionListSchema.parse({
        submissions: listed.map((item) =>
          submissionOf(
            item,
            merges.get(item.id) ?? null,
            item.assignmentId === null
              ? null
              : (contributors.get(item.assignmentId) ?? null),
          ),
        ),
      }),
    );
  });

  /*
    An uploaded hand-off folder (`carveout handoff --platform`), as a
    version of the bounty's sandbox: for a workspace that will not connect
    its repository. The sandbox is made when the bounty has none, and an
    upload is refused when it is sliced from a repository. The folder is
    checked (`checkUpload`), stored under the version by its hash, and
    imported by a `sandbox_import` run queued through the usual admission.
    Publishing it stays a person's act in the web app.
  */
  app.post(`${base}/uploads`, uploadBodyLimit, async (c) => {
    if (!isAtLeastAdmin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can upload a version." },
        403,
      );
    const put = options.objects.put;
    if (put === undefined)
      return c.json(
        {
          error: "Uploads are not taken on this deployment.",
          code: "uploads_unavailable",
        },
        503,
      );
    const parsed = createUploadSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json(
        {
          error: "Invalid upload.",
          code: "invalid_upload",
          issues: parsed.error.issues.slice(0, 20).map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        400,
      );
    const body = parsed.data;
    const owner = c.get("member").organizationId;
    const bounty = await options.bounties.get(owner, body.bountyId);
    if (bounty === null)
      return c.json({ error: "Not found.", code: "bounty_not_found" }, 404);
    const refusal = await held(owner, body.bountyId);
    if (refusal !== null) return c.json(refusal, 409);
    const existing = (await options.sandboxes.list(owner)).find(
      (item) => item.bountyId === body.bountyId,
    );
    if (existing !== undefined && existing.sourceRepoId !== null)
      return c.json(
        {
          error:
            "This bounty's sandbox is sliced from its connected repository; an uploaded folder is for a bounty with none.",
          code: "source_linked",
        },
        409,
      );
    const checked = checkUpload(
      body,
      workspaceVocabulary(
        organizationNames([
          ...((await options.organizationNames?.(owner)) ?? []),
        ]),
      ),
    );
    if ("refusal" in checked)
      return c.json(checked.refusal.body, checked.refusal.status);
    let sandbox = existing;
    if (sandbox === undefined) {
      const made = await options.sandboxes.create(owner, {
        bountyId: body.bountyId,
        sourceRepoId: null,
      });
      if (made.ok) sandbox = made.sandbox;
      else if (made.reason === "bounty_has_sandbox")
        sandbox = (await options.sandboxes.list(owner)).find(
          (item) => item.bountyId === body.bountyId,
        );
      if (sandbox === undefined)
        return sandboxRefused(c, made.ok ? "not-found" : made.reason);
      if (sandbox.sourceRepoId !== null)
        return sandboxRefused(c, "source_linked");
    }
    const text = JSON.stringify({
      files: [...body.files]
        .sort((a, b) => (a.path < b.path ? -1 : 1))
        .map(({ path, text: file }) => ({ path, text: file })),
      acceptanceTests: body.acceptanceTests.map(
        ({ path, text: file, expectedBaseline }) => ({
          path,
          text: file,
          expectedBaseline,
        }),
      ),
    });
    const uploadSha256 = createHash("sha256")
      .update(text, "utf8")
      .digest("hex");
    const versionId = generateId("sbv");
    const key = uploadObjectKey(owner, versionId, uploadSha256);
    await put(key, Buffer.from(text, "utf8"));
    const imported = await service.upload(
      owner,
      c.get("user").id,
      sandbox,
      {
        versionId,
        uploadSha256,
        recordSha256: checked.recordSha256,
        carveoutVersion: body.carveout.version,
        title: body.title,
        specSummary: body.specSummary,
      },
      now(),
    );
    if (!imported.ok) {
      await options.objects.remove(key).catch(() => {});
      return failed(c, imported);
    }
    await options.ensureWorker().catch(() => options.onLaunchError?.());
    return c.json(
      uploadResponseSchema.parse({
        sandbox: sandboxDto(sandbox),
        version: imported.result.version,
        source: sourceDto(imported.result.source, !inWebSession(c)),
        run: imported.run,
      }),
      202,
    );
  });

  /*
    A passing submission's changed files on a version with no repository
    to merge back to, built only from what the submission stored, less what
    is the version's own text and anything at a hidden test's path. On an
    uploaded version, for `carveout patch --from`, which applies them on the
    maintainer's machine with the receipt. On a generated (starter) one, as
    they are: a starter has no other names to carry back to, since its
    project was generated already renamed and the version's files, which
    the workspace reads, are those names. A version sliced from a connected
    repository is merged back through its pull request instead, and its
    carried-back patch stays private. `…/files/archive` is the same files
    as a `.zip`, which the web saves.
  */
  async function takeBack(
    c: Context<{ Variables: AuthVariables }>,
    submissionId: string,
  ): Promise<
    | Response
    | {
        found: StoredSubmission;
        origin: "upload" | "starter";
        upload: { recordSha256: string; carveoutVersion: string } | null;
        files: { path: string; text: string }[];
      }
  > {
    if (!isAtLeastAdmin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can read a submission's files." },
        403,
      );
    const owner = c.get("member").organizationId;
    const found = await options.submissions?.get(owner, submissionId);
    if (found === undefined || found === null)
      return c.json({ error: "Not found." }, 404);
    if (found.status !== "passed" || found.result?.verdict !== "passed")
      return c.json(
        {
          error: "Only a passing submission's files are taken back.",
          code: "not_passed",
        },
        409,
      );
    const stored = await options.sandboxes.getVersion(
      owner,
      found.sandboxVersionId,
    );
    if (stored === null) return c.json({ error: "Not found." }, 404);
    const origin = stored.source.origin;
    if (
      (origin !== "upload" && origin !== "starter") ||
      stored.source.buildRunId === null
    )
      return c.json(
        {
          error:
            "Only a submission on an uploaded or generated version is taken back this way; a version sliced from a connected repository is merged back by its pull request.",
          code: "not_uploaded",
        },
        409,
      );
    const unreadable = () =>
      c.json(
        {
          error: "The submission's files could not be read.",
          code: "artifacts_unavailable",
        },
        502,
      );
    const artifacts = await options.artifacts.list(
      owner,
      stored.source.buildRunId,
    );
    const textOfArtifact = async (path: string) => {
      const artifact = artifacts.find((item) => item.path === path);
      if (artifact === undefined) return null;
      const bytes = await options.objects.get(artifact.objectKey);
      return bytes === undefined ? null : textOf(bytes);
    };
    const manifestText = await textOfArtifact("build-manifest.json");
    const submittedBytes = await options.objects.get(found.patchKey);
    const submitted =
      submittedBytes === undefined
        ? null
        : parseSubmittedFiles(Buffer.from(submittedBytes).toString("utf8"));
    if (manifestText === null || submitted === null) return unreadable();
    const manifest = JSON.parse(manifestText) as Pick<
      SandboxBuildManifest,
      "files" | "layout" | "upload"
    >;
    if (
      !Array.isArray(manifest.files) ||
      (origin === "upload" && manifest.upload === undefined)
    )
      return unreadable();
    const publicText = new Map<string, string | null>();
    for (const file of submitted)
      publicText.set(file.path, await textOfArtifact(`project/${file.path}`));
    return {
      found,
      origin,
      upload: origin === "upload" ? (manifest.upload ?? null) : null,
      files: changedSubmissionFiles({
        submitted,
        publicText: (path) => publicText.get(path) ?? null,
        hiddenPaths: new Set(
          manifest.files
            .filter((file) => file.class === "test-private")
            .map((file) => file.path),
        ),
        privateDir: layoutOf(manifest).tests.privateDir,
      }),
    };
  }
  app.get(`${base}/submissions/:sid/files`, async (c) => {
    const taken = await takeBack(c, c.req.param("sid"));
    if (taken instanceof Response) return taken;
    c.header("Cache-Control", "no-store");
    return c.json(
      submissionFilesResponseSchema.parse({
        submission: submissionOf(taken.found),
        origin: taken.origin,
        upload: taken.upload,
        files: taken.files,
      }),
    );
  });
  app.get(`${base}/submissions/:sid/files/archive`, async (c) => {
    const taken = await takeBack(c, c.req.param("sid"));
    if (taken instanceof Response) return taken;
    const archive = await zip(
      taken.files.map((file) => ({
        name: file.path,
        bytes: Buffer.from(file.text, "utf8"),
      })),
    );
    c.header("Cache-Control", "no-store");
    c.header("Content-Type", "application/zip");
    c.header(
      "Content-Disposition",
      `attachment; filename="${taken.found.id}-files.zip"`,
    );
    return c.body(
      Buffer.concat(archive.chunks.map((chunk) => Buffer.from(chunk))),
    );
  });

  /*
    Merge-back (gate 3): a passing submission, carried back to the
    repository's names by its grading run (`private/merge-patch.json`),
    becomes a pull request on the commit the version was cut at. A
    person's act in the web app: no token reaches it. One per submission.

    Safe to press twice and to retry after any failure: the merge row is
    claimed (`pending`) before GitHub is asked, on the submission's unique
    key, so a second click while the first is out is told so
    (`merge_in_progress`) rather than opening a second pull request; a
    failure releases the claim; and the writer reuses the branch and pull
    request an earlier attempt made (`PullRequestWriter.open`). One opened
    already is answered 200 with the same body each time.

    `{ "when": "ci_passes" }` also asks the platform to merge it once the
    repository's CI passes on it (`github/merge-ci.ts`): refused 409
    `ci_permissions_missing` while the App cannot read CI back, since it
    would never merge; asked of one already open, it is recorded and the
    same submission answered 200. The default, `open`, leaves the merge to
    the repository's people.
  */
  const MERGE_REFUSALS = {
    not_passed: "Only a passing submission is merged back.",
    carry_failed:
      "The submission passed, but carried back to the repository's names it did not build and pass the tests there, so it is not merged back.",
    not_sliced:
      "Only a submission on a version sliced from a repository is merged back.",
    repository_unavailable:
      "The repository is gone, or its GitHub installation is not healthy.",
    app_permissions_missing:
      "The GitHub App has not been granted what merge-back needs on this installation. An installation admin accepts its new permissions on GitHub.",
    merge_forbidden:
      "The GitHub App cannot write to this repository. Accept its new permissions (contents and pull requests: write) on the installation.",
    merge_in_progress:
      "This submission's pull request is being opened now. Try again in a moment.",
    branch_conflict:
      "The submission's branch already exists on GitHub with other changes, so nothing was overwritten. Delete or rename that branch, then try again.",
    ci_permissions_missing:
      "The GitHub App cannot read this repository's CI (checks and statuses: read), so it could never see it pass. An installation admin accepts its new permissions on GitHub, or open the pull request alone.",
    pull_request_ended: "The pull request was merged or closed already.",
  } as const;
  const MERGE_UNAVAILABLE = "Merge-back is not available on this deployment.";

  /** The repository a version was sliced from; null for any other. */
  async function sourceRepoOf(owner: string, versionId: string) {
    const stored = await options.sandboxes.getVersion(owner, versionId);
    const sandbox =
      stored === null
        ? null
        : await options.sandboxes.get(owner, stored.version.sandboxId);
    const repoId = sandbox?.sourceRepoId ?? null;
    return stored === null || repoId === null ? null : { stored, repoId };
  }

  /*
    Whether a version's passing submissions can be merged back now, for
    the web to say why before the button is pressed: the refusal a merge
    would answer, never a GitHub call it would make. Session only (it is
    not in the public API's registry).
  */
  app.get(`${base}/versions/:vid/merge-back`, async (c) => {
    if (!isAtLeastAdmin(c.get("member").role))
      return c.json({ error: "Only owners and admins can merge back." }, 403);
    const status = (
      code: MergeBackStatusDto["code"],
      error: string | null,
      extra: {
        missing?: readonly string[];
        ciMissing?: readonly string[];
        acceptUrl?: string;
      } = {},
    ) =>
      c.json(
        mergeBackStatusResponseSchema.parse({
          mergeBack: {
            code,
            error,
            missing: [...(extra.missing ?? [])],
            acceptUrl: extra.acceptUrl ?? null,
            ciMissing: [...(extra.ciMissing ?? [])],
          },
        }),
      );
    c.header("Cache-Control", "no-store");
    if (options.merges === undefined || options.mergeBack === undefined)
      return status("merge_unavailable", MERGE_UNAVAILABLE);
    const owner = c.get("member").organizationId;
    const source = await sourceRepoOf(owner, c.req.param("vid"));
    if (source === null) return status("not_sliced", MERGE_REFUSALS.not_sliced);
    const target = await options.mergeBack.target(owner, source.repoId);
    if (target === null)
      return status(
        "repository_unavailable",
        MERGE_REFUSALS.repository_unavailable,
      );
    const ciMissing = target.ciMissingPermissions;
    if (target.missingPermissions.length > 0)
      return status(
        "app_permissions_missing",
        MERGE_REFUSALS.app_permissions_missing,
        {
          missing: target.missingPermissions,
          ciMissing,
          acceptUrl: target.acceptUrl,
        },
      );
    return status(
      null,
      null,
      ciMissing.length === 0 ? {} : { ciMissing, acceptUrl: target.acceptUrl },
    );
  });

  app.post(`${base}/submissions/:sid/merge`, async (c) => {
    const refuse = (code: keyof typeof MERGE_REFUSALS) =>
      c.json({ error: MERGE_REFUSALS[code], code }, 409);
    if (c.get("principal").via !== "session")
      return c.json(
        {
          error: "A merge-back is opened from a signed-in session.",
          code: "session_required",
        },
        403,
      );
    if (!isAtLeastAdmin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can open a merge-back." },
        403,
      );
    if (
      options.submissions === undefined ||
      options.merges === undefined ||
      options.mergeBack === undefined
    )
      return c.json(
        { error: MERGE_UNAVAILABLE, code: "merge_unavailable" },
        503,
      );
    const merges = options.merges;
    const mergeBack = options.mergeBack;
    // No body is the default, as before `when` existed.
    const raw = await c.req.text();
    const body = mergeSubmissionSchema.safeParse(
      raw.trim() === ""
        ? {}
        : (() => {
            try {
              return JSON.parse(raw) as unknown;
            } catch {
              return null;
            }
          })(),
    );
    if (!body.success)
      return c.json(
        {
          error:
            'Send { "when": "open" } or { "when": "ci_passes" }, or nothing.',
          code: "invalid_merge",
        },
        400,
      );
    const when = body.data.when;
    const owner = c.get("member").organizationId;
    const found = await options.submissions.get(owner, c.req.param("sid"));
    if (found === null) return c.json({ error: "Not found." }, 404);
    if (found.status !== "passed" || found.result?.verdict !== "passed")
      return refuse("not_passed");
    // Its grading run checked the carry in the repository's names and
    // kept no merge patch: there is nothing safe to open.
    if (found.result.carryBack === "failed") return refuse("carry_failed");
    const contributor = await contributorOf(owner, found);
    const answer = (merge: StoredSubmissionMerge, status: 200 | 201 = 200) =>
      c.json(
        submissionResponseSchema.parse({
          submission: submissionOf(found, merge, contributor),
        }),
        status,
      );
    /** The refusal when CI cannot be read back to merge on; null when it can. */
    const ciRefused = (target: {
      ciMissingPermissions: readonly string[];
      acceptUrl: string;
    }) =>
      when === "ci_passes" && target.ciMissingPermissions.length > 0
        ? c.json(
            {
              error: MERGE_REFUSALS.ci_permissions_missing,
              code: "ci_permissions_missing",
              missing: [...target.ciMissingPermissions],
              acceptUrl: target.acceptUrl,
            },
            409,
          )
        : null;
    const existing = await merges.get(owner, found.id);
    if (existing !== null) {
      if (when === "open" || existing.mergeWhen === "ci_passes")
        return answer(existing);
      // Asked to merge one already open once its CI passes.
      if (existing.pullRequestState !== "open" || existing.repoId === null)
        return refuse("pull_request_ended");
      const target = await mergeBack.target(owner, existing.repoId);
      if (target === null) return refuse("repository_unavailable");
      const refused = ciRefused(target);
      if (refused !== null) return refused;
      const updated = await merges.setMergeWhen(owner, found.id, "ci_passes");
      return updated === null ? refuse("pull_request_ended") : answer(updated);
    }
    const artifact =
      found.runId === null
        ? undefined
        : (await options.artifacts.list(owner, found.runId)).find(
            (file) => file.path === "private/merge-patch.json",
          );
    const source = await sourceRepoOf(owner, found.sandboxVersionId);
    if (artifact === undefined || source === null) return refuse("not_sliced");
    const bytes = await options.objects.get(artifact.objectKey);
    if (bytes === undefined)
      return c.json(
        {
          error: "The carried-back patch could not be read.",
          code: "artifacts_unavailable",
        },
        502,
      );
    const patch = mergePatchOf(bytes);
    if (patch === null) {
      // The grading run wrote it; a patch that does not parse is a fault
      // to look into, never something to open a pull request from.
      console.error("merge_patch_invalid", found.id);
      return c.json(
        {
          error: "The carried-back patch is damaged, so nothing was opened.",
          code: "merge_patch_invalid",
        },
        502,
      );
    }
    // A merge reads the installation's permissions from GitHub, not the
    // stored copy: its first sign of a missing one is otherwise a 403 from
    // GitHub halfway through.
    const target = await mergeBack.target(owner, source.repoId, {
      fresh: true,
    });
    if (target === null) return refuse("repository_unavailable");
    if (target.missingPermissions.length > 0)
      return c.json(
        {
          error: MERGE_REFUSALS.app_permissions_missing,
          code: "app_permissions_missing",
          missing: [...target.missingPermissions],
          acceptUrl: target.acceptUrl,
        },
        409,
      );
    const refused = ciRefused(target);
    if (refused !== null) return refused;
    const branch = `lunox/${found.id}`;
    const claim = await merges.claim(owner, {
      submissionId: found.id,
      repositoryFullName: target.fullName,
      branch,
      openedBy: c.get("user").id,
      repoId: source.repoId,
      mergeWhen: when,
    });
    if (claim.status === "opened") return answer(claim.merge);
    if (claim.status === "busy") return refuse("merge_in_progress");
    const title = source.stored.source.approvedTask.title;
    let opened;
    try {
      opened = await target.writer.open({
        fullName: target.fullName,
        baseCommit: patch.commitSha,
        base: target.defaultBranch,
        branch,
        title,
        commitMessage: title,
        body: [
          `Carried back from sandbox submission \`${found.id}\`, which passed the version's public tests (${found.result.public.passed}/${found.result.public.total}) and hidden tests (${found.result.hidden.passed}/${found.result.hidden.total}).`,
          "",
          when === "ci_passes"
            ? `Based on ${patch.commitSha}. The platform merges it (squashed) once this repository's CI passes on it and ${target.defaultBranch}'s protection allows; never on failing CI.`
            : `Based on ${patch.commitSha}; GitHub shows whether it still merges onto ${target.defaultBranch}. This repository's own CI is the last gate.`,
        ].join("\n"),
        files: patch.files,
      });
    } catch (error) {
      // Released, so pressing again resumes from what GitHub already has.
      await merges.release(owner, found.id);
      if (error instanceof BranchConflictError)
        return refuse("branch_conflict");
      if (error instanceof GithubAuthError) return refuse("merge_forbidden");
      return c.json(
        {
          error: "GitHub did not open the pull request.",
          code: "github_failed",
        },
        502,
      );
    }
    let merge;
    try {
      merge = await merges.finish(owner, found.id, {
        commitSha: opened.commitSha,
        pullRequestNumber: opened.number,
        pullRequestUrl: opened.url,
      });
    } catch (error) {
      // The pull request is open on GitHub; the next press finds and
      // records it.
      await merges.release(owner, found.id).catch(() => undefined);
      throw error;
    }
    options.onSubmissionEvent?.(
      owner,
      "submission.merge_opened",
      `${found.id}:${merge.pullRequestNumber}`,
      {
        submissionId: found.id,
        sandboxVersionId: found.sandboxVersionId,
        pullRequestNumber: merge.pullRequestNumber,
        pullRequestUrl: merge.pullRequestUrl,
        when: merge.mergeWhen,
      },
    );
    return answer(merge, 201);
  });

  /** What a replay would use. Never the current branch head. */
  app.get(`${base}/versions/:vid/replay`, async (c) => {
    if (!isAtLeastAdmin(c.get("member").role))
      return c.json(
        { error: "Only owners and admins can read provenance." },
        403,
      );
    const context = await options.sandboxes.replayContext(
      c.get("member").organizationId,
      c.req.param("vid"),
    );
    if (context === null) return c.json({ error: "Not found." }, 404);
    return c.json(
      replayResponseSchema.parse(
        replayOf(context.source, context.snapshot, context.sliceRun),
      ),
    );
  });

  /*
    Invited contributors: the workspace's invites and contributors under
    this base, and a contributor's own routes outside it.
  */
  mountContributorRoutes(app, options);
}
