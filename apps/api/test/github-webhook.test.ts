import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import type { Auth } from "../src/auth.js";
import {
  handleGithubEvent,
  type GithubWebhookOptions,
} from "../src/github/webhook.js";
import { createApp } from "../src/routes.js";
import {
  fakeGithub,
  installationTokens,
  memoryGithub,
  SHA_A,
  SHA_B,
  SHA_C,
  seedConnection,
  seedRepo,
  world,
  type MemoryGithub,
} from "./github-fakes.js";

/**
 * Webhook deliveries, against payloads shaped as GitHub sends them (trimmed
 * to the fields a handler reads, with placeholder accounts). The route is
 * tested for its signature check and for applying a delivery before it is
 * answered; each handler is tested directly.
 */

const WEBHOOK_SECRET = "webhook-secret";
const ZEROS = "0".repeat(40);

async function setup() {
  const stores = memoryGithub();
  const connectionId = await seedConnection(stores, "org_1", "9");
  const repoId = await seedRepo(stores, "org_1", connectionId, {
    pushedAt: "2026-09-30T00:00:00.000Z",
  });
  const fetch = fakeGithub(
    world({
      heads: { "acme/widgets@trunk": SHA_C, "acme/widgets@main": SHA_B },
    }),
  );
  const logged: string[] = [];
  const options: GithubWebhookOptions = {
    ...stores,
    installations: installationTokens(fetch),
    webhookSecret: WEBHOOK_SECRET,
    fetch,
    now: () => Date.parse("2026-10-01T00:00:00.000Z"),
    log: (line) => logged.push(line),
  };
  return { stores, connectionId, repoId, options, logged, fetch };
}

/** A push as GitHub sends it: `pushed_at` in Unix seconds. */
function push(overrides: Record<string, unknown> = {}) {
  return {
    ref: "refs/heads/main",
    before: SHA_A,
    after: SHA_B,
    created: false,
    deleted: false,
    forced: false,
    repository: {
      id: 1296269,
      full_name: "acme/widgets",
      private: true,
      default_branch: "main",
      pushed_at: 1_790_812_860, // 2026-10-01T00:01:00Z
    },
    pusher: { name: "dana" },
    sender: { login: "dana" },
    installation: { id: 9, node_id: "MDIz" },
    ...overrides,
  };
}

function repositoryEvent(
  action: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    action,
    repository: {
      id: 1296269,
      full_name: "acme/widgets",
      private: true,
      default_branch: "main",
      pushed_at: "2026-10-01T00:00:00Z",
    },
    sender: { login: "dana" },
    installation: { id: 9 },
    ...overrides,
  };
}

function installationEvent(
  action: string,
  installation: Record<string, unknown> = {},
) {
  return {
    action,
    installation: {
      id: 9,
      account: { login: "acme", type: "Organization" },
      repository_selection: "selected",
      permissions: { contents: "read", metadata: "read" },
      suspended_at: null,
      ...installation,
    },
    sender: { login: "dana" },
  };
}

async function repo(stores: MemoryGithub, repoId: string) {
  return stores.repos.get("org_1", repoId);
}

/* ---- the route ----------------------------------------------------------- */

function appWith(options: GithubWebhookOptions, work: Promise<unknown>[]) {
  return createApp({
    corsOrigins: ["https://app.test"],
    auth: {
      api: { getSession: () => Promise.resolve(null) },
      handler: () => Promise.resolve(new Response(null, { status: 404 })),
    } as unknown as Auth,
    github: {
      ...options,
      grants: memoryGithub().grants,
      appSlug: "sandbox-factory",
      clientId: "Iv1.app",
      clientSecret: "app-secret",
      secret: "0123456789abcdef0123456789abcdef",
      apiUrl: "https://platform.test",
      appUrl: "https://platform.test",
      background: (promise) => work.push(promise),
    },
  });
}

