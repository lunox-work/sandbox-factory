/**
 * A bounty's sources, synced into it as context: its Jira issue's fields
 * beyond its text, and its repository's documents. Each sync a person asks
 * for reads the source now and keeps what it found as the source's next
 * context version when it is new (`BountyContextStore.record`). Sizing and
 * generation read the context the bounty holds (`heldContext`) and record
 * the versions they were made with.
 *
 * - `GET .../bounties/:id/context` says where each source stands against
 *   its latest sync: Jira's issue read for its `updated`, the repository's
 *   newest snapshot read for its commit.
 * - `POST .../bounties/:id/context/jira/sync` reads the issue's context and
 *   its text, which the bounty takes as a run's read does.
 * - `POST .../bounties/:id/context/github/sync` reads the documents at the
 *   repository's newest snapshot.
 *
 * Any member may read and sync, as any member may link a source. A sync is
 * not held back by an approved overview, as Jira's text is not: the steps
 * after it show what they were made with instead.
 */

import type {
  BountyContextStore,
  BountyProposalStore,
  BountyStore,
  GithubRepoSummary,
  JiraBoardStore,
  LatestBountyContext,
  RepoSnapshotStore,
  StoredBounty,
  StoredBountyContext,
} from "@sandbox-factory/db";
import { GithubNotFound } from "@sandbox-factory/github";
import { JiraApiError, JiraAuthError } from "@sandbox-factory/jira";
import {
  bountyContextResponseSchema,
  bountyContextVersionDtoSchema,
  syncBountyContextResponseSchema,
  type BountyContextResponse,
  type BountyContextSourceStatusDto,
  type BountyContextVersionDto,
  type StoredTree,
} from "@sandbox-factory/shared";
import type { Context, Hono } from "hono";
import {
  contextDocuments,
  contextKeywords,
  keptDocuments,
  type GithubContext,
  type JiraContext,
} from "sandbox-factory";

import type { RunClientResult } from "../pricing/executor.js";
import { mapConcurrent } from "../pricing/review.js";
import { contextHash, contextRepoId } from "./held-context.js";
import { detail, type BountyRouteOptions } from "./routes.js";

/** Reads one repository's files by Git object id. */
export interface DocumentReader {
  blobText(fullName: string, sha: string): Promise<string>;
}

/**
 * What reading a repository's documents needs: its pointer, its newest
 * snapshot and that snapshot's file list, and a reader narrowed to it.
 * Absent where GitHub or object storage is not configured.
 */
export interface GithubContextSource {
  readonly repos: {
    get(
      organizationId: string,
      repoId: string,
    ): Promise<GithubRepoSummary | null>;
  };
  readonly snapshots: Pick<RepoSnapshotStore, "current">;
  readonly tree: (treeKey: string) => Promise<StoredTree | null>;
  /** A reader for the repository; null when its connection cannot read. */
  readonly readerFor: (
    organizationId: string,
    repo: GithubRepoSummary,
  ) => Promise<DocumentReader | null>;
}

export interface BountyContextOptions extends BountyRouteOptions {
  readonly bounties: BountyStore;
  readonly proposals: Pick<BountyProposalStore, "get" | "liveForBounty">;
  readonly contexts: BountyContextStore;
  readonly boards: Pick<JiraBoardStore, "forRun">;
  /** A Jira site's client; absent, Jira is not configured here. */
  readonly clientFor?: (
    organizationId: string,
    connectionId: string,
  ) => Promise<RunClientResult>;
  readonly githubContext?: GithubContextSource;
}

interface BountyContextAppEnv {
  Variables: {
    user: { id: string };
    member: { organizationId: string; role: string };
  };
}

/** Documents read at once, so one sync does not burst the rate limit. */
const DOCUMENT_READ_CONCURRENCY = 4;

function versionDto(stored: StoredBountyContext): BountyContextVersionDto {
  return bountyContextVersionDtoSchema.parse({
    source: stored.source,
    version: stored.version,
    ref: stored.ref,
    revision: stored.revision,
    syncedBy: stored.syncedBy,
    createdAt: stored.createdAt,
    checkedAt: stored.checkedAt,
    content: stored.content,
  });
}

