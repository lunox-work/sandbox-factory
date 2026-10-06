/**
 * The GitHub wire contract: GitHub's payloads in, our DTOs out.
 *
 * The same two families as `jira.ts`, and for the same reasons:
 *
 * - `*Response` schemas describe what **GitHub sends**: REST responses and
 *   webhook deliveries. They are `.loose()` and require only what GitHub
 *   guarantees, because GitHub adds fields continuously and an unknown one
 *   must not turn a delivery into a failure. Parsed by `packages/github` and
 *   the webhook route.
 * - `*Dto` schemas describe what **we hand on** to the web app. Strict,
 *   because we produce them.
 *
 * No token material appears in any DTO. A grant's tokens live encrypted in
 * `github_grant` and never leave the API; an installation token is minted per
 * call and never stored at all.
 */

import { TREE_FACTS_VERSION } from "sandbox-factory";
import { z } from "zod";

import { stackDtoSchema } from "./stack.js";

/* -------------------------------------------------------------------------- */
/* What GitHub sends                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A timestamp as GitHub spells it, which depends on where it came from.
 *
 * REST responses and most webhook payloads send ISO strings. The `push`
 * event sends `repository.pushed_at` and `created_at` as **Unix seconds**,
 * the one place the same field changes type. Both are accepted and read as
 * ISO by `githubTimestamp`.
 */
const timestampSchema = z.union([z.string(), z.number()]).nullable();

