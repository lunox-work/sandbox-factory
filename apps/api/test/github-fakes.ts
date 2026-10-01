/**
 * Doubles for the GitHub tests: in-memory stores that keep the owner
 * boundary the real ones keep, and GitHub itself faked at `fetch`.
 *
 * The stores behave rather than record, so a test can say "nothing was
 * written" by looking, and the SQL each one stands in for is tested in
 * `packages/db` on its own.
 */

import { generateKeyPairSync, type KeyObject } from "node:crypto";

import type {
  DueGithubRepo,
  GithubConnectionStore,
  GithubFlaggedConnection,
  GithubConnectionSummary,
  GithubGrantStore,
  GithubGrantSummary,
  GithubRepoStore,
  GithubRepoSummary,
} from "@sandbox-factory/db";
import { InstallationTokens } from "@sandbox-factory/github";

export const appKey: KeyObject = generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).privateKey;

export const NOW = Date.parse("2026-10-01T00:00:00.000Z");
export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);
export const SHA_C = "c".repeat(40);

export function installationTokens(
  fetch: typeof globalThis.fetch,
): InstallationTokens {
  return new InstallationTokens({
    appId: "123",
    privateKey: appKey,
    fetch,
    now: () => NOW,
  });
}

/* ---- stores --------------------------------------------------------------- */

type ConnectionRow = GithubConnectionSummary & { organizationId: string };
type RepoRow = GithubRepoSummary & {
  organizationId: string;
  headEtag: string | null;
};
interface GrantRow extends GithubGrantSummary {
  organizationId: string;
  userId: string;
  accessToken: string;
  refreshToken: string | null;
}

export interface MemoryGithub {
  connections: GithubConnectionStore & { rows: Map<string, ConnectionRow> };
  grants: GithubGrantStore & { rows: Map<string, GrantRow> };
  repos: GithubRepoStore & { rows: Map<string, RepoRow> };
}