/** A source's status with nothing to say but its state. */
function status(
  state: BountyContextSourceStatusDto["state"],
  extra: Partial<BountyContextSourceStatusDto> = {},
): BountyContextSourceStatusDto {
  return {
    state,
    reason: null,
    linked: null,
    liveRevision: null,
    latest: null,
    ...extra,
  };
}

/** Whether one Jira `updated` is later than another. */
function later(live: string, synced: string): boolean {
  const a = Date.parse(live);
  const b = Date.parse(synced);
  return Number.isFinite(a) && Number.isFinite(b) ? a > b : live !== synced;
}

function needsReconnect(error: unknown): boolean {
  return (
    (error instanceof JiraAuthError && error.needsReconnect) ||
    (error instanceof JiraApiError && error.isUnauthorized)
  );
}

/**
 * Where the bounty's Jira issue stands against its latest sync. The issue
 * is read for its `updated` when the bounty holds context from it, the one
 * call this costs, and `live` is used instead when the caller just read it.
 */
async function jiraStatus(
  options: BountyContextOptions,
  organizationId: string,
  bounty: StoredBounty,
  latest: LatestBountyContext,
  live?: string | null,
): Promise<BountyContextSourceStatusDto> {
  const link = bounty.jira;
  if (link === null) return status("unlinked");
  const linked = {
    ref: link.key,
    url: `${link.siteUrl}/browse/${encodeURIComponent(link.key)}`,
  };
  const synced = latest.jira === null ? null : versionDto(latest.jira);
  if (link.removedAt !== null) {
    return status("unavailable", {
      reason: "issue_gone",
      linked,
      latest: synced,
    });
  }
  if (latest.jira === null || latest.jira.refId !== link.externalId) {
    return status("unsynced", { linked, latest: synced });
  }
  let liveRevision = live ?? null;
  if (live === undefined) {
    if (options.clientFor === undefined) {
      return status("unavailable", {
        reason: "reconnect",
        linked,
        latest: synced,
      });
    }
    const ready = await options.clientFor(organizationId, link.connectionId);
    if (!ready.ok) {
      return status("unavailable", {
        reason: ready.reason === "reconnect" ? "reconnect" : "jira_unavailable",
        linked,
        latest: synced,
      });
    }
    try {
      liveRevision = (await ready.client.issue(link.externalId)).updated;
    } catch (error) {
      return status("unavailable", {
        reason: needsReconnect(error)
          ? "reconnect"
          : error instanceof JiraApiError && error.isNotFound
            ? "issue_gone"
            : "jira_failed",
        linked,
        latest: synced,
      });
    }
  }
  return status(
    liveRevision !== null && later(liveRevision, latest.jira.revision)
      ? "ahead"
      : "current",
    { linked, liveRevision, latest: synced },
  );
}

/**
 * Where the bounty's repository stands against its latest sync: ahead
 * once a newer snapshot than the one its documents were read at is there
 * to read.
 */
async function githubStatus(
  options: BountyContextOptions,
  organizationId: string,
  bounty: StoredBounty,
  latest: LatestBountyContext,
): Promise<BountyContextSourceStatusDto> {
  const repoId = await contextRepoId(options.boards, organizationId, bounty);
  const synced = latest.github === null ? null : versionDto(latest.github);
  if (repoId === null) return status("unlinked", { latest: synced });
  const source = options.githubContext;
  if (source === undefined) {
    return status("unavailable", { reason: "unconfigured", latest: synced });
  }
  const repo = await source.repos.get(organizationId, repoId);
  if (repo === null) return status("unlinked", { latest: synced });
  const linked = {
    ref: repo.fullName,
    url: `https://github.com/${repo.fullName}`,
  };
  if (repo.syncStatus === "gone") {
    return status("unavailable", {
      reason: "repository_gone",
      linked,
      latest: synced,
    });
  }
  const snapshot = await source.snapshots.current(organizationId, repoId);
  const liveRevision = snapshot?.commitSha ?? null;
  if (latest.github === null || latest.github.refId !== repoId) {
    return status("unsynced", { linked, liveRevision, latest: synced });
  }
  return status(
    liveRevision !== null && liveRevision !== latest.github.revision
      ? "ahead"
      : "current",
    { linked, liveRevision, latest: synced },
  );
}