/** An ISO string from either spelling, or null when GitHub sent none. */
export function githubTimestamp(
  value: string | number | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  const date =
    typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The account an installation lives on: a user or an organization. */
const accountResponseSchema = z
  .object({
    login: z.string(),
    id: z.number().optional(),
    /** `User` or `Organization`; an enterprise account says `Enterprise`. */
    type: z.string().optional(),
  })
  .loose();

/**
 * One installation of the App, as `GET /user/installations`,
 * `GET /app/installations/{id}` and every webhook's `installation` describe
 * it. Webhooks other than `installation` itself send a stub with only `id`,
 * which is why everything else is optional here.
 */
export const githubInstallationResponseSchema = z
  .object({
    id: z.number().int(),
    account: accountResponseSchema.nullable().optional(),
    /** `all` or `selected`. Which repositories the client let us see. */
    repository_selection: z.string().optional(),
    /** As granted, e.g. `{ contents: "read", metadata: "read" }`. */
    permissions: z.record(z.string(), z.string()).optional(),
    suspended_at: z.string().nullable().optional(),
  })
  .loose();

export const githubInstallationPageResponseSchema = z
  .object({
    total_count: z.number().optional(),
    installations: z.array(githubInstallationResponseSchema),
  })
  .loose();

/** A repository, from REST or from a webhook. */
export const githubRepositoryResponseSchema = z
  .object({
    /** The numeric id. Survives renames and transfers; the name does not. */
    id: z.number().int(),
    full_name: z.string(),
    private: z.boolean().optional(),
    default_branch: z.string().optional(),
    /** Kilobytes, as GitHub estimates it. The pre-fetch size gate. */
    size: z.number().optional(),
    pushed_at: timestampSchema.optional(),
  })
  .loose();

export const githubRepositoryPageResponseSchema = z
  .object({
    total_count: z.number().optional(),
    repository_selection: z.string().optional(),
    repositories: z.array(githubRepositoryResponseSchema),
  })
  .loose();

/** `GET /user`: who a user-to-server token belongs to. */
export const githubUserResponseSchema = z
  .object({
    login: z.string(),
    id: z.number().int(),
  })
  .loose();

/** `GET /repos/{o}/{r}/git/ref/heads/{branch}`. */
export const githubRefResponseSchema = z
  .object({
    ref: z.string().optional(),
    object: z.object({ sha: z.string() }).loose(),
  })
  .loose();

/** `GET /repos/{o}/{r}/branches`: one page of branches, each with its head. */
export const githubBranchPageResponseSchema = z.array(
  z
    .object({
      name: z.string(),
      commit: z.object({ sha: z.string() }).loose(),
    })
    .loose(),
);

/**
 * One entry of `GET /repos/{o}/{r}/git/trees/{sha}?recursive=1`: a file
 * (`blob`), a directory (`tree`) or a submodule (`commit`). Only a blob has
 * a `size`.
 */
export const githubTreeEntryResponseSchema = z
  .object({
    path: z.string(),
    mode: z.string(),
    type: z.string(),
    sha: z.string(),
    size: z.number().optional(),
  })
  .loose();

/**
 * A recursive tree. `sha` is the root tree's own, whatever commit it was
 * asked for by. `truncated` is GitHub's cap (100,000 entries or 7 MB) cutting
 * the listing short.
 */
export const githubTreeResponseSchema = z
  .object({
    sha: z.string(),
    truncated: z.boolean().optional(),
    tree: z.array(githubTreeEntryResponseSchema),
  })
  .loose();

/** `GET /repos/{o}/{r}/languages`: bytes of code per language. */
export const githubLanguagesResponseSchema = z.record(z.string(), z.number());

/**
 * `GET /repos/{o}/{r}/git/blobs/{sha}`: one file's bytes, base64 encoded,
 * by Git's object id.
 */
export const githubBlobResponseSchema = z
  .object({
    sha: z.string(),
    content: z.string(),
    encoding: z.string(),
  })
  .loose();

/** `POST /app/installations/{id}/access_tokens`. */
export const githubInstallationTokenResponseSchema = z
  .object({
    token: z.string().min(1),
    expires_at: z.string(),
  })
  .loose();

/**
 * `POST https://github.com/login/oauth/access_token`, success or failure.
 *
 * One schema for both because GitHub answers a refused exchange with **200**
 * and `{ error, error_description }` in place of the tokens. The caller
 * branches on `error`, not on the status.
 */
export const githubOAuthTokenResponseSchema = z
  .object({
    access_token: z.string().min(1).optional(),
    /** Seconds. Absent when the App does not expire user tokens. */
    expires_in: z.number().optional(),
    refresh_token: z.string().min(1).optional(),
    refresh_token_expires_in: z.number().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  })
  .loose();

/* ---- webhook deliveries -------------------------------------------------- */

/** The `installation` stub every App webhook carries. */
const installationStubSchema = z.object({ id: z.number().int() }).loose();

/** Enough of any delivery to find whose it is. */
export const githubWebhookEnvelopeSchema = z
  .object({
    action: z.string().optional(),
    installation: installationStubSchema.optional(),
  })
  .loose();

export const githubInstallationEventSchema = z
  .object({
    action: z.string(),
    installation: githubInstallationResponseSchema,
  })
  .loose();

const repositoryStubSchema = z
  .object({ id: z.number().int(), full_name: z.string().optional() })
  .loose();

export const githubInstallationRepositoriesEventSchema = z
  .object({
    action: z.string(),
    installation: githubInstallationResponseSchema,
    repository_selection: z.string().optional(),
    repositories_added: z.array(repositoryStubSchema).optional(),
    repositories_removed: z.array(repositoryStubSchema).optional(),
  })
  .loose();

export const githubPushEventSchema = z
  .object({
    /** `refs/heads/<branch>` or `refs/tags/<tag>`. */
    ref: z.string(),
    /** All zeros when the push deleted the ref. */
    after: z.string(),
    deleted: z.boolean().optional(),
    repository: githubRepositoryResponseSchema,
    installation: installationStubSchema.optional(),
  })
  .loose();

export const githubRepositoryEventSchema = z
  .object({
    action: z.string(),
    repository: githubRepositoryResponseSchema,
    changes: z
      .object({
        default_branch: z.object({ from: z.string() }).loose().optional(),
      })
      .loose()
      .optional(),
    installation: installationStubSchema.optional(),
  })
  .loose();

/**
 * The headers a delivery arrives with, lowercased as Hono reads them.
 *
 * `signature` is the HMAC-SHA256 of the raw body under the App's webhook
 * secret, as `sha256=<hex>`. Never `X-Hub-Signature`, which is SHA-1.
 */
export const GITHUB_WEBHOOK_HEADERS = {
  event: "x-github-event",
  delivery: "x-github-delivery",
  signature: "x-hub-signature-256",
} as const;

/* -------------------------------------------------------------------------- */
/* What we hand on                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `source` is a client repository read for analysis; `sandbox` is a
 * destination a published version is written to. Registration from a
 * connection accepts `source` only; a `sandbox` repository arrives through
 * the publication gate of the sandbox plan.
 */
export const GITHUB_REPO_ROLES = ["source", "sandbox"] as const;
export const githubRepoRoleSchema = z.enum(GITHUB_REPO_ROLES);

/**
 * Where a registered repository's pointer stands.
 *
 * - `pending` — registered, not yet read, or put back after being re-added.
 * - `ok` — the head was read and recorded.
 * - `error` — the last read failed; `syncError` says why in one line.
 * - `gone` — GitHub says it no longer exists for us: deleted, removed from
 *   the installation, or the App uninstalled. The row is kept so whatever
 *   referenced it can still say what it was.
 */
export const GITHUB_SYNC_STATUSES = ["pending", "ok", "error", "gone"] as const;
export const githubSyncStatusSchema = z.enum(GITHUB_SYNC_STATUSES);

/** One installation linked to an organization. */
export const githubConnectionDtoSchema = z.strictObject({
  id: z.string(),
  /** GitHub's numeric id, as a string like every external id here. */
  installationId: z.string(),
  accountLogin: z.string(),
  accountType: z.string(),
  repositorySelection: z.string(),
  /** False once the App was uninstalled or suspended on GitHub's side. */
  healthy: z.boolean(),
  suspendedAt: z.string().nullable(),
  /** Set once GitHub said the installation is gone. Final: reinstalling is a new installation. */
  uninstalledAt: z.string().nullable(),
  /** The installation's settings page on GitHub; see the helper below. */
  settingsUrl: z.string(),
  createdAt: z.string(),
});

/**
 * The signed-in person's own GitHub grant, as the picker names it ("the
 * installations @login can see"). Never the tokens.
 */
export const githubGrantDtoSchema = z.strictObject({
  githubLogin: z.string(),
  healthy: z.boolean(),
});

/**
 * An installation the signed-in person can see, and where it stands for this
 * organization: `linked` here, `claimed` by another organization, or `free`.
 * Which organization claimed it is never said.
 *
 * A free one may still not be theirs to link. Seeing an installation is not
 * administering it — an outside collaborator on one repository sees the
 * whole organization's — so `not-authorized` is one on an account that is
 * not theirs, or that covers repositories they cannot read themselves, and
 * `unavailable` one GitHub will not let us check (suspended, or uninstalled
 * a moment ago).
 */
export const GITHUB_INSTALLATION_STATUSES = [
  "linked",
  "claimed",
  "free",
  "not-authorized",
  "unavailable",
] as const;

export const githubAvailableInstallationDtoSchema = z.strictObject({
  installationId: z.string(),
  accountLogin: z.string(),
  accountType: z.string(),
  repositorySelection: z.string(),
  status: z.enum(GITHUB_INSTALLATION_STATUSES),
});

/** A repository an installation can see, live from GitHub. */
export const githubInstallationRepositoryDtoSchema = z.strictObject({
  externalId: z.string(),
  fullName: z.string(),
  defaultBranch: z.string(),
  isPrivate: z.boolean(),
  /** The registered row's id when this one is already registered. */
  registeredId: z.string().nullable(),
});

/** A registered repository: a pointer, never contents. */
export const githubRepoDtoSchema = z.strictObject({
  id: z.string(),
  connectionId: z.string(),
  role: githubRepoRoleSchema,
  externalId: z.string(),
  fullName: z.string(),
  defaultBranch: z.string(),
  isPrivate: z.boolean(),
  sizeKb: z.number().nullable(),
  headSha: z.string().nullable(),
  pushedAt: z.string().nullable(),
  lastSyncedAt: z.string().nullable(),
  syncStatus: githubSyncStatusSchema,
  syncError: z.string().nullable(),
  /**
   * The stack detected at the head, carried onto a bounty about this
   * repository. Null until it has been read once.
   */
  stack: stackDtoSchema.nullable(),
  createdAt: z.string(),
});

/**
 * One file of a stored tree. Blobs and submodules only: directories are
 * implied by the paths under them. `sha` is Git's object id, which is what
 * later pins a copied file to the bytes it was read at; a submodule's is the
 * commit it points at, and its `size` is zero.
 */
export const storedTreeEntrySchema = z.strictObject({
  path: z.string().min(1),
  type: z.enum(["blob", "commit"]),
  mode: z.string(),
  sha: z.string(),
  size: z.number().int().nonnegative(),
});

export const STORED_TREE_VERSION = 1;

/**
 * What `trees/<repoId>/<sha>/<objectId>.json.gz` holds, gzipped: a snapshot's full file
 * list, sorted by path. Paths and sizes only, never contents.
 */
export const storedTreeSchema = z.strictObject({
  version: z.literal(STORED_TREE_VERSION),
  commitSha: z.string(),
  treeSha: z.string(),
  truncated: z.boolean(),
  entries: z.array(storedTreeEntrySchema),
});

const countsSchema = z.record(z.string(), z.number().int().nonnegative());

/** `TreeFacts` from `packages/core`, as stored and sent. */
export const treeFactsDtoSchema = z.strictObject({
  version: z.literal(TREE_FACTS_VERSION),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  testFiles: z.number().int().nonnegative(),
  modules: z.array(
    z.strictObject({
      path: z.string(),
      files: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative(),
      testFiles: z.number().int().nonnegative(),
      extensions: countsSchema,
    }),
  ),
  extensions: countsSchema,
  lockfiles: z.array(z.string()),
  migrationDirectories: z.array(z.string()),
  infraDirectories: z.array(z.string()),
});

/**
 * One snapshot of a registered repository: the commit a branch was at,
 * and what the tree there holds. Immutable once written — the branch moves
 * on, and each new head is a new snapshot. One commit is one snapshot,
 * whichever branch it was first taken from.
 */
export const repoSnapshotDtoSchema = z.strictObject({
  id: z.string(),
  repoId: z.string(),
  commitSha: z.string(),
  /** The branch it was taken from, as `refs/heads/<name>`. */
  ref: z.string(),
  treeSha: z.string(),
  treeTruncated: z.boolean(),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  /** Bytes per language, as GitHub counts them. */
  languages: z.record(z.string(), z.number()),
  createdAt: z.string(),
});

export const repoSnapshotListSchema = z.object({
  snapshots: z.array(repoSnapshotDtoSchema),
});

/** One branch of a registered repository, and the commit it is at. */
export const repoBranchDtoSchema = z.strictObject({
  name: z.string(),
  headSha: z.string(),
  isDefault: z.boolean(),
});

/** `GET .../github/repositories/:id/branches`: the default first, then by name. */
export const repoBranchListSchema = z.object({
  branches: z.array(repoBranchDtoSchema),
  /** More branches than one listing reads; the rest are left out. */
  truncated: z.boolean(),
});

/** `POST .../github/repositories/:id/snapshots`: take a branch's head. */
export const pullSnapshotRequestSchema = z.strictObject({
  branch: z.string().trim().min(1).max(255),
});

/**
 * The head the branch is at, and its snapshot when one is taken already;
 * null while it is being taken, which the list shows once it lands.
 */
export const pullSnapshotResponseSchema = z.object({
  commitSha: z.string(),
  snapshot: repoSnapshotDtoSchema.nullable(),
});

/** One snapshot with its facts, and the repository it is of. */
export const repoSnapshotDetailDtoSchema = repoSnapshotDtoSchema.extend({
  repoFullName: z.string(),
  facts: treeFactsDtoSchema,
});

/** The most entries one page of a stored tree holds. */
export const TREE_PAGE_MAX = 1_000;

/** `GET .../github/snapshots/:id/tree?prefix=&cursor=&limit=`. */
export const repoTreeQuerySchema = z.object({
  /** A directory: only paths under it. Absent or empty: the whole tree. */
  prefix: z.string().max(1_000).optional(),
  /** The last path of the previous page. */
  cursor: z.string().max(4_096).optional(),
  limit: z.coerce.number().int().min(1).max(TREE_PAGE_MAX).default(500),
});

/** One page of a stored tree, in path order. */
export const repoTreePageDtoSchema = z.strictObject({
  entries: z.array(storedTreeEntrySchema),
  /** Pass back as `cursor` for the next page; null on the last. */
  nextCursor: z.string().nullable(),
  /** Whether GitHub cut the listing short when the snapshot was taken. */
  truncated: z.boolean(),
});

/** A numeric id from GitHub, carried as a string. */
const numericIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,18}$/, "Expected a GitHub id.");

