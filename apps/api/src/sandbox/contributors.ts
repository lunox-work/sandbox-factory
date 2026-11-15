/**
 * Invited contributors: a workspace's owner or admin invites one person to
 * one published version; that person signs in (the platform's own sign-in),
 * claims the invite, and from then on works on that version alone. They
 * never become a member: nothing of the workspace is theirs to read.
 *
 * The workspace's side sits under `/orgs/:orgId/sandboxes`, behind
 * `requireMembership`: make an invite (its secret answered once, as an API
 * token's is, in a link to the web app's invite page with the secret in
 * the fragment), list a version's invites and contributors, revoke either.
 *
 * The contributor's side sits outside it, under `/contributions` and
 * `POST /invites/claim`, behind the credential guard alone: each route finds
 * the caller's own live assignment to the version in the path, and anything
 * else is 404, never 403. The owner is the assignment's, never the path's
 * or the session's. A contributor reads the version's public listing (its
 * project's `sandbox-task.json`), the handout, archive and pages of files
 * (`handout.ts`), and their own submissions and verdicts, without the run,
 * carry-back or merge-back. Never a private artifact, run log, build
 * manifest, another person's submission, merge-back or the workspace's
 * members. A person's session, or a contributor credential (an `lnxc_`
 * token, a contributor OAuth grant: `contributions:write`, the registry's
 * contributor audience); a workspace's API token or OAuth grant is refused
 * (`workspace_credential`), and a contributor credential reaches nothing
 * of a workspace's.
 *
 * A claim's secret is a body field, never a path segment: a path reaches
 * access logs and the audit trail's resource. Claims are counted per person
 * (`rate-limit.ts`); an invite revoked, expired, claimed out or unknown is
 * the same 404, so a guess learns nothing.
 *
 * Submissions: an invited contributor makes one first submission per
 * assignment and its one retry (`already_submitted` names the first), only
 * while the version is published, current and unexpired (`not_open`). An
 * errored one is graded again in place without spending the retry. Each
 * takes `files[]` JSON or the zipped project folder (`…/zip`,
 * `folder-upload.ts`, with a `?dryRun=1` preview).
 */

import type {
  StoredContributorAssignment,
  StoredContributorInvite,
  StoredSubmission,
} from "@sandbox-factory/db";
import {
  claimInviteSchema,
  CONTRIBUTOR_INVITE_PATH,
  contributionListSchema,
  contributionResponseSchema,
  contributionSubmissionDtoSchema,
  contributionSubmissionListSchema,
  contributionSubmissionResponseSchema,
  contributorAssignmentResponseSchema,
  contributorInviteResponseSchema,
  contributorListResponseSchema,
  createContributorInviteSchema,
  createdContributorInviteResponseSchema,
  taskDescriptorSchema,
  type ContributionDto,
  type ContributionSubmissionDto,
} from "@sandbox-factory/shared";
import type { Context, Hono } from "hono";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isPublicationLive, TASK_DESCRIPTOR_PATH } from "sandbox-factory";

import { isAtLeastAdmin } from "../access.js";
import { noteAuditResource } from "../audit/trail.js";
import { hashSecret, randomBase62 } from "../api-tokens/secret.js";
import type { AuthVariables } from "../http-context.js";
import { attemptLimiter } from "../rate-limit.js";
import {
  archiveResponse,
  handoutFilesResponse,
  handoutResponse,
} from "./handout.js";
import type { SandboxRouteOptions } from "./options.js";
import { publicProject, rootOf } from "./project.js";
import { folderBodyLimit, receiveFolder } from "./folder-upload.js";
import {
  gradeSubmission,
  receiveFiles,
  RETRY_REFUSALS,
  type Received,
  type ReceivingStores,
} from "./submission-service.js";