async function contextStatus(
  options: BountyContextOptions,
  organizationId: string,
  bounty: StoredBounty,
  jiraLive?: string | null,
): Promise<BountyContextResponse> {
  const latest = (await options.contexts.latest(organizationId, bounty.id)) ?? {
    jira: null,
    github: null,
  };
  const [jira, github] = await Promise.all([
    jiraStatus(options, organizationId, bounty, latest, jiraLive),
    githubStatus(options, organizationId, bounty, latest),
  ]);
  return bountyContextResponseSchema.parse({ jira, github });
}

type SyncResult =
  | {
      readonly ok: true;
      readonly changed: boolean;
      readonly jiraLive?: string | null;
    }
  | {
      readonly ok: false;
      readonly status: 404 | 409 | 502 | 503;
      readonly code: string;
      readonly error: string;
    };

const refused = (
  status: 404 | 409 | 502 | 503,
  code: string,
  error: string,
): SyncResult => ({ ok: false, status, code, error });

/** Reads the issue's context and text, and keeps both. */
async function syncJira(
  options: BountyContextOptions,
  organizationId: string,
  bounty: StoredBounty,
  userId: string,
): Promise<SyncResult> {
  const link = bounty.jira;
  if (link === null || link.removedAt !== null) {
    return refused(
      409,
      "no_jira_issue",
      "The bounty follows no Jira issue to sync.",
    );
  }
  const reconnect = refused(
    409,
    "reconnect",
    "This Jira connection needs reconnecting.",
  );
  if (options.clientFor === undefined) return reconnect;
  const ready = await options.clientFor(organizationId, link.connectionId);
  if (!ready.ok) {
    return ready.reason === "not-found"
      ? refused(404, "not_found", "Not found")
      : reconnect;
  }
  let context: JiraContext;
  let spec: Awaited<ReturnType<typeof ready.client.issueSpec>>;
  try {
    [context, spec] = await Promise.all([
      ready.client.issueContext(link.externalId),
      ready.client.issueSpec(link.externalId),
    ]);
  } catch (error) {
    if (error instanceof JiraApiError && error.isNotFound) {
      return refused(404, "issue_not_found", "That Jira issue was not found.");
    }
    return needsReconnect(error)
      ? reconnect
      : refused(502, "jira_failed", "Jira could not be read.");
  }
  // The text a run's read would write; nothing when it already says it.
  await options.bounties.refreshFromJira(organizationId, bounty.id, {
    title: spec.summary,
    description: spec.descriptionText,
    components: spec.components,
    inputTruncated: spec.inputTruncated,
  });
  const recorded = await options.contexts.record(
    organizationId,
    bounty.id,
    {
      source: "jira",
      ref: link.key,
      refId: link.externalId,
      revision: context.updated ?? spec.updated ?? new Date().toISOString(),
      content: context,
      contentHash: contextHash({ source: "jira", content: context }),
    },
    userId,
  );
  if (!recorded.ok) return refused(404, "not_found", "Not found");
  return { ok: true, changed: recorded.changed, jiraLive: context.updated };
}