export function memoryGithub(): MemoryGithub {
  const connectionRows = new Map<string, ConnectionRow>();
  const grantRows = new Map<string, GrantRow>();
  const repoRows = new Map<string, RepoRow>();
  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}_${++sequence}`;
  const stamp = () => new Date(NOW).toISOString();

  const strip = ({ organizationId: _o, ...summary }: ConnectionRow) =>
    summary as GithubConnectionSummary;
  const stripRepo = ({
    organizationId: _o,
    headEtag: _e,
    ...summary
  }: RepoRow) => summary as GithubRepoSummary;
  const ownedConnection = (organizationId: string, id: string) => {
    const row = connectionRows.get(id);
    return row?.organizationId === organizationId ? row : undefined;
  };
  const ownedRepo = (organizationId: string, id: string) => {
    const row = repoRows.get(id);
    return row?.organizationId === organizationId ? row : undefined;
  };

  const connections: MemoryGithub["connections"] = {
    rows: connectionRows,
    list: (organizationId) =>
      Promise.resolve(
        [...connectionRows.values()]
          .filter((row) => row.organizationId === organizationId)
          .map(strip),
      ),
    get: (organizationId, id) => {
      const row = ownedConnection(organizationId, id);
      return Promise.resolve(row === undefined ? null : strip(row));
    },
    link: (organizationId, input) => {
      const existing = [...connectionRows.values()].find(
        (row) => row.installationId === input.installationId,
      );
      if (
        existing !== undefined &&
        existing.organizationId !== organizationId
      ) {
        return Promise.resolve({ status: "claimed" as const });
      }
      const row: ConnectionRow = {
        id: existing?.id ?? nextId("ghc"),
        organizationId,
        installationId: input.installationId,
        accountLogin: input.accountLogin,
        accountType: input.accountType,
        repositorySelection: input.repositorySelection,
        permissions: { ...input.permissions },
        healthy: input.suspendedAt === null,
        suspendedAt: input.suspendedAt,
        uninstalledAt: null,
        createdAt: existing?.createdAt ?? stamp(),
      };
      connectionRows.set(row.id, row);
      return Promise.resolve({
        status: "linked" as const,
        connection: strip(row),
      });
    },
    ownerOf: (installationId) => {
      const row = [...connectionRows.values()].find(
        (candidate) => candidate.installationId === installationId,
      );
      return Promise.resolve(
        row === undefined
          ? null
          : { organizationId: row.organizationId, connectionId: row.id },
      );
    },
    owners: (installationIds) =>
      Promise.resolve(
        new Map(
          [...connectionRows.values()]
            .filter((row) => installationIds.includes(row.installationId))
            .map((row) => [row.installationId, row.organizationId]),
        ),
      ),
    flaggedForProbe: (limit) =>
      Promise.resolve(
        [...connectionRows.values()]
          .filter((row) => !row.healthy && row.uninstalledAt === null)
          .slice(0, limit)
          .map((row): GithubFlaggedConnection => ({
            organizationId: row.organizationId,
            connectionId: row.id,
            installationId: row.installationId,
          })),
      ),
    update: (organizationId, id, patch) => {
      const row = ownedConnection(organizationId, id);
      if (row === undefined) return Promise.resolve(false);
      connectionRows.set(id, {
        ...row,
        ...(patch.healthy === undefined ? {} : { healthy: patch.healthy }),
        ...(patch.suspendedAt === undefined
          ? {}
          : { suspendedAt: patch.suspendedAt }),
        ...(patch.uninstalledAt === undefined
          ? {}
          : { uninstalledAt: patch.uninstalledAt }),
        ...(patch.permissions === undefined
          ? {}
          : { permissions: { ...patch.permissions } }),
        ...(patch.repositorySelection === undefined
          ? {}
          : { repositorySelection: patch.repositorySelection }),
      });
      return Promise.resolve(true);
    },
    remove: (organizationId, id) => {
      if (ownedConnection(organizationId, id) === undefined) {
        return Promise.resolve(false);
      }
      connectionRows.delete(id);
      // The cascade.
      for (const [repoId, repo] of repoRows) {
        if (repo.connectionId === id) repoRows.delete(repoId);
      }
      return Promise.resolve(true);
    },
  };

  const grantKey = (organizationId: string, userId: string) =>
    `${organizationId}\n${userId}`;
  const grantSummary = ({
    organizationId: _o,
    userId: _u,
    accessToken: _a,
    refreshToken: _r,
    ...summary
  }: GrantRow) => summary as GithubGrantSummary;

  const grants: MemoryGithub["grants"] = {
    rows: grantRows,
    upsert: (organizationId, userId, input) => {
      const existing = grantRows.get(grantKey(organizationId, userId));
      const row: GrantRow = {
        id: existing?.id ?? nextId("ghg"),
        organizationId,
        userId,
        githubLogin: input.githubLogin,
        githubUserId: input.githubUserId,
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        expiresAt: input.expiresAt,
        healthy: true,
        credentialRevision: (existing?.credentialRevision ?? 0) + 1,
      };
      grantRows.set(grantKey(organizationId, userId), row);
      return Promise.resolve(grantSummary(row));
    },
    get: (organizationId, userId) => {
      const row = grantRows.get(grantKey(organizationId, userId));
      return Promise.resolve(row === undefined ? null : grantSummary(row));
    },
    tokens: (organizationId, userId) => {
      const row = grantRows.get(grantKey(organizationId, userId));
      return Promise.resolve(
        row === undefined
          ? null
          : {
              accessToken: row.accessToken,
              refreshToken: row.refreshToken,
              expiresAt: row.expiresAt,
              credentialRevision: row.credentialRevision,
            },
      );
    },
    saveTokens: (organizationId, userId, expectedRevision, tokens) => {
      const key = grantKey(organizationId, userId);
      const row = grantRows.get(key);
      if (row === undefined || row.credentialRevision !== expectedRevision) {
        return Promise.resolve(false);
      }
      grantRows.set(key, {
        ...row,
        ...tokens,
        healthy: true,
        credentialRevision: expectedRevision + 1,
      });
      return Promise.resolve(true);
    },
    markUnhealthy: (organizationId, userId, expectedRevision) => {
      const key = grantKey(organizationId, userId);
      const row = grantRows.get(key);
      if (row === undefined || row.credentialRevision !== expectedRevision) {
        return Promise.resolve(false);
      }
      grantRows.set(key, { ...row, healthy: false });
      return Promise.resolve(true);
    },
  };

  const setRepo = (row: RepoRow, patch: Partial<RepoRow>) => {
    const next = { ...row, ...patch };
    repoRows.set(row.id, next);
    return next;
  };

  const repos: MemoryGithub["repos"] = {
    rows: repoRows,
    list: (organizationId) =>
      Promise.resolve(
        [...repoRows.values()]
          .filter((row) => row.organizationId === organizationId)
          .sort((a, b) => a.fullName.localeCompare(b.fullName))
          .map(stripRepo),
      ),
    get: (organizationId, id) => {
      const row = ownedRepo(organizationId, id);
      return Promise.resolve(row === undefined ? null : stripRepo(row));
    },
    findByExternalId: (organizationId, connectionId, externalId) => {
      const row = [...repoRows.values()].find(
        (candidate) =>
          candidate.organizationId === organizationId &&
          candidate.connectionId === connectionId &&
          candidate.externalId === externalId,
      );
      return Promise.resolve(row === undefined ? null : stripRepo(row));
    },
    register: (organizationId, input) => {
      const existing = [...repoRows.values()].find(
        (row) =>
          row.connectionId === input.connectionId &&
          row.externalId === input.externalId,
      );
      const row: RepoRow = {
        id: existing?.id ?? nextId("ghr"),
        organizationId,
        connectionId: input.connectionId,
        role: input.role,
        externalId: input.externalId,
        fullName: input.fullName,
        defaultBranch: input.defaultBranch,
        isPrivate: input.isPrivate,
        sizeKb: input.sizeKb,
        headSha: existing?.headSha ?? null,
        headEtag: existing?.headEtag ?? null,
        pushedAt: input.pushedAt,
        lastSyncedAt: existing?.lastSyncedAt ?? null,
        syncStatus: "pending",
        syncError: null,
        createdAt: existing?.createdAt ?? stamp(),
      };
      repoRows.set(row.id, row);
      return Promise.resolve(stripRepo(row));
    },
    recordSync: (organizationId, id, metadata, head) => {
      const row = ownedRepo(organizationId, id);
      // The real store's `sync_status <> 'gone'`, as for the two below.
      if (row === undefined || row.syncStatus === "gone") {
        return Promise.resolve(null);
      }
      return Promise.resolve(
        stripRepo(
          setRepo(row, {
            ...metadata,
            ...(head === undefined
              ? {}
              : { headSha: head.sha, headEtag: head.etag }),
            syncStatus: "ok",
            syncError: null,
            lastSyncedAt: stamp(),
          }),
        ),
      );
    },
    setHead: (organizationId, id, head) => {
      const row = ownedRepo(organizationId, id);
      if (row === undefined || row.syncStatus === "gone") {
        return Promise.resolve(false);
      }
      // The monotonic guard the real store puts in its WHERE.
      if (
        head.pushedAt !== null &&
        row.pushedAt !== null &&
        Date.parse(row.pushedAt) > Date.parse(head.pushedAt)
      ) {
        return Promise.resolve(false);
      }
      setRepo(row, {
        headSha: head.headSha,
        headEtag: null,
        ...(head.pushedAt === null ? {} : { pushedAt: head.pushedAt }),
        syncStatus: "ok",
        syncError: null,
        lastSyncedAt: stamp(),
      });
      return Promise.resolve(true);
    },
    update: (organizationId, id, patch) => {
      const row = ownedRepo(organizationId, id);
      if (row === undefined) return Promise.resolve(false);
      setRepo(row, patch);
      return Promise.resolve(true);
    },
    markGone: (organizationId, ids) => {
      let count = 0;
      for (const id of ids) {
        const row = ownedRepo(organizationId, id);
        if (row !== undefined) {
          setRepo(row, { syncStatus: "gone" });
          count += 1;
        }
      }
      return Promise.resolve(count);
    },
    markGoneForConnection: (organizationId, connectionId) => {
      let count = 0;
      for (const row of repoRows.values()) {
        if (
          row.organizationId === organizationId &&
          row.connectionId === connectionId
        ) {
          setRepo(row, { syncStatus: "gone" });
          count += 1;
        }
      }
      return Promise.resolve(count);
    },
    revive: (organizationId, ids) => {
      let count = 0;
      for (const id of ids) {
        const row = ownedRepo(organizationId, id);
        if (row?.syncStatus === "gone") {
          setRepo(row, { syncStatus: "pending", syncError: null });
          count += 1;
        }
      }
      return Promise.resolve(count);
    },
    markSyncError: (organizationId, id, message) => {
      const row = ownedRepo(organizationId, id);
      if (row === undefined || row.syncStatus === "gone") {
        return Promise.resolve(false);
      }
      setRepo(row, {
        syncStatus: "error",
        syncError: message,
        lastSyncedAt: stamp(),
      });
      return Promise.resolve(true);
    },
    dueForSync: (staleBefore, limit) => {
      const due: DueGithubRepo[] = [...repoRows.values()]
        .filter((row) => {
          const connection = connectionRows.get(row.connectionId);
          return (
            connection?.healthy === true &&
            row.syncStatus !== "gone" &&
            (row.lastSyncedAt === null ||
              Date.parse(row.lastSyncedAt) < staleBefore.getTime())
          );
        })
        .slice(0, limit)
        .map((row) => ({
          organizationId: row.organizationId,
          id: row.id,
          connectionId: row.connectionId,
          installationId:
            connectionRows.get(row.connectionId)?.installationId ?? "",
          externalId: row.externalId,
          headEtag: row.headEtag,
        }));
      return Promise.resolve(due);
    },
    remove: (organizationId, id) => {
      if (ownedRepo(organizationId, id) === undefined) {
        return Promise.resolve(false);
      }
      repoRows.delete(id);
      return Promise.resolve(true);
    },
  };

  return { connections, grants, repos };
}

/** Puts a linked connection in place, as the callback would have. */
export async function seedConnection(
  stores: MemoryGithub,
  organizationId: string,
  installationId: string,
  accountLogin = "acme",
): Promise<string> {
  const result = await stores.connections.link(organizationId, {
    installationId,
    accountLogin,
    accountType: "Organization",
    repositorySelection: "selected",
    permissions: { contents: "read", metadata: "read" },
    suspendedAt: null,
  });
  if (result.status !== "linked") throw new Error("seed was claimed");
  return result.connection.id;
}

/** Puts a registered, synced repository in place. */
export async function seedRepo(
  stores: MemoryGithub,
  organizationId: string,
  connectionId: string,
  overrides: { externalId?: string; fullName?: string; pushedAt?: string } = {},
): Promise<string> {
  const repo = await stores.repos.register(organizationId, {
    connectionId,
    externalId: overrides.externalId ?? "1296269",
    role: "source",
    fullName: overrides.fullName ?? "acme/widgets",
    defaultBranch: "main",
    isPrivate: true,
    sizeKb: 120,
    pushedAt: overrides.pushedAt ?? "2026-09-30T00:00:00.000Z",
  });
  await stores.repos.recordSync(
    organizationId,
    repo.id,
    {
      fullName: repo.fullName,
      defaultBranch: "main",
      isPrivate: true,
      sizeKb: 120,
      pushedAt: overrides.pushedAt ?? "2026-09-30T00:00:00.000Z",
    },
    { sha: SHA_A, etag: 'W/"a"' },
  );
  return repo.id;
}

/* ---- GitHub, faked -------------------------------------------------------- */

export interface FakeInstallation {
  id: number;
  login: string;
  type?: string;
  selection?: string;
  suspended?: boolean;
  /** The account's numeric id. `/user` is 42, so 42 makes a `User` one theirs. */
  accountId?: number;
  /**
   * How many of the installation's repositories the person can reach.
   * Default: all of them, which is what an organization's owner sees.
   */
  reachable?: number;
}

export interface FakeRepository {
  id: number;
  full_name: string;
  default_branch?: string;
  private?: boolean;
  size?: number;
  pushed_at?: string;
}

export interface GithubWorld {
  /** Installations `GET /user/installations` lists. */
  installations: FakeInstallation[];
  /** Repositories `GET /installation/repositories` lists. */
  repositories: FakeRepository[];
  /** Branch heads by `owner/repo@branch`; absent is 404, `empty` is 409. */
  heads: Record<string, string | "empty">;
  /** Status for the code exchange, or an error code GitHub returns with 200. */
  exchangeError?: string;
  /** Status every REST call answers with instead, e.g. 429. */
  restStatus?: number;
  /** Installations whose own token is rate limited; GitHub's limit is per installation. */
  limitedInstallations?: number[];
  /** Installation ids whose token mint and probe answer 404. */
  uninstalled?: number[];
  /** Every App endpoint refuses the JWT with 401: a key deleted on GitHub. */
  appRefused?: boolean;
  /** Installation ids GitHub reports suspended to the probe, and mints 403. */
  suspendedIds?: number[];
  /** Status the probe (`GET /app/installations/:id`) answers with instead. */
  probeStatus?: number;
  /** Status the person's per-installation repository count answers with. */
  reachStatus?: number;
  /** Repository ids `GET /repositories/:id` answers 404 for. */
  deletedRepos?: number[];
  /** ETags that still match, so the ref read answers 304. */
  freshEtags?: string[];
}

export function world(overrides: Partial<GithubWorld> = {}): GithubWorld {
  return {
    installations: [{ id: 9, login: "acme" }],
    repositories: [
      {
        id: 1296269,
        full_name: "acme/widgets",
        default_branch: "main",
        private: true,
        size: 120,
        pushed_at: "2026-10-01T00:00:00Z",
      },
    ],
    heads: { "acme/widgets@main": SHA_B },
    ...overrides,
  };
}

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** GitHub at `fetch`, answering from a mutable world. Records every URL. */
export function fakeGithub(state: GithubWorld): typeof globalThis.fetch & {
  urls: string[];
} {
  const urls: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    urls.push(`${init?.method ?? "GET"} ${url.toString()}`);
    const path = url.pathname;

    if (url.host === "github.com" && path === "/login/oauth/access_token") {
      if (state.exchangeError !== undefined) {
        return json({ error: state.exchangeError });
      }
      return json({
        access_token: "ghu_user",
        expires_in: 28_800,
        refresh_token: "ghr_user",
        token_type: "bearer",
      });
    }
    if (url.host !== "api.github.com") {
      throw new Error(`unexpected request to ${url.toString()}`);
    }

    const app = /^\/app\/installations\/(\d+)(\/access_tokens)?$/.exec(path);
    if (app !== null && state.appRefused === true) {
      return json({ message: "A JSON web token could not be decoded" }, 401);
    }
    const id = Number(app?.[1]);
    const suspended =
      state.suspendedIds?.includes(id) === true ||
      state.installations.some(
        (candidate) => candidate.id === id && candidate.suspended === true,
      );
    if (app !== null && app[2] === undefined) {
      if (state.probeStatus !== undefined) {
        return json({ message: "nope" }, state.probeStatus, {
          "retry-after": "30",
        });
      }
      if (state.uninstalled?.includes(id)) {
        return json({ message: "Not Found" }, 404);
      }
      return json({
        id,
        suspended_at: suspended ? "2026-09-30T00:00:00Z" : null,
      });
    }
    const mint = app;
    if (mint !== null) {
      if (state.uninstalled?.includes(Number(mint[1]))) {
        return json({ message: "Not Found" }, 404);
      }
      if (suspended) {
        return json({ message: "This installation has been suspended" }, 403);
      }
      return json(
        {
          token: `ghs_${mint[1]}`,
          expires_at: new Date(NOW + 60 * 60_000).toISOString(),
        },
        201,
      );
    }
    if (state.restStatus !== undefined) {
      return json({ message: "nope" }, state.restStatus, {
        "retry-after": "30",
      });
    }
    const bearer = new Headers(init?.headers).get("authorization") ?? "";
    const tokenOf = /^Bearer ghs_(\d+)$/.exec(bearer);
    if (
      tokenOf !== null &&
      state.limitedInstallations?.includes(Number(tokenOf[1]))
    ) {
      return json({ message: "API rate limit exceeded" }, 403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(NOW / 1000) + 600),
      });
    }
    if (path === "/user") return json({ login: "dana", id: 42 });
    if (path === "/user/installations") {
      return json({
        total_count: state.installations.length,
        installations: state.installations.map((installation) => ({
          id: installation.id,
          account: {
            login: installation.login,
            id: installation.accountId ?? 1000 + installation.id,
            type: installation.type ?? "Organization",
          },
          repository_selection: installation.selection ?? "selected",
          permissions: { contents: "read", metadata: "read" },
          suspended_at:
            installation.suspended === true ? "2026-09-30T00:00:00Z" : null,
        })),
      });
    }
    const reach = /^\/user\/installations\/(\d+)\/repositories$/.exec(path);
    if (reach !== null) {
      const installation = state.installations.find(
        (candidate) => candidate.id === Number(reach[1]),
      );
      if (installation === undefined)
        return json({ message: "Not Found" }, 404);
      if (state.reachStatus !== undefined) {
        return json({ message: "nope" }, state.reachStatus);
      }
      return json({
        total_count: installation.reachable ?? state.repositories.length,
        repositories: [],
      });
    }
    if (path === "/installation/repositories") {
      return json({
        total_count: state.repositories.length,
        repository_selection: "selected",
        repositories: state.repositories,
      });
    }
    const byId = /^\/repositories\/(\d+)$/.exec(path);
    if (byId !== null) {
      const repo = state.repositories.find(
        (candidate) => candidate.id === Number(byId[1]),
      );
      if (repo === undefined || state.deletedRepos?.includes(repo.id)) {
        return json({ message: "Not Found" }, 404);
      }
      return json(repo);
    }
    const ref = /^\/repos\/([^/]+\/[^/]+)\/git\/ref\/heads\/(.+)$/.exec(path);
    if (ref !== null) {
      const etag = new Headers(init?.headers).get("if-none-match");
      if (etag !== null && state.freshEtags?.includes(etag)) {
        return new Response(null, { status: 304 });
      }
      const head = state.heads[`${ref[1]}@${decodeURIComponent(ref[2] ?? "")}`];
      if (head === undefined) return json({ message: "Not Found" }, 404);
      if (head === "empty") {
        return json({ message: "Git Repository is empty." }, 409);
      }
      return json(
        { ref: `refs/heads/${ref[2]}`, object: { sha: head, type: "commit" } },
        200,
        { etag: `W/"${head.slice(0, 1)}"` },
      );
    }
    throw new Error(`unexpected request to ${url.toString()}`);
  }) as typeof globalThis.fetch & { urls: string[] };
  impl.urls = urls;
  return impl;
}