/** An invite's secret: this prefix and 40 base62 characters (~238 bits). */
export const INVITE_TOKEN_PREFIX = "lnxinv_";
const INVITE_SECRET_LENGTH = 40;
/** Claim attempts each person may make per window, per API process. */
export const CLAIM_ATTEMPTS = { limit: 10, windowMs: 15 * 60_000 } as const;
const DAY_MS = 24 * 60 * 60_000;

export function generateInviteToken(
  random: (size: number) => Uint8Array = randomBytes,
): string {
  return `${INVITE_TOKEN_PREFIX}${randomBase62(INVITE_SECRET_LENGTH, random)}`;
}

type Env = { Variables: AuthVariables };

const NOT_FOUND = { error: "Not found." } as const;
const UNAVAILABLE = {
  error:
    "This invite is not valid. It may have expired, been revoked or been used; ask for a new one.",
  code: "invite_unavailable",
} as const;

function inviteState(invite: StoredContributorInvite, at: Date) {
  if (invite.revokedAt !== null) return "revoked" as const;
  if (invite.claims >= invite.maxClaims) return "claimed" as const;
  if (invite.expiresAt.getTime() <= at.getTime()) return "expired" as const;
  return "active" as const;
}

const iso = (date: Date | null) => (date === null ? null : date.toISOString());

const inviteDto = (invite: StoredContributorInvite, at: Date) => ({
  id: invite.id,
  sandboxVersionId: invite.sandboxVersionId,
  label: invite.label,
  emailHint: invite.emailHint,
  state: inviteState(invite, at),
  maxClaims: invite.maxClaims,
  claims: invite.claims,
  expiresAt: invite.expiresAt.toISOString(),
  revokedAt: iso(invite.revokedAt),
  claimedAt: iso(invite.claimedAt),
  createdBy: invite.createdBy,
  createdAt: invite.createdAt.toISOString(),
});

const assignmentDto = (assignment: StoredContributorAssignment) => ({
  id: assignment.id,
  sandboxVersionId: assignment.sandboxVersionId,
  user: assignment.user,
  inviteId: assignment.inviteId,
  createdAt: assignment.createdAt.toISOString(),
  revokedAt: iso(assignment.revokedAt),
});

/** A contributor's own submission: the verdict, never the workspace's parts. */
export const contributionSubmissionOf = (
  stored: StoredSubmission,
): ContributionSubmissionDto =>
  contributionSubmissionDtoSchema.parse({
    id: stored.id,
    sandboxVersionId: stored.sandboxVersionId,
    status: stored.status,
    errorCode: stored.errorCode ?? null,
    verdict: stored.result?.verdict ?? null,
    public: stored.result?.public ?? null,
    hidden: stored.result?.hidden ?? null,
    failedScenarios: [...(stored.result?.failedScenarios ?? [])],
    refused: [...(stored.result?.refused ?? [])],
    retryOf: stored.retryOf,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  });