/** Reads the documents at the repository's newest snapshot, and keeps them. */
async function syncGithub(
  options: BountyContextOptions,
  organizationId: string,
  bounty: StoredBounty,
  userId: string,
): Promise<SyncResult> {
  const repoId = await contextRepoId(options.boards, organizationId, bounty);
  if (repoId === null) {
    return refused(
      409,
      "no_repository",
      "The bounty names no repository to sync.",
    );
  }
  const source = options.githubContext;
  if (source === undefined) {
    return refused(503, "unconfigured", "GitHub is not set up on this server.");
  }
  const repo = await source.repos.get(organizationId, repoId);
  if (repo === null) return refused(404, "not_found", "Not found");
  const gone = refused(
    409,
    "repository_gone",
    "The repository is no longer reachable on GitHub.",
  );
  if (repo.syncStatus === "gone") return gone;
  const snapshot = await source.snapshots.current(organizationId, repoId);
  if (snapshot === null) {
    return refused(
      409,
      "no_snapshot",
      "The repository has no snapshot yet. Try again once it has been read.",
    );
  }
  const tree = await source.tree(snapshot.treeKey);
  if (tree === null) {
    return refused(
      502,
      "tree_unavailable",
      "The repository's file list could not be read.",
    );
  }
  const reader = await source.readerFor(organizationId, repo);
  if (reader === null) {
    return refused(
      409,
      "connection_unhealthy",
      "The repository's GitHub connection cannot read it.",
    );
  }
  const blobs = tree.entries.filter((entry) => entry.type === "blob");
  const chosen = contextDocuments(blobs, contextKeywords(bounty.title));
  const byPath = new Map(blobs.map((entry) => [entry.path, entry]));
  let read: { path: string; bytes: number; text: string }[];
  try {
    read = await mapConcurrent(
      chosen.paths,
      DOCUMENT_READ_CONCURRENCY,
      async (path) => {
        const entry = byPath.get(path);
        return {
          path,
          bytes: entry?.size ?? 0,
          text:
            entry === undefined
              ? ""
              : await reader.blobText(repo.fullName, entry.sha),
        };
      },
    );
  } catch (error) {
    return error instanceof GithubNotFound
      ? gone
      : refused(502, "github_failed", "GitHub could not be read.");
  }
  const kept = keptDocuments(read);
  const content: GithubContext = {
    fullName: repo.fullName,
    branch: snapshot.ref.replace(/^refs\/heads\//, ""),
    commitSha: snapshot.commitSha,
    documents: kept.documents,
    omitted: chosen.omitted + kept.omitted,
  };
  const recorded = await options.contexts.record(
    organizationId,
    bounty.id,
    {
      source: "github",
      ref: repo.fullName,
      refId: repo.id,
      revision: snapshot.commitSha,
      content,
      contentHash: contextHash({ source: "github", content }),
    },
    userId,
  );
  if (!recorded.ok) return refused(404, "not_found", "Not found");
  return { ok: true, changed: recorded.changed };
}

export function mountBountyContextRoutes<Env extends BountyContextAppEnv>(
  app: Hono<Env>,
  options: BountyContextOptions,
): void {
  const base = "/api/v1/orgs/:orgId/bounties/:id/context";

  app.get(base, async (c) => {
    const { organizationId } = c.get("member");
    const bounty = await options.bounties.get(
      organizationId,
      c.req.param("id"),
    );
    if (bounty === null) return c.json({ error: "Not found" }, 404);
    return c.json(await contextStatus(options, organizationId, bounty));
  });

  app.post(`${base}/:source/sync`, async (c) => {
    const { organizationId } = c.get("member");
    const source = c.req.param("source");
    if (source !== "jira" && source !== "github") {
      return c.json({ error: "Not found" }, 404);
    }
    const bountyId = c.req.param("id");
    const bounty = await options.bounties.get(organizationId, bountyId);
    if (bounty === null) return c.json({ error: "Not found" }, 404);
    const sync = source === "jira" ? syncJira : syncGithub;
    const result = await sync(
      options,
      organizationId,
      bounty,
      c.get("user").id,
    );
    return answer(c, options, organizationId, bountyId, result);
  });
}

async function answer(
  c: Context,
  options: BountyContextOptions,
  organizationId: string,
  bountyId: string,
  result: SyncResult,
): Promise<Response> {
  if (!result.ok) {
    return c.json({ code: result.code, error: result.error }, result.status);
  }
  // Read again: a Jira sync may have taken the issue's text.
  const bounty = await options.bounties.get(organizationId, bountyId);
  if (bounty === null) return c.json({ error: "Not found" }, 404);
  const [dto, context] = await Promise.all([
    detail(options, bounty),
    contextStatus(options, organizationId, bounty, result.jiraLive),
  ]);
  return c.json(
    syncBountyContextResponseSchema.parse({
      bounty: dto,
      context,
      changed: result.changed,
    }),
  );
}
