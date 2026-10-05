import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GITHUB_WEBHOOK_HEADERS,
  githubConnectionDtoSchema,
  githubInstallationEventSchema,
  githubInstallationPageResponseSchema,
  githubInstallationRepositoriesEventSchema,
  githubInstallationSettingsUrl,
  githubOAuthTokenResponseSchema,
  githubPushEventSchema,
  githubRepoDtoSchema,
  githubRepositoryEventSchema,
  githubRepositoryResponseSchema,
  githubTimestamp,
  githubWebhookEnvelopeSchema,
  githubLanguagesResponseSchema,
  githubTreeResponseSchema,
  linkInstallationRequestSchema,
  registerRepoRequestSchema,
  repoSnapshotDetailDtoSchema,
  repoTreeQuerySchema,
  storedTreeSchema,
  TREE_PAGE_MAX,
  treeFactsDtoSchema,
} from "../src/index.js";
import { treeFacts } from "sandbox-factory";

/*
 * As with Jira, the response schemas are worth testing for what they let
 * through: each case is a payload GitHub really sends, and a strict schema
 * would turn it into a dropped delivery.
 */

test("an installation stub parses with nothing but its id", () => {
  // Every webhook other than `installation` carries only this much.
  const parsed = githubWebhookEnvelopeSchema.parse({
    action: "created",
    installation: { id: 42, node_id: "MDIz" },
    sender: { login: "someone" },
  });

  assert.equal(parsed.installation?.id, 42);
});

test("an installation page keeps fields GitHub adds later", () => {
  const parsed = githubInstallationPageResponseSchema.parse({
    total_count: 1,
    installations: [
      {
        id: 7,
        account: { login: "acme", id: 1, type: "Organization" },
        repository_selection: "selected",
        permissions: { contents: "read", metadata: "read" },
        suspended_at: null,
        app_slug: "sandbox-factory",
      },
    ],
  });

  assert.equal(parsed.installations[0]?.account?.login, "acme");
  assert.equal(
    (parsed.installations[0] as Record<string, unknown>)["app_slug"],
    "sandbox-factory",
  );
});

test("a repository needs only its id and full name", () => {
  const parsed = githubRepositoryResponseSchema.parse({
    id: 1296269,
    full_name: "acme/widgets",
  });

  assert.equal(parsed.default_branch, undefined);
});

test("push events carry pushed_at as Unix seconds, and both spellings read alike", () => {
  // The one place GitHub changes a field's type between payloads.
  const push = githubPushEventSchema.parse({
    ref: "refs/heads/main",
    after: "a".repeat(40),
    deleted: false,
    repository: {
      id: 1,
      full_name: "acme/widgets",
      default_branch: "main",
      pushed_at: 1_727_740_800,
    },
    installation: { id: 9 },
  });

  assert.equal(
    githubTimestamp(push.repository.pushed_at),
    "2024-10-01T00:00:00.000Z",
  );
  assert.equal(
    githubTimestamp("2024-10-01T00:00:00Z"),
    "2024-10-01T00:00:00.000Z",
  );
});

test("an absent or unreadable timestamp is null rather than an Invalid Date", () => {
  assert.equal(githubTimestamp(null), null);
  assert.equal(githubTimestamp(undefined), null);
  assert.equal(githubTimestamp("not a date"), null);
});

test("an installation event carries the full installation", () => {
  const parsed = githubInstallationEventSchema.parse({
    action: "new_permissions_accepted",
    installation: {
      id: 9,
      account: { login: "acme", type: "Organization" },
      permissions: { contents: "read", metadata: "read", issues: "write" },
    },
  });

  assert.equal(parsed.installation.permissions?.["issues"], "write");
});

test("an installation_repositories event lists both sides, either possibly absent", () => {
  const parsed = githubInstallationRepositoriesEventSchema.parse({
    action: "removed",
    installation: { id: 9 },
    repository_selection: "selected",
    repositories_removed: [{ id: 1, full_name: "acme/widgets" }],
  });

  assert.equal(parsed.repositories_added, undefined);
  assert.equal(parsed.repositories_removed?.[0]?.id, 1);
});

test("a repository event names the old default branch under changes", () => {
  const parsed = githubRepositoryEventSchema.parse({
    action: "edited",
    repository: { id: 1, full_name: "acme/widgets", default_branch: "trunk" },
    changes: { default_branch: { from: "main" } },
  });

  assert.equal(parsed.changes?.default_branch?.from, "main");
});

test("a refused code exchange parses, so the caller can read the error", () => {
  // GitHub answers it with 200, so the status says nothing.
  const parsed = githubOAuthTokenResponseSchema.parse({
    error: "bad_verification_code",
    error_description: "The code passed is incorrect or expired.",
  });

  assert.equal(parsed.access_token, undefined);
  assert.equal(parsed.error, "bad_verification_code");
});