function sign(body: string, secret = WEBHOOK_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

test("a signed delivery is applied before it is answered 202, with no session", async () => {
  const { stores, repoId, options } = await setup();
  const work: Promise<unknown>[] = [];
  const app = appWith(options, work);
  const body = JSON.stringify(push());

  const response = await app.request("/api/github/webhook", {
    method: "POST",
    headers: {
      "x-github-event": "push",
      "x-github-delivery": "d-1",
      "x-hub-signature-256": sign(body),
      "content-type": "application/json",
    },
    body,
  });

  assert.equal(response.status, 202);
  // Already written when GitHub hears back: nothing was left for after.
  assert.equal((await repo(stores, repoId))?.headSha, SHA_B);
  assert.equal(work.length, 0);
});

test("a delivery larger than GitHub ever sends is refused unread", async () => {
  const { options } = await setup();
  const work: Promise<unknown>[] = [];
  const app = appWith(options, work);

  const response = await app.request("/api/github/webhook", {
    method: "POST",
    headers: { "x-github-event": "push", "x-hub-signature-256": "sha256=0" },
    body: "x".repeat(25 * 1024 * 1024 + 1),
  });

  assert.equal(response.status, 413);
});

test("a bad or missing signature is 401 and touches nothing", async () => {
  const { stores, repoId, options } = await setup();
  const work: Promise<unknown>[] = [];
  const app = appWith(options, work);
  const body = JSON.stringify(push());

  for (const signature of [
    sign(body, "wrong-secret"),
    sign(`${body} `),
    undefined,
  ]) {
    const response = await app.request("/api/github/webhook", {
      method: "POST",
      headers: {
        "x-github-event": "push",
        ...(signature === undefined
          ? {}
          : { "x-hub-signature-256": signature }),
      },
      body,
    });
    assert.equal(response.status, 401);
  }

  assert.equal(work.length, 0);
  assert.equal((await repo(stores, repoId))?.headSha, SHA_A);
});

test("a signed body that is not JSON is 400", async () => {
  const { options } = await setup();
  const work: Promise<unknown>[] = [];
  const app = appWith(options, work);

  const response = await app.request("/api/github/webhook", {
    method: "POST",
    headers: { "x-github-event": "push", "x-hub-signature-256": sign("{nope") },
    body: "{nope",
  });

  assert.equal(response.status, 400);
  assert.equal(work.length, 0);
});

test("a delivery that cannot be applied answers 500, so GitHub shows it failed", async () => {
  // GitHub records any 2xx as delivered and does not retry on its own; a
  // 5xx is what lets someone redeliver it.
  const { options } = await setup();
  const errors: string[] = [];
  const app = createApp({
    corsOrigins: [],
    auth: {
      api: { getSession: () => Promise.resolve(null) },
      handler: () => Promise.resolve(new Response(null, { status: 404 })),
    } as unknown as Auth,
    github: {
      ...options,
      connections: {
        ...options.connections,
        ownerOf: () => Promise.reject(new Error("database down")),
      },
      grants: memoryGithub().grants,
      appSlug: "sandbox-factory",
      clientId: "Iv1.app",
      clientSecret: "app-secret",
      secret: "0123456789abcdef0123456789abcdef",
      apiUrl: "https://platform.test",
      appUrl: "https://platform.test",
      onBackgroundError: (code) => errors.push(code),
    },
  });
  const body = JSON.stringify(push());

  const response = await app.request("/api/github/webhook", {
    method: "POST",
    headers: { "x-github-event": "push", "x-hub-signature-256": sign(body) },
    body,
  });

  assert.equal(response.status, 500);
  assert.deepEqual(errors, ["github_webhook_failed"]);
});

/* ---- push ---------------------------------------------------------------- */

test("a push to the default branch moves the head", async () => {
  const { stores, repoId, options } = await setup();

  assert.equal(await handleGithubEvent(options, "push", push()), "applied");

  const moved = await repo(stores, repoId);
  assert.equal(moved?.headSha, SHA_B);
  assert.equal(moved?.pushedAt, "2026-10-01T00:01:00.000Z");
});

test("a push to another branch, or a tag, changes nothing", async () => {
  const { stores, repoId, options } = await setup();

  assert.equal(
    await handleGithubEvent(
      options,
      "push",
      push({ ref: "refs/heads/feature" }),
    ),
    "ignored",
  );
  assert.equal(
    await handleGithubEvent(options, "push", push({ ref: "refs/tags/v1" })),
    "ignored",
  );
  assert.equal((await repo(stores, repoId))?.headSha, SHA_A);
});

test("a push that deleted the default branch leaves the head alone", async () => {
  // Its `after` is all zeros, which is not a commit.
  const { stores, repoId, options } = await setup();

  assert.equal(
    await handleGithubEvent(
      options,
      "push",
      push({ deleted: true, after: ZEROS }),
    ),
    "ignored",
  );
  assert.equal(
    await handleGithubEvent(options, "push", push({ after: ZEROS })),
    "ignored",
  );
  assert.equal((await repo(stores, repoId))?.headSha, SHA_A);
});

test("a push for a repository nobody registered is ignored", async () => {
  const { options } = await setup();

  assert.equal(
    await handleGithubEvent(
      options,
      "push",
      push({
        repository: { id: 5, full_name: "acme/other", default_branch: "main" },
      }),
    ),
    "ignored",
  );
});

test("a push on a new default branch also records the branch", async () => {
  // The `repository.edited` delivery that said so went missing.
  const { stores, repoId, options } = await setup();

  await handleGithubEvent(
    options,
    "push",
    push({
      ref: "refs/heads/trunk",
      after: SHA_C,
      repository: {
        id: 1296269,
        full_name: "acme/widgets",
        default_branch: "trunk",
        pushed_at: 1_790_834_400,
      },
    }),
  );

  const moved = await repo(stores, repoId);
  assert.equal(moved?.defaultBranch, "trunk");
  assert.equal(moved?.headSha, SHA_C);
});

test("a delivery for an installation nobody linked is logged and dropped", async () => {
  const { options, logged } = await setup();

  assert.equal(
    await handleGithubEvent(
      options,
      "push",
      push({ installation: { id: 404 } }),
    ),
    "unknown-installation",
  );
  assert.match(logged[0] ?? "", /installation=404/);
});

test("a ping, or a payload with no installation, is nothing to act on", async () => {
  const { options } = await setup();

  assert.equal(
    await handleGithubEvent(options, "ping", {
      zen: "Keep it logically awesome.",
    }),
    "ignored",
  );
  assert.equal(
    await handleGithubEvent(options, "push", "not an object"),
    "ignored",
  );
  assert.equal(
    await handleGithubEvent(options, "star", {
      action: "created",
      installation: { id: 9 },
    }),
    "ignored",
  );
});

test("a malformed event of a known kind is ignored rather than thrown", async () => {
  const { options } = await setup();

  for (const event of [
    "installation",
    "installation_repositories",
    "push",
    "repository",
  ]) {
    assert.equal(
      await handleGithubEvent(options, event, { installation: { id: 9 } }),
      "ignored",
      event,
    );
  }
});

/* ---- installation -------------------------------------------------------- */

test("uninstalling turns the connection unhealthy and its repositories gone, rows intact", async () => {
  const { stores, connectionId, repoId, options } = await setup();

  assert.equal(
    await handleGithubEvent(
      options,
      "installation",
      installationEvent("deleted"),
    ),
    "applied",
  );

  const connection = await stores.connections.get("org_1", connectionId);
  assert.equal(connection?.healthy, false);
  // Final, so the sweep's probe leaves it alone from now on.
  assert.equal(connection?.uninstalledAt, "2026-10-01T00:00:00.000Z");
  assert.equal((await repo(stores, repoId))?.syncStatus, "gone");
  assert.equal(stores.repos.rows.size, 1);
});

test("suspend and unsuspend flip health and record when", async () => {
  const { stores, connectionId, options } = await setup();

  await handleGithubEvent(
    options,
    "installation",
    installationEvent("suspend", { suspended_at: "2026-10-01T02:00:00Z" }),
  );
  const suspended = await stores.connections.get("org_1", connectionId);
  await handleGithubEvent(
    options,
    "installation",
    installationEvent("suspend"),
  );
  const suspendedNow = await stores.connections.get("org_1", connectionId);
  await handleGithubEvent(
    options,
    "installation",
    installationEvent("unsuspend"),
  );
  const back = await stores.connections.get("org_1", connectionId);

  assert.equal(suspended?.healthy, false);
  assert.equal(suspended?.suspendedAt, "2026-10-01T02:00:00Z");
  assert.equal(suspendedNow?.suspendedAt, "2026-10-01T00:00:00.000Z");
  assert.equal(back?.healthy, true);
  assert.equal(back?.suspendedAt, null);
});

test("newly accepted permissions are stored", async () => {
  const { stores, connectionId, options } = await setup();

  await handleGithubEvent(
    options,
    "installation",
    installationEvent("new_permissions_accepted", {
      permissions: { contents: "read", metadata: "read", issues: "read" },
    }),
  );
  await handleGithubEvent(
    options,
    "installation",
    installationEvent("created"),
  );

  assert.deepEqual(
    (await stores.connections.get("org_1", connectionId))?.permissions,
    {
      contents: "read",
      metadata: "read",
      issues: "read",
    },
  );
});

test("repositories removed go gone, re-added come back pending, and the selection is kept", async () => {
  const { stores, connectionId, repoId, options } = await setup();
  const event = (action: string, side: string) => ({
    action,
    installation: { id: 9 },
    repository_selection: action === "removed" ? "selected" : "all",
    [side]: [
      { id: 1296269, full_name: "acme/widgets" },
      { id: 5, full_name: "acme/unregistered" },
    ],
  });

  await handleGithubEvent(
    options,
    "installation_repositories",
    event("removed", "repositories_removed"),
  );
  const removed = await repo(stores, repoId);
  await handleGithubEvent(
    options,
    "installation_repositories",
    event("added", "repositories_added"),
  );
  const added = await repo(stores, repoId);

  assert.equal(removed?.syncStatus, "gone");
  assert.equal(added?.syncStatus, "pending");
  assert.equal(
    (await stores.connections.get("org_1", connectionId))?.repositorySelection,
    "all",
  );
});

/* ---- repository ---------------------------------------------------------- */

test("a rename or a transfer updates the name; the numeric id is what matched", async () => {
  const { stores, repoId, options } = await setup();

  await handleGithubEvent(
    options,
    "repository",
    repositoryEvent("renamed", {
      repository: {
        id: 1296269,
        full_name: "acme/gadgets",
        default_branch: "main",
      },
    }),
  );
  const renamed = await repo(stores, repoId);
  await handleGithubEvent(
    options,
    "repository",
    repositoryEvent("transferred", {
      repository: {
        id: 1296269,
        full_name: "beta/gadgets",
        default_branch: "main",
      },
    }),
  );

  assert.equal(renamed?.fullName, "acme/gadgets");
  assert.equal((await repo(stores, repoId))?.fullName, "beta/gadgets");
});

test("a new default branch is recorded at once, and its head read after the answer", async () => {
  const { stores, repoId, options, fetch } = await setup();
  const work: Promise<unknown>[] = [];

  const outcome = await handleGithubEvent(
    { ...options, background: (promise) => work.push(promise) },
    "repository",
    repositoryEvent("edited", {
      repository: {
        id: 1296269,
        full_name: "acme/widgets",
        default_branch: "trunk",
        pushed_at: "2026-10-01T00:00:00Z",
      },
      changes: { default_branch: { from: "main" } },
    }),
  );

  assert.equal(outcome, "applied");
  assert.equal((await repo(stores, repoId))?.defaultBranch, "trunk");
  // The round trip to GitHub is the part left until after the 202.
  assert.equal(work.length, 1);
  await Promise.all(work);
  const moved = await repo(stores, repoId);
  assert.equal(moved?.headSha, SHA_C);
  assert.ok(fetch.urls.some((url) => url.endsWith("/git/ref/heads/trunk")));
});

test("an edit that is not to the default branch is ignored", async () => {
  const { options } = await setup();

  assert.equal(
    await handleGithubEvent(
      options,
      "repository",
      repositoryEvent("edited", { changes: { description: { from: "old" } } }),
    ),
    "ignored",
  );
});

test("deletion goes gone, and visibility changes are recorded", async () => {
  const { stores, repoId, options } = await setup();

  await handleGithubEvent(options, "repository", repositoryEvent("publicized"));
  const publicized = await repo(stores, repoId);
  await handleGithubEvent(options, "repository", repositoryEvent("privatized"));
  const privatized = await repo(stores, repoId);
  await handleGithubEvent(options, "repository", repositoryEvent("archived"));
  await handleGithubEvent(options, "repository", repositoryEvent("deleted"));

  assert.equal(publicized?.isPrivate, false);
  assert.equal(privatized?.isPrivate, true);
  assert.equal((await repo(stores, repoId))?.syncStatus, "gone");
});

test("a repository event for an unregistered repository is ignored", async () => {
  const { options } = await setup();

  assert.equal(
    await handleGithubEvent(
      options,
      "repository",
      repositoryEvent("deleted", {
        repository: { id: 5, full_name: "acme/other" },
      }),
    ),
    "ignored",
  );
});

test("a late push cannot move the head backwards", async () => {
  // Deliveries are not ordered. The one pushed earlier, arriving later, is
  // refused by the pushed_at guard.
  const { stores, repoId, options } = await setup();
  await handleGithubEvent(
    options,
    "push",
    push({
      after: SHA_C,
      repository: { ...push().repository, pushed_at: 1_790_834_400 },
    }),
  );

  await handleGithubEvent(options, "push", push({ after: SHA_B }));

  assert.equal((await repo(stores, repoId))?.headSha, SHA_C);
});

test("a head re-read that fails after the answer is reported, not thrown", async () => {
  const { options } = await setup();
  const errors: string[] = [];
  const failing = fakeGithub(world({ restStatus: 500 }));

  await handleGithubEvent(
    {
      ...options,
      fetch: failing,
      installations: installationTokens(failing),
      onBackgroundError: (code) => errors.push(code),
    },
    "repository",
    repositoryEvent("edited", {
      repository: {
        id: 1296269,
        full_name: "acme/widgets",
        default_branch: "trunk",
      },
      changes: { default_branch: { from: "main" } },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(errors, ["github_webhook_failed"]);
});