/**
 * `POST .../github/connections/:id/repositories`. Registration from a
 * connection creates source repositories only; a `sandbox` destination is
 * created by publication, never by this request.
 */
export const registerRepoRequestSchema = z.object({
  externalId: numericIdSchema,
  role: z.literal("source"),
});

/** `POST .../github/connections`: the picker's submit. */
export const linkInstallationRequestSchema = z.object({
  installationId: numericIdSchema,
});

/**
 * How the connect callback ends, appended to the return path as `?github=`.
 *
 * - `connected` — an installation is linked.
 * - `pick` — several free installations; the web app shows a picker.
 * - `cancelled` — the person declined on GitHub.
 * - `state` — the signed state was missing, expired or not theirs. Also what
 *   an install begun on GitHub's own App page lands as, since nothing on our
 *   side started it; pressing Connect then succeeds.
 * - `forbidden` — no longer an owner or admin by the time they came back.
 * - `not-visible` — the installation named is not one they can see.
 * - `claimed` — it is linked to another organization. Nothing was written.
 * - `not-authorized` — they can see it but it is not theirs to link; see
 *   `GITHUB_INSTALLATION_STATUSES`.
 * - `unavailable` — GitHub would not let us check it: suspended, or gone.
 * - `denied` — GitHub refused the code exchange.
 * - `error` — anything else, including GitHub not answering.
 */