test("the DTOs are strict, so no stray field reaches the browser", () => {
  const connection = {
    id: "ghc_1",
    installationId: "9",
    accountLogin: "acme",
    accountType: "Organization",
    repositorySelection: "all",
    healthy: true,
    suspendedAt: null,
    uninstalledAt: null,
    settingsUrl:
      "https://github.com/organizations/acme/settings/installations/9",
    createdAt: "2026-10-01T00:00:00.000Z",
  };
  assert.equal(githubConnectionDtoSchema.safeParse(connection).success, true);
  assert.equal(
    githubConnectionDtoSchema.safeParse({ ...connection, accessToken: "x" })
      .success,
    false,
  );

  const repo = {
    id: "ghr_1",
    connectionId: "ghc_1",
    role: "source",
    externalId: "1",
    fullName: "acme/widgets",
    defaultBranch: "main",
    isPrivate: true,
    sizeKb: 120,
    headSha: null,
    pushedAt: null,
    lastSyncedAt: null,
    syncStatus: "pending",
    syncError: null,
    stack: null,
    createdAt: "2026-10-01T00:00:00.000Z",
  };
  assert.equal(githubRepoDtoSchema.safeParse(repo).success, true);
  // Null until the head has been read; then the names detected, maybe none.
  for (const stack of [[], ["TypeScript", "PostgreSQL"]])
    assert.equal(
      githubRepoDtoSchema.safeParse({ ...repo, stack }).success,
      true,
    );
  assert.equal(
    githubRepoDtoSchema.safeParse({ ...repo, syncStatus: "stale" }).success,
    false,
  );
});

test("only source repositories can be registered in this phase", () => {
  assert.equal(
    registerRepoRequestSchema.safeParse({ externalId: "1", role: "source" })
      .success,
    true,
  );
  assert.equal(
    registerRepoRequestSchema.safeParse({ externalId: "1", role: "sandbox" })
      .success,
    false,
  );
});

test("ids from GitHub must be numeric, which keeps them out of URL tricks", () => {
  for (const installationId of ["", "0", "12a", "../1", "-1", "1".repeat(20)]) {
    assert.equal(
      linkInstallationRequestSchema.safeParse({ installationId }).success,
      false,
      installationId,
    );
  }
  assert.equal(
    linkInstallationRequestSchema.safeParse({ installationId: "4242" }).success,
    true,
  );
});

test("an installation's settings page differs for users and organizations", () => {
  assert.equal(
    githubInstallationSettingsUrl("Organization", "acme", "9"),
    "https://github.com/organizations/acme/settings/installations/9",
  );
  assert.equal(
    githubInstallationSettingsUrl("User", "dana", "9"),
    "https://github.com/settings/installations/9",
  );
});

test("the signature header is the SHA-256 one", () => {
  // `x-hub-signature` is SHA-1 and GitHub keeps sending it for compatibility.
  assert.equal(GITHUB_WEBHOOK_HEADERS.signature, "x-hub-signature-256");
});

test("a recursive tree parses with directories, submodules and extra fields", () => {
  const parsed = githubTreeResponseSchema.parse({
    sha: "tree1",
    url: "https://api.github.com/...",
    truncated: false,
    tree: [
      { path: "src", mode: "040000", type: "tree", sha: "t2" },
      {
        path: "src/a.ts",
        mode: "100644",
        type: "blob",
        sha: "b1",
        size: 12,
        url: "https://api.github.com/...",
      },
      { path: "vendor/lib", mode: "160000", type: "commit", sha: "c1" },
    ],
  });
  assert.equal(parsed.tree.length, 3);
  assert.equal(parsed.tree[1]?.size, 12);
  // `truncated` is optional: an older answer without it still parses.
  assert.equal(
    githubTreeResponseSchema.safeParse({ sha: "t", tree: [] }).success,
    true,
  );
});

test("languages are bytes per name", () => {
  assert.deepEqual(
    githubLanguagesResponseSchema.parse({ TypeScript: 1200, CSS: 40 }),
    { TypeScript: 1200, CSS: 40 },
  );
  assert.equal(
    githubLanguagesResponseSchema.safeParse({ TypeScript: "many" }).success,
    false,
  );
});

test("a stored tree is strict and carries blobs and submodules only", () => {
  const tree = {
    version: 1,
    commitSha: "c",
    treeSha: "t",
    truncated: false,
    entries: [
      { path: "a.ts", type: "blob", mode: "100644", sha: "b", size: 3 },
    ],
  };
  assert.equal(storedTreeSchema.safeParse(tree).success, true);
  assert.equal(
    storedTreeSchema.safeParse({
      ...tree,
      entries: [
        { path: "src", type: "tree", mode: "040000", sha: "t", size: 0 },
      ],
    }).success,
    false,
  );
});

test("the facts DTO accepts exactly what core computes", () => {
  const facts = treeFacts([
    { path: "packages/db/src/a.ts", size: 10 },
    { path: "package-lock.json", size: 5 },
  ]);
  assert.deepEqual(treeFactsDtoSchema.parse(facts), facts);
  assert.equal(
    repoSnapshotDetailDtoSchema.safeParse({
      id: "rsn_1",
      repoId: "ghr_1",
      commitSha: "c",
      ref: "refs/heads/main",
      treeSha: "t",
      treeTruncated: false,
      fileCount: 2,
      totalBytes: 15,
      languages: { TypeScript: 10 },
      createdAt: "2026-10-02T00:00:00.000Z",
      repoFullName: "acme/app",
      facts,
    }).success,
    true,
  );
});

test("a tree page query defaults its limit and refuses one past the cap", () => {
  assert.equal(repoTreeQuerySchema.parse({}).limit, 500);
  assert.equal(repoTreeQuerySchema.parse({ limit: "20" }).limit, 20);
  assert.equal(
    repoTreeQuerySchema.safeParse({ limit: String(TREE_PAGE_MAX + 1) }).success,
    false,
  );
});