export function mountContributorRoutes(
  app: Hono<Env>,
  options: SandboxRouteOptions,
): void {
  const base = "/api/v1/orgs/:orgId/sandboxes";
  const now = options.now ?? (() => new Date());
  const claims = attemptLimiter({ ...CLAIM_ATTEMPTS, now });
  const inviteUrl =
    options.inviteUrl ??
    ((token: string) => `${CONTRIBUTOR_INVITE_PATH}#${token}`);

  /**
   * Where a version stands for a contributor: absent, null; `open` while
   * it takes submissions (the sandbox's current published version, before
   * its publication lapses).
   */
  const standing = async (owner: string, versionId: string) => {
    const stored = await options.sandboxes.getVersion(owner, versionId);
    if (stored === null) return null;
    const sandbox = await options.sandboxes.get(
      owner,
      stored.version.sandboxId,
    );
    const open =
      sandbox !== null &&
      stored.version.frozenAt !== null &&
      sandbox.currentVersionId === versionId &&
      isPublicationLive(sandbox, now());
    return {
      stored,
      open,
      closesAt: open ? (sandbox?.expiresAt ?? null) : null,
    };
  };

  // The workspace's side: owners and admins, behind `requireMembership`.

  const adminOnly = (c: Context<Env>) =>
    isAtLeastAdmin(c.get("member").role)
      ? undefined
      : c.json(
          { error: "Only owners and admins can manage contributors." },
          403,
        );
  const unavailableHere = (c: Context<Env>) =>
    c.json(
      {
        error: "Contributors are not taken on this deployment.",
        code: "contributors_unavailable",
      },
      503,
    );

  app.post(`${base}/versions/:vid/invites`, async (c) => {
    const denied = adminOnly(c);
    if (denied !== undefined) return denied;
    if (options.contributors === undefined) return unavailableHere(c);
    const parsed = createContributorInviteSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json(
        {
          error: parsed.error.issues[0]?.message ?? "Invalid invite.",
          code: "invalid_invite",
        },
        400,
      );
    const owner = c.get("member").organizationId;
    const versionId = c.req.param("vid");
    const found = await standing(owner, versionId);
    if (found === null) return c.json(NOT_FOUND, 404);
    if (!found.open)
      return c.json(
        {
          error:
            "Only the sandbox's current published version takes contributors.",
          code: "not_published",
        },
        409,
      );
    const at = now();
    const token = generateInviteToken();
    const invite = await options.contributors.createInvite(owner, {
      sandboxVersionId: versionId,
      createdBy: c.get("user").id,
      emailHint: parsed.data.email ?? null,
      label: parsed.data.label ?? null,
      tokenSha256: hashSecret(token),
      expiresAt: new Date(at.getTime() + parsed.data.expiresInDays * DAY_MS),
      maxClaims: parsed.data.maxClaims,
    });
    if (invite === null) return c.json(NOT_FOUND, 404);
    noteAuditResource(c, invite.id);
    c.header("Cache-Control", "no-store");
    return c.json(
      createdContributorInviteResponseSchema.parse({
        invite: inviteDto(invite, at),
        token,
        claimUrl: inviteUrl(token),
      }),
      201,
    );
  });

  app.get(`${base}/versions/:vid/contributors`, async (c) => {
    const denied = adminOnly(c);
    if (denied !== undefined) return denied;
    const owner = c.get("member").organizationId;
    const versionId = c.req.param("vid");
    if ((await options.sandboxes.getVersion(owner, versionId)) === null)
      return c.json(NOT_FOUND, 404);
    const at = now();
    const [invites, contributors] = await Promise.all([
      options.contributors?.listInvites(owner, versionId) ?? [],
      options.contributors?.listAssignments(owner, versionId) ?? [],
    ]);
    return c.json(
      contributorListResponseSchema.parse({
        invites: invites.map((invite) => inviteDto(invite, at)),
        contributors: contributors.map(assignmentDto),
      }),
    );
  });

  app.post(`${base}/invites/:id/revoke`, async (c) => {
    const denied = adminOnly(c);
    if (denied !== undefined) return denied;
    const at = now();
    const revoked = await options.contributors?.revokeInvite(
      c.get("member").organizationId,
      c.req.param("id"),
      at,
    );
    if (revoked === undefined || revoked === null)
      return c.json(NOT_FOUND, 404);
    return c.json(
      contributorInviteResponseSchema.parse({ invite: inviteDto(revoked, at) }),
    );
  });

  app.post(`${base}/contributors/:id/revoke`, async (c) => {
    const denied = adminOnly(c);
    if (denied !== undefined) return denied;
    const revoked = await options.contributors?.revokeAssignment(
      c.get("member").organizationId,
      c.req.param("id"),
      now(),
    );
    if (revoked === undefined || revoked === null)
      return c.json(NOT_FOUND, 404);
    return c.json(
      contributorAssignmentResponseSchema.parse({
        contributor: assignmentDto(revoked),
      }),
    );
  });

  // The contributor's side: a signed-in person and their own assignments.

  app.post("/api/v1/invites/claim", async (c) => {
    const user = c.get("user");
    const allowed = claims.take(user.id);
    if (!allowed.ok) {
      c.header("Retry-After", String(allowed.retryAfterSeconds));
      return c.json(
        {
          error: "Too many invite claims. Wait a while and try again.",
          code: "rate_limited",
        },
        429,
      );
    }
    const parsed = claimInviteSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json({ error: "Invalid claim.", code: "invalid_claim" }, 400);
    if (options.contributors === undefined) return c.json(UNAVAILABLE, 404);
    const hash = hashSecret(parsed.data.token);
    const invite = await options.contributors.findInvite(hash);
    // Found by its hash; compared again in constant time all the same,
    // against what is stored rather than trusting the lookup.
    if (
      invite === null ||
      !timingSafeEqual(
        Buffer.from(hash, "hex"),
        Buffer.from(invite.tokenSha256, "hex"),
      )
    )
      return c.json(UNAVAILABLE, 404);
    const owner = invite.organizationId;
    c.set("auditOrganizationId", owner);
    // A member works on it from the workspace; their claim would only
    // spend the invite.
    if ((await options.roleOf?.(user.id, owner)) !== undefined)
      return c.json(
        {
          error:
            "You are a member of this workspace; work on the version from the workspace.",
          code: "already_member",
        },
        409,
      );
    const at = now();
    const found = await standing(owner, invite.sandboxVersionId);
    if (found === null || !found.open) return c.json(UNAVAILABLE, 404);
    const claimed = await options.contributors.claim(
      owner,
      invite.id,
      user.id,
      at,
    );
    if (!claimed.ok) return c.json(UNAVAILABLE, 404);
    const contribution = await contributionOf(claimed.assignment);
    if (contribution === null) return c.json(UNAVAILABLE, 404);
    return c.json(
      contributionResponseSchema.parse({ contribution }),
      claimed.created ? 201 : 200,
    );
  });

  /** The version's public listing, from its project's `sandbox-task.json`. */
  const listingOf = async (owner: string, versionId: string) => {
    const none = {
      title: null,
      specSummary: null,
      complexity: null,
      tags: [],
      commands: null,
      editablePaths: [],
      nodeRange: null,
    };
    const project = await publicProject(options, owner, versionId);
    const file = project?.files.find(
      (entry) => entry.path === TASK_DESCRIPTOR_PATH,
    );
    if (file === undefined) return none;
    const bytes = await options.objects.get(file.objectKey);
    if (
      bytes === undefined ||
      createHash("sha256").update(bytes).digest("hex") !== file.sha256
    )
      return none;
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      return none;
    }
    const descriptor = taskDescriptorSchema.safeParse(json);
    if (!descriptor.success) return none;
    const { title, specSummary, complexity, tags, commands, toolchain } =
      descriptor.data;
    return {
      title,
      specSummary,
      complexity,
      tags: [...tags],
      commands: { ...commands },
      editablePaths: [...descriptor.data.editablePaths],
      nodeRange: toolchain.nodeRange,
    };
  };

  const contributionOf = async (
    assignment: StoredContributorAssignment,
  ): Promise<ContributionDto | null> => {
    const owner = assignment.organizationId;
    const found = await standing(owner, assignment.sandboxVersionId);
    if (found === null) return null;
    const { version } = found.stored;
    return {
      assignmentId: assignment.id,
      versionId: version.id,
      version: version.version,
      root: rootOf(version.sandboxId, version.version),
      ...(await listingOf(owner, version.id)),
      open: found.open,
      closesAt: found.closesAt,
      joinedAt: assignment.createdAt.toISOString(),
    };
  };

  /**
   * The caller's live assignment to the path's version, or null. Noted
   * for the audit trail: a contributor credential's write is recorded in
   * the workspace whose version it is.
   */
  const assigned = async (c: Context<Env>) => {
    const found =
      (await options.contributors?.assignmentFor(
        c.get("user").id,
        c.req.param("vid") ?? "",
      )) ?? null;
    if (found !== null) c.set("auditOrganizationId", found.organizationId);
    return found;
  };

  app.get("/api/v1/contributions", async (c) => {
    const assignments =
      (await options.contributors?.assignmentsOf(c.get("user").id)) ?? [];
    const contributions = (
      await Promise.all(assignments.map(contributionOf))
    ).filter((entry) => entry !== null);
    return c.json(contributionListSchema.parse({ contributions }));
  });

  const CONTRIBUTION = "/api/v1/contributions/:vid";

  app.get(CONTRIBUTION, async (c) => {
    const assignment = await assigned(c);
    const contribution =
      assignment === null ? null : await contributionOf(assignment);
    if (contribution === null) return c.json(NOT_FOUND, 404);
    return c.json(contributionResponseSchema.parse({ contribution }));
  });

  app.get(`${CONTRIBUTION}/handout`, async (c) => {
    const assignment = await assigned(c);
    if (assignment === null) return c.json(NOT_FOUND, 404);
    return handoutResponse(
      c,
      options,
      assignment.organizationId,
      assignment.sandboxVersionId,
    );
  });

  app.get(`${CONTRIBUTION}/archive`, async (c) => {
    const assignment = await assigned(c);
    if (assignment === null) return c.json(NOT_FOUND, 404);
    return archiveResponse(
      c,
      options,
      assignment.organizationId,
      assignment.sandboxVersionId,
    );
  });

  app.get(`${CONTRIBUTION}/handout/files`, async (c) => {
    const assignment = await assigned(c);
    if (assignment === null) return c.json(NOT_FOUND, 404);
    return handoutFilesResponse(
      c,
      options,
      assignment.organizationId,
      assignment.sandboxVersionId,
    );
  });

  /** The caller's own submission to their version, or null. */
  const mine = async (
    assignment: StoredContributorAssignment,
    submissionId: string,
    userId: string,
  ) => {
    const found = await options.submissions?.get(
      assignment.organizationId,
      submissionId,
    );
    return found === undefined ||
      found === null ||
      found.sandboxVersionId !== assignment.sandboxVersionId ||
      found.submittedBy !== userId
      ? null
      : found;
  };
  const notOpen = (c: Context<Env>) =>
    c.json(
      {
        error: "This version no longer takes submissions.",
        code: "not_open",
      },
      409,
    );
  const answer =
    (c: Context<Env>) => (submission: StoredSubmission, status: 200 | 202) =>
      c.json(
        contributionSubmissionResponseSchema.parse({
          submission: contributionSubmissionOf(submission),
        }),
        status,
      );

  app.get(`${CONTRIBUTION}/submissions`, async (c) => {
    const assignment = await assigned(c);
    if (assignment === null) return c.json(NOT_FOUND, 404);
    const listed =
      (await options.submissions?.list(
        assignment.organizationId,
        assignment.sandboxVersionId,
        { submittedBy: c.get("user").id },
      )) ?? [];
    return c.json(
      contributionSubmissionListSchema.parse({
        submissions: listed.map(contributionSubmissionOf),
      }),
    );
  });

  app.get(`${CONTRIBUTION}/submissions/:sid`, async (c) => {
    const assignment = await assigned(c);
    const found =
      assignment === null
        ? null
        : await mine(assignment, c.req.param("sid"), c.get("user").id);
    if (found === null) return c.json(NOT_FOUND, 404);
    return c.json(
      contributionSubmissionResponseSchema.parse({
        submission: contributionSubmissionOf(found),
      }),
    );
  });

  /** How a submission's files arrive: `files[]` JSON or a zipped folder. */
  type Receive = (
    c: Context<Env>,
    stores: ReceivingStores,
    owner: string,
    versionOf: () => Promise<string | null>,
  ) => Promise<Received>;

  const submit = (receive: Receive) => async (c: Context<Env>) => {
    const assignment = await assigned(c);
    if (assignment === null) return c.json(NOT_FOUND, 404);
    const owner = assignment.organizationId;
    const user = c.get("user");
    if (!(await standing(owner, assignment.sandboxVersionId))?.open)
      return notOpen(c);
    const received = await receive(
      c,
      options,
      owner,
      async () => assignment.sandboxVersionId,
    );
    if ("response" in received) return received.response;
    const created = await received.store.create(owner, {
      sandboxVersionId: received.versionId,
      submittedBy: user.id,
      assignmentId: assignment.id,
      patchKey: received.patchKey,
      patchSha256: received.patchSha256,
    });
    if (!created.ok) {
      if (created.reason === "already_submitted")
        return c.json(
          {
            error:
              "You have already submitted to this version; retry that submission instead.",
            code: "already_submitted",
            submissionId: created.submissionId,
          },
          409,
        );
      return created.reason === "not_frozen"
        ? notOpen(c)
        : c.json(NOT_FOUND, 404);
    }
    return gradeSubmission(c, options, owner, created, {
      requestedBy: user.id,
      answer: answer(c),
    });
  };
  app.post(`${CONTRIBUTION}/submissions`, submit(receiveFiles));
  // The whole project folder, zipped: what it changes is the submission
  // (`folder-upload.ts`); `?dryRun=1` only says what that would be.
  app.post(
    `${CONTRIBUTION}/submissions/zip`,
    folderBodyLimit,
    submit(receiveFolder),
  );

  const retry = (receive: Receive) => async (c: Context<Env>) => {
    const assignment = await assigned(c);
    const user = c.get("user");
    const original =
      assignment === null
        ? null
        : await mine(assignment, c.req.param("sid") ?? "", user.id);
    if (assignment === null || original === null) return c.json(NOT_FOUND, 404);
    const owner = assignment.organizationId;
    if (!(await standing(owner, assignment.sandboxVersionId))?.open)
      return notOpen(c);
    const received = await receive(
      c,
      options,
      owner,
      async () => original.sandboxVersionId,
    );
    if ("response" in received) return received.response;
    const made = await received.store.retry(owner, original.id, {
      submittedBy: user.id,
      assignmentId: assignment.id,
      patchKey: received.patchKey,
      patchSha256: received.patchSha256,
    });
    if (!made.ok)
      return made.reason === "not-found"
        ? c.json(NOT_FOUND, 404)
        : c.json(
            { error: RETRY_REFUSALS[made.reason], code: made.reason },
            409,
          );
    return gradeSubmission(c, options, owner, made, {
      regrade: made.regrade === true,
      requestedBy: user.id,
      answer: answer(c),
    });
  };
  app.post(`${CONTRIBUTION}/submissions/:sid/retry`, retry(receiveFiles));
  app.post(
    `${CONTRIBUTION}/submissions/:sid/retry/zip`,
    folderBodyLimit,
    retry(receiveFolder),
  );

  /*
    An errored submission of theirs graded again with its own files: the
    platform's failure, so no retry is spent, and it is taken while their
    access stands even once the version stops taking new work.
  */
  app.post(`${CONTRIBUTION}/submissions/:sid/regrade`, async (c) => {
    const assignment = await assigned(c);
    const user = c.get("user");
    const found =
      assignment === null
        ? null
        : await mine(assignment, c.req.param("sid"), user.id);
    if (assignment === null || found === null) return c.json(NOT_FOUND, 404);
    if (found.status !== "errored")
      return c.json(
        {
          error: "Only a submission that could not be graded is graded again.",
          code: "not_errored",
        },
        409,
      );
    return gradeSubmission(
      c,
      options,
      assignment.organizationId,
      { submission: found, created: false },
      { regrade: true, requestedBy: user.id, answer: answer(c) },
    );
  });
}