export const GITHUB_CONNECT_OUTCOMES = [
  "connected",
  "pick",
  "cancelled",
  "state",
  "forbidden",
  "not-visible",
  "claimed",
  "not-authorized",
  "unavailable",
  "denied",
  "error",
] as const;
export const githubConnectOutcomeSchema = z.enum(GITHUB_CONNECT_OUTCOMES);

/**
 * The installation's settings page, where the client changes which
 * repositories we see or uninstalls the App. Deleting a connection here does
 * not uninstall anything, so the UI links to this instead.
 */
export function githubInstallationSettingsUrl(
  accountType: string,
  accountLogin: string,
  installationId: string,
): string {
  const id = encodeURIComponent(installationId);
  return accountType === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(accountLogin)}/settings/installations/${id}`
    : `https://github.com/settings/installations/${id}`;
}

export type GithubInstallationResponse = z.infer<
  typeof githubInstallationResponseSchema
>;
export type GithubRepositoryResponse = z.infer<
  typeof githubRepositoryResponseSchema
>;
export type GithubUserResponse = z.infer<typeof githubUserResponseSchema>;
export type GithubTreeResponse = z.infer<typeof githubTreeResponseSchema>;
export type GithubBlobResponse = z.infer<typeof githubBlobResponseSchema>;
export type GithubTreeEntryResponse = z.infer<
  typeof githubTreeEntryResponseSchema
>;
export type GithubLanguagesResponse = z.infer<
  typeof githubLanguagesResponseSchema
>;
export type GithubInstallationEvent = z.infer<
  typeof githubInstallationEventSchema
>;
export type GithubInstallationRepositoriesEvent = z.infer<
  typeof githubInstallationRepositoriesEventSchema
>;
export type GithubPushEvent = z.infer<typeof githubPushEventSchema>;
export type GithubRepositoryEvent = z.infer<typeof githubRepositoryEventSchema>;
export type GithubRepoRole = z.infer<typeof githubRepoRoleSchema>;
export type GithubSyncStatus = z.infer<typeof githubSyncStatusSchema>;
export type GithubConnectionDto = z.infer<typeof githubConnectionDtoSchema>;
export type GithubGrantDto = z.infer<typeof githubGrantDtoSchema>;
export type GithubAvailableInstallationDto = z.infer<
  typeof githubAvailableInstallationDtoSchema
>;
export type GithubInstallationRepositoryDto = z.infer<
  typeof githubInstallationRepositoryDtoSchema
>;
export type GithubRepoDto = z.infer<typeof githubRepoDtoSchema>;
export type StoredTreeEntry = z.infer<typeof storedTreeEntrySchema>;
export type StoredTree = z.infer<typeof storedTreeSchema>;
export type TreeFactsDto = z.infer<typeof treeFactsDtoSchema>;
export type RepoSnapshotDto = z.infer<typeof repoSnapshotDtoSchema>;
export type RepoSnapshotDetailDto = z.infer<typeof repoSnapshotDetailDtoSchema>;
export type RepoBranchDto = z.infer<typeof repoBranchDtoSchema>;
export type RepoBranchList = z.infer<typeof repoBranchListSchema>;
export type PullSnapshotRequest = z.infer<typeof pullSnapshotRequestSchema>;
export type PullSnapshotResponse = z.infer<typeof pullSnapshotResponseSchema>;
export type RepoTreeQuery = z.infer<typeof repoTreeQuerySchema>;
export type RepoTreePageDto = z.infer<typeof repoTreePageDtoSchema>;
export type RegisterRepoRequest = z.infer<typeof registerRepoRequestSchema>;
export type LinkInstallationRequest = z.infer<
  typeof linkInstallationRequestSchema
>;
export type GithubConnectOutcome = z.infer<typeof githubConnectOutcomeSchema>;
