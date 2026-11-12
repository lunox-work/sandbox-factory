/**
 * The hosted end of `carveout handoff --platform` and `patch --from`: an
 * uploaded hand-off folder made a version, and a passing submission's
 * changed files given back, never a hidden test.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Hono } from "hono";
import type { StoredVersionSource } from "@sandbox-factory/db";
import { UPLOAD_LIMITS } from "@sandbox-factory/shared";
import { submittedFilesText, uploadObjectKey } from "sandbox-factory";
import { admit } from "../src/credentials.js";
import type { AuthVariables } from "../src/routes.js";
import {
  mountSandboxRoutes,
  type SandboxRouteOptions,
} from "../src/sandbox/routes.js";
import { changedSubmissionFiles, checkUpload } from "../src/sandbox/uploads.js";

const stamp = "2026-11-12T00:00:00.000Z";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const record = (overrides: object = {}) =>
  `${JSON.stringify({ schemaVersion: 1, carveoutVersion: "0.4.0", publicScrubbed: true, lockfile: true, request: { public: true }, ...overrides }, null, 2)}\n`;
const ACCEPT = {
  path: "src/price.accept.test.ts",
  text: 'import { test } from "node:test";\ntest("a tenth off", () => {});\n',
  expectedBaseline: "fail" as const,
};
function uploadBody(
  overrides: {
    files?: { path: string; text: string }[];
    extra?: { path: string; text: string }[];
    record?: string;
    acceptanceTests?: unknown[];
    recordSha256?: string;
  } = {},
) {
  const recordText = overrides.record ?? record();
  const files = overrides.files ?? [
    { path: "carveout.json", text: recordText },
    { path: "package.json", text: '{ "name": "folder" }\n' },
    { path: "package-lock.json", text: '{ "lockfileVersion": 3 }\n' },
    { path: ".npmrc", text: "engine-strict=true\nignore-scripts=true\n" },
    {
      path: "src/price.ts",
      text: "export const discounted = (c: number) => c;\n",
    },
    ...(overrides.extra ?? []),
  ];
  return {
    bountyId: "bty_1",
    carveout: {
      version: "0.4.0",
      recordSha256: overrides.recordSha256 ?? sha(recordText),
    },
    files,
    acceptanceTests: overrides.acceptanceTests ?? [ACCEPT],
  };
}

const quotaRefusal = {
  ok: false,
  reason: "quota_exceeded",
  used: 10_000_000,
  limit: 10_000_000,
  resetsAt: new Date("2099-12-01T00:00:00.000Z"),
};

const draft = {
  feature: "Thing",
  background: [],
  scenarios: [
    {
      id: "s1",
      kind: "happy",
      title: "works",
      steps: [{ keyword: "Given", text: "x" }],
      origin: "draft",
    },
  ],
  openQuestions: [],
  assumptions: [],
};

const importRun = {
  id: "arn_import",
  snapshotId: null,
  repoId: null,
  tool: "sandbox_import",
  toolVersion: "sandbox_import@1",
  status: "queued",
  attempt: 0,
  maxAttempts: 2,
  errorCode: null,
  errorDetail: null,
  progress: null,
  previewFiles: null,
  startedAt: null,
  finishedAt: null,
  deadlineAt: null,
  createdAt: stamp,
};

const baseSource = (
  versionId: string,
  origin: StoredVersionSource["origin"],
  approvedTask: unknown,
) => ({
  sandboxVersionId: versionId,
  origin,
  sourceSnapshotId: null,
  sourceCommitSha: null,
  sliceRunId: null,
  manifestSha256: null,
  contractSha256: null,
  starterRunId: "arn_import",
  starterSha256: null,
  transformConfigSha256: "1".repeat(64),
  approvedTaskSha256: "2".repeat(64),
  proposalVersion: 1,
  contextVersions: { jira: null, github: null },
  approvedTask,
  aliasRules: [],
  dependencyChoices: {},
  acceptanceTests: [],
  fixtures: null,
  scope: {
    editablePaths: [],
    generatedPaths: [],
    permittedOperations: ["edit", "add"],
    dependencies: [],
    blockers: [],
  },
  harnessSha256: null,
  toolchainDigest: null,
  buildRunId: "arn_import",
  roundTripRunId: null,
  disclosureRunId: null,
  approvedBy: null,
  approvedAt: null,
  createdAt: stamp,
  updatedAt: stamp,
});

const version = (id: string) => ({
  id,
  sandboxId: "sbx_up",
  version: 1,
  title: "Sum a cart",
  specSummary: "The cart adds up its prices.",
  complexity: "M",
  tags: [],
  testSummary: [],
  publicBaseCommitSha: null,
  readme: null,
  languages: null,
  frozenAt: stamp,
  createdAt: stamp,
});

/** The build an uploaded version's import run committed, by artifact path. */
const MANIFEST = JSON.stringify({
  layout: { tests: { privateDir: null } },
  upload: { recordSha256: "r".repeat(64), carveoutVersion: "0.4.0" },
  files: [
    { path: "src/price.ts", class: "source" },
    { path: ACCEPT.path, class: "test-private" },
  ],
});
const BUILD: Record<string, string> = {
  "build-manifest.json": MANIFEST,
  "project/src/price.ts": "export const discounted = (c: number) => c;\n",
  "project/src/cart.ts": "export const cart = 1;\n",
  [`private/${ACCEPT.path}`]: ACCEPT.text,
};

function fixture(
  role = "owner",
  overrides: Partial<{
    sandbox: { sourceRepoId: string | null } | null;
    put: boolean;
    proposalStatus: "proposed" | "approved";
    quota: boolean;
    limit: boolean;
    created: "ok" | "source_linked" | "starter_in_progress" | "not-found";
    raced: boolean;
    submission: Record<string, unknown>;
    origin: StoredVersionSource["origin"];
    submitted: { path: string; text: string }[];
    build: Record<string, string>;
  }> = {},
) {
  const objects = new Map<string, Uint8Array>();
  const enqueued: {
    snapshotId: string | null;
    input: { tool: string; params: Record<string, unknown> };
  }[] = [];
  const createdVersions: {
    sandboxId: string;
    input: { id: string; source: Record<string, unknown> };
  }[] = [];
  const createdSandboxes: unknown[] = [];
  const removed: string[] = [];
  let launches = 0;
  const existing =
    overrides.sandbox === undefined || overrides.sandbox === null
      ? null
      : {
          id: "sbx_up",
          organizationId: "org_1",
          slug: "abc",
          status: "draft",
          publicRepoId: null,
          currentVersionId: null,
          expiresAt: null,
          bountyId: "bty_1",
          createdAt: stamp,
          updatedAt: stamp,
          ...overrides.sandbox,
        };
  const submitted = overrides.submitted ?? [
    {
      path: "src/price.ts",
      text: "export const discounted = (c: number) => Math.round(c * 0.9);\n",
    },
    { path: "src/cart.ts", text: "export const cart = 1;\n" },
    { path: "src/helper.ts", text: "export const h = 1;\n" },
    { path: ACCEPT.path, text: "test passes\n" },
  ];
  objects.set(
    "submissions/org_1/sbv_up/key.json",
    Buffer.from(submittedFilesText(submitted)),
  );
  const build = overrides.build ?? BUILD;
  for (const [path, text] of Object.entries(build))
    objects.set(`runs/arn_import/${path}`, Buffer.from(text));
  const options = {
    sandboxes: {
      list: async (owner: string) =>
        owner === "org_1" && existing !== null ? [existing] : [],
      create: async (
        owner: string,
        input: { bountyId: string; sourceRepoId: string | null },
      ) => {
        createdSandboxes.push(input);
        if (overrides.raced === true)
          return { ok: false, reason: "bounty_has_sandbox" };
        return {
          ok: true,
          sandbox: {
            id: "sbx_up",
            organizationId: owner,
            slug: "abc",
            status: "draft",
            publicRepoId: null,
            currentVersionId: null,
            expiresAt: null,
            createdAt: stamp,
            updatedAt: stamp,
            ...input,
          },
        };
      },
      get: async () => existing,
      createVersion: async (
        _owner: string,
        sandboxId: string,
        input: { id: string; source: Record<string, unknown> },
      ) => {
        createdVersions.push({ sandboxId, input });
        const result = overrides.created ?? "ok";
        return result === "ok"
          ? {
              ok: true,
              version: { ...version(input.id), frozenAt: null },
              source: baseSource(
                input.id,
                "upload",
                input.source["approvedTask"],
              ),
            }
          : { ok: false, reason: result };
      },
      getVersion: async (owner: string, id: string) =>
        owner === "org_1" && id === "sbv_up"
          ? {
              version: version(id),
              source: baseSource(id, overrides.origin ?? "upload", null),
            }
          : null,
      listVersions: async () => [],
    },
    runs: {
      get: async () => null,
      enqueue: async (
        _owner: string,
        snapshotId: string | null,
        input: { tool: string; params: Record<string, unknown> },
      ) => {
        enqueued.push({ snapshotId, input });
        if (overrides.quota === true) return quotaRefusal;
        if (overrides.limit === true) return { ok: false, reason: "run_limit" };
        return {
          ok: true,
          created: true,
          run: { ...importRun, params: input.params },
        };
      },
    },
    artifacts: {
      list: async (owner: string, runId: string) =>
        owner === "org_1" && runId === "arn_import"
          ? Object.keys(build).map((path) => ({
              id: path,
              runId,
              path,
              objectKey: `runs/arn_import/${path}`,
              kind: "other",
              contentType: "text/plain",
              sizeBytes: 1,
              sha256: "0".repeat(64),
              meta: null,
              createdAt: stamp,
            }))
          : [],
    },
    objects: {
      get: async (key: string) => objects.get(key),
      remove: async (key: string) => {
        removed.push(key);
        objects.delete(key);
      },
      ...(overrides.put === false
        ? {}
        : {
            put: async (key: string, body: Uint8Array) => {
              objects.set(key, body);
            },
          }),
    },
    submissions: {
      create: async () => ({ ok: false, reason: "not-found" }),
      list: async () => [],
      retry: async () => ({ ok: false, reason: "not-found" }),
      get: async (owner: string, id: string) =>
        owner === "org_1" && id === "sbm_up"
          ? {
              id,
              sandboxVersionId: "sbv_up",
              submittedBy: "user_1",
              patchSha256: "a".repeat(64),
              patchKey: "submissions/org_1/sbv_up/key.json",
              status: "passed",
              result: {
                public: { passed: 1, total: 1 },
                hidden: { passed: 1, total: 1 },
                verdict: "passed",
                failedScenarios: [],
              },
              runId: "arn_grade",
              retryOf: null,
              createdAt: stamp,
              updatedAt: stamp,
              ...overrides.submission,
            }
          : null,
    },
    bounties: {
      get: async (owner: string, id: string) =>
        owner === "org_1" && id === "bty_1"
          ? {
              id,
              title: "Sum a cart",
              description: "The cart adds up its prices.",
              stack: [],
              version: 1,
              approval: { version: 1, approvedBy: "user_1", approvedAt: stamp },
            }
          : null,
    },
    repos: { list: async () => [] },
    organizationNames: async (owner: string) =>
      owner === "org_1" ? ["Payflow Labs", "payflow-labs"] : [],
    proposals: {
      liveForBounty: async () => "bpr_1",
      get: async (_owner: string, id: string) =>
        id === "bpr_1"
          ? {
              id,
              bountyId: "bty_1",
              revision: 3,
              version: 1,
              complexity: "M",
              amountMinor: 10500,
              currency: "USD",
              status: overrides.proposalStatus ?? "approved",
              decidedAt: stamp,
              specRevision: 2,
              repositories: [],
            }
          : null,
    },
    specs: {
      get: async (_owner: string, _id: string, revision: number) => ({
        revision,
        specHash: "s".repeat(64),
        draft,
      }),
    },
    ensureWorker: async () => {
      launches++;
    },
    now: () => new Date(stamp),
  } as unknown as SandboxRouteOptions;
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/api/v1/orgs/:orgId/*", async (c, next) => {
    c.set("user", { id: "user_1" } as never);
    c.set("member", { role, organizationId: c.req.param("orgId") } as never);
    c.set("principal", { via: "token" } as never);
    await next();
  });
  mountSandboxRoutes(app, options);
  const request = (
    method: string,
    path: string,
    body?: unknown,
    org = "org_1",
  ) =>
    app.request(`/api/v1/orgs/${org}/sandboxes${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: typeof body === "string" ? body : JSON.stringify(body),
          }),
    });
  return {
    request,
    objects,
    enqueued,
    createdVersions,
    createdSandboxes,
    removed,
    launches: () => launches,
  };
}

const codeOf = async (response: Response) =>
  ((await response.json()) as { code?: string }).code;

test("an admin's upload is stored by its hash, imported by a sandbox_import run, and answered 202 with the draft", async () => {
  const f = fixture();
  const body = uploadBody();
  const response = await f.request("POST", "/uploads", body);
  assert.equal(response.status, 202);
  const answer = (await response.json()) as {
    sandbox: { id: string; sourceRepoId: string | null };
    version: { id: string };
    source: { origin: string; acceptanceTests: unknown[] };
    run: { tool: string };
  };
  assert.equal(answer.run.tool, "sandbox_import");
  assert.equal(answer.source.origin, "upload");
  assert.deepEqual(answer.source.acceptanceTests, []);
  // A bounty with no sandbox gets one with no repository.
  assert.deepEqual(f.createdSandboxes, [
    { bountyId: "bty_1", sourceRepoId: null },
  ]);
  const [queued] = f.enqueued;
  assert.equal(queued?.snapshotId, null);
  assert.equal(queued?.input.tool, "sandbox_import");
  const params = queued?.input.params ?? {};
  assert.equal(params["importer"], "upload");
  assert.equal(params["sandboxVersionId"], answer.version.id);
  assert.equal(params["recordSha256"], body.carveout.recordSha256);
  assert.equal(params["carveoutVersion"], "0.4.0");
  const key = uploadObjectKey(
    "org_1",
    answer.version.id,
    String(params["uploadSha256"]),
  );
  const stored = f.objects.get(key);
  assert.ok(stored !== undefined);
  const text = Buffer.from(stored).toString("utf8");
  assert.equal(sha(text), params["uploadSha256"]);
  const parsed = JSON.parse(text) as {
    files: { path: string }[];
    acceptanceTests: { path: string; expectedBaseline: string }[];
  };
  assert.deepEqual(
    parsed.files.map((file) => file.path),
    [
      ".npmrc",
      "carveout.json",
      "package-lock.json",
      "package.json",
      "src/price.ts",
    ],
  );
  assert.deepEqual(
    parsed.acceptanceTests.map((item) => [item.path, item.expectedBaseline]),
    [[ACCEPT.path, "fail"]],
  );
  const [made] = f.createdVersions;
  assert.equal(made?.input.source["origin"], "upload");
  assert.equal(made?.input.source["importRunId"], "arn_import");
  assert.deepEqual(made?.input.source["acceptanceTests"], []);
  assert.equal(f.launches(), 1);
  // An existing sandbox with no repository takes the upload as it is.
  const again = fixture("admin", { sandbox: { sourceRepoId: null } });
  assert.equal((await again.request("POST", "/uploads", body)).status, 202);
  assert.deepEqual(again.createdSandboxes, []);
  // Two at once, the other's sandbox not yet listed: refused, never doubled.
  const raced = fixture("admin", { raced: true });
  const twice = await raced.request("POST", "/uploads", body);
  assert.equal(twice.status, 409);
  assert.equal(await codeOf(twice), "bounty_has_sandbox");
});

test("an upload is for owners and admins of the bounty's own workspace, on an approved scope and price, with no repository", async () => {
  const body = uploadBody();
  assert.equal(
    (await fixture("member").request("POST", "/uploads", body)).status,
    403,
  );
  // Another workspace's bounty is not there.
  const other = await fixture().request("POST", "/uploads", body, "org_2");
  assert.equal(other.status, 404);
  const held = await fixture("owner", { proposalStatus: "proposed" }).request(
    "POST",
    "/uploads",
    body,
  );
  assert.equal(held.status, 409);
  assert.equal(await codeOf(held), "step_held");
  const linked = await fixture("owner", {
    sandbox: { sourceRepoId: "ghr_1" },
  }).request("POST", "/uploads", body);
  assert.equal(linked.status, 409);
  assert.equal(await codeOf(linked), "source_linked");
  const store = await fixture("owner", { created: "source_linked" }).request(
    "POST",
    "/uploads",
    body,
  );
  assert.equal(await codeOf(store), "source_linked");
  const busy = await fixture("owner", {
    created: "starter_in_progress",
  }).request("POST", "/uploads", body);
  assert.equal(await codeOf(busy), "version_in_progress");
  const none = fixture("owner", { put: false });
  const unavailable = await none.request("POST", "/uploads", body);
  assert.equal(unavailable.status, 503);
  assert.equal(await codeOf(unavailable), "uploads_unavailable");
  assert.deepEqual(none.enqueued, []);
});

test("an upload over its limits, or with a path or file that is no folder's, is refused before anything is stored", async () => {
  const f = fixture();
  const status = async (body: unknown) => {
    const response = await f.request("POST", "/uploads", body);
    return [response.status, await codeOf(response)];
  };
  const many = Array.from({ length: UPLOAD_LIMITS.files + 1 }, (_, i) => ({
    path: `src/f${i}.ts`,
    text: "x\n",
  }));
  assert.deepEqual(await status(uploadBody({ extra: many })), [
    400,
    "invalid_upload",
  ]);
  assert.deepEqual(
    await status(
      uploadBody({
        extra: [
          { path: "src/big.ts", text: "x".repeat(UPLOAD_LIMITS.fileBytes + 1) },
        ],
      }),
    ),
    [400, "invalid_upload"],
  );
  // Under the limit in characters, over it in bytes.
  assert.deepEqual(
    await status(
      uploadBody({
        extra: [
          {
            path: "src/wide.ts",
            text: "é".repeat(UPLOAD_LIMITS.fileBytes / 2 + 1),
          },
        ],
      }),
    ),
    [400, "upload_too_large"],
  );
  const whole = Array.from({ length: 17 }, (_, i) => ({
    path: `src/p${i}.ts`,
    text: "y".repeat(500_000),
  }));
  assert.deepEqual(await status(uploadBody({ extra: whole })), [
    400,
    "invalid_upload",
  ]);
  assert.deepEqual(await status(uploadBody({ acceptanceTests: [] })), [
    400,
    "invalid_upload",
  ]);
  assert.deepEqual(
    await status(
      uploadBody({
        acceptanceTests: [{ ...ACCEPT, expectedBaseline: "pass" }],
      }),
    ),
    [400, "invalid_upload"],
  );
  assert.deepEqual(
    await status(
      uploadBody({
        acceptanceTests: [{ ...ACCEPT, path: "tests/private/a.md" }],
      }),
    ),
    [400, "invalid_upload"],
  );
  for (const path of [
    "node_modules/x/index.js",
    ".git/config",
    "src/../x.ts",
    "a\\b.ts",
  ])
    assert.deepEqual(
      await status(uploadBody({ extra: [{ path, text: "x\n" }] })),
      [400, "invalid_files"],
      path,
    );
  assert.deepEqual(
    await status(uploadBody({ extra: [{ path: "src/bin.ts", text: "a\0b" }] })),
    [400, "invalid_files"],
  );
  assert.deepEqual(
    await status(
      uploadBody({ extra: [{ path: "src/price.ts", text: "twice\n" }] }),
    ),
    [400, "invalid_files"],
  );
  assert.deepEqual(
    await status(uploadBody({ extra: [{ path: ACCEPT.path, text: "x\n" }] })),
    [400, "invalid_files"],
  );
  const missing = await f.request(
    "POST",
    "/uploads",
    uploadBody({ files: [{ path: "carveout.json", text: record() }] }),
  );
  assert.equal(missing.status, 400);
  assert.deepEqual(((await missing.json()) as { files: string[] }).files, [
    "package-lock.json",
    "package.json",
  ]);
  assert.deepEqual(await status("not json"), [400, "invalid_upload"]);
  // The body itself is bounded before it is read.
  assert.equal(
    (await f.request("POST", "/uploads", "x".repeat(12_000_001))).status,
    413,
  );
  assert.equal(f.objects.size, 1 + Object.keys(BUILD).length);
  assert.deepEqual(f.enqueued, []);
});

test("an upload that is not a public folder, names the workspace or holds a credential is refused, naming files only", async () => {
  const f = fixture();
  const refusal = async (body: unknown) => {
    const response = await f.request("POST", "/uploads", body);
    return {
      status: response.status,
      body: (await response.json()) as { code: string; files?: string[] },
    };
  };
  for (const recordText of [
    record({ publicScrubbed: false }),
    record({ request: { public: false } }),
    "not json",
  ]) {
    const answer = await refusal(uploadBody({ record: recordText }));
    assert.deepEqual(
      [answer.status, answer.body.code],
      [400, "not_public_folder"],
    );
  }
  const offline = await refusal(
    uploadBody({ record: record({ lockfile: false }) }),
  );
  assert.deepEqual(
    [offline.status, offline.body.code],
    [400, "incomplete_folder"],
  );
  const mismatch = await refusal(uploadBody({ recordSha256: "f".repeat(64) }));
  assert.deepEqual(
    [mismatch.status, mismatch.body.code],
    [400, "record_mismatch"],
  );
  const leaked = await f.request(
    "POST",
    "/uploads",
    uploadBody({
      extra: [{ path: "src/brand.ts", text: "// payflow labs pricing\n" }],
    }),
  );
  assert.equal(leaked.status, 409);
  const leakedText = await leaked.text();
  assert.deepEqual(JSON.parse(leakedText), {
    error:
      "The upload holds names this workspace goes by. Add them to the cut (--name, or names in carveout.config.json) and hand off again.",
    code: "names_leaked",
    files: ["src/brand.ts"],
  });
  assert.doesNotMatch(leakedText, /payflow/i);
  // In an acceptance test too.
  const inTest = await refusal(
    uploadBody({
      acceptanceTests: [{ ...ACCEPT, text: `${ACCEPT.text}// Payflow\n` }],
    }),
  );
  assert.deepEqual(
    [inTest.status, inTest.body.code, inTest.body.files],
    [409, "names_leaked", [ACCEPT.path]],
  );
  for (const extra of [
    { path: ".env", text: "STRIPE=x\n" },
    // Joined here, so no scanner reads this file as holding a key.
    {
      path: "src/key.ts",
      text: `export const key = \`${["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ")}\nMIIEpAIBAAKCAQEA7bqZ3x9Kp2Lm4Nq8Rt5Vw1Yz6Hc0Jd3Fg7Bh2Ks9Lx4\n\`;\n`,
    },
  ]) {
    const answer = await refusal(uploadBody({ extra: [extra] }));
    assert.deepEqual(
      [answer.status, answer.body.code, answer.body.files],
      [409, "secret_file", [extra.path]],
    );
  }
  const npmrc = await refusal(
    uploadBody({
      files: uploadBody().files.map((file) =>
        file.path === ".npmrc"
          ? { path: ".npmrc", text: "//registry.npmjs.org/:_authToken=abc\n" }
          : file,
      ),
    }),
  );
  assert.deepEqual(
    [npmrc.body.code, npmrc.body.files],
    ["secret_file", [".npmrc"]],
  );
  assert.deepEqual(f.enqueued, []);
});

test("an upload over the workspace's monthly tokens or its active runs is refused, and its stored files removed", async () => {
  const quota = fixture("owner", { quota: true });
  const refused = await quota.request("POST", "/uploads", uploadBody());
  assert.equal(refused.status, 429);
  assert.equal(await codeOf(refused), "quota_exceeded");
  assert.ok(Number(refused.headers.get("Retry-After")) > 0);
  assert.deepEqual(quota.createdVersions, []);
  assert.equal(quota.removed.length, 1);
  assert.match(quota.removed[0] ?? "", /^uploads\/org_1\/sbv_/);
  assert.equal(quota.objects.has(quota.removed[0] ?? ""), false);
  const limit = fixture("owner", { limit: true });
  const busy = await limit.request("POST", "/uploads", uploadBody());
  assert.equal(busy.status, 409);
  assert.equal(await codeOf(busy), "run_limit");
});

test("a passing submission on an uploaded version gives back what it changed, never a hidden test, and is not cached", async () => {
  const f = fixture();
  const response = await f.request("GET", "/submissions/sbm_up/files");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const answer = (await response.json()) as {
    submission: { id: string; verdict: string };
    upload: unknown;
    files: { path: string }[];
  };
  assert.equal(answer.submission.verdict, "passed");
  assert.deepEqual(answer.upload, {
    recordSha256: "r".repeat(64),
    carveoutVersion: "0.4.0",
  });
  // cart.ts is the version's own text; the acceptance test's path is never answered.
  assert.deepEqual(
    answer.files.map((file) => file.path),
    ["src/helper.ts", "src/price.ts"],
  );
  // Under a layout's hidden-tests directory, nothing is answered either.
  const dir = fixture("owner", {
    build: {
      ...BUILD,
      "build-manifest.json": MANIFEST.replace(
        '"privateDir":null',
        '"privateDir":"src"',
      ),
    },
  });
  const under = (await (
    await dir.request("GET", "/submissions/sbm_up/files")
  ).json()) as { files: unknown[] };
  assert.deepEqual(under.files, []);
});

test("files are given back only for a passing submission on an uploaded version, to owners and admins of its workspace", async () => {
  assert.equal(
    (await fixture("member").request("GET", "/submissions/sbm_up/files"))
      .status,
    403,
  );
  assert.equal(
    (
      await fixture().request(
        "GET",
        "/submissions/sbm_up/files",
        undefined,
        "org_2",
      )
    ).status,
    404,
  );
  assert.equal(
    (await fixture().request("GET", "/submissions/sbm_nope/files")).status,
    404,
  );
  for (const submission of [
    {
      status: "failed",
      result: {
        public: { passed: 1, total: 1 },
        hidden: { passed: 0, total: 1 },
        verdict: "overfit",
        failedScenarios: ["s1"],
      },
    },
    { status: "queued", result: null },
  ]) {
    const response = await fixture("owner", { submission }).request(
      "GET",
      "/submissions/sbm_up/files",
    );
    assert.equal(response.status, 409);
    assert.equal(await codeOf(response), "not_passed");
  }
  for (const origin of ["slice", "starter"] as const) {
    const response = await fixture("owner", { origin }).request(
      "GET",
      "/submissions/sbm_up/files",
    );
    assert.equal(response.status, 409);
    assert.equal(await codeOf(response), "not_uploaded");
  }
  const unreadable = await fixture("owner", {
    build: { "project/src/price.ts": "x" },
  }).request("GET", "/submissions/sbm_up/files");
  assert.equal(unreadable.status, 502);
  const noUpload = await fixture("owner", {
    build: { "build-manifest.json": "{}" },
  }).request("GET", "/submissions/sbm_up/files");
  assert.equal(noUpload.status, 502);
});

test("a token reaches the upload with sandboxes:write and the files with submissions:write only", () => {
  const token = (scopes: string[]) => ({ via: "token", scopes }) as never;
  const upload = {
    method: "POST",
    path: "/api/v1/orgs/:orgId/sandboxes/uploads",
  };
  const files = {
    method: "GET",
    path: "/api/v1/orgs/:orgId/sandboxes/submissions/:sid/files",
  };
  assert.equal(admit(token(["sandboxes:write"]), upload), undefined);
  assert.equal(
    admit(token(["workspace:read", "submissions:write"]), upload)?.code,
    "insufficient_scope",
  );
  assert.equal(admit(token(["submissions:write"]), files), undefined);
  assert.equal(
    admit(token(["workspace:read", "sandboxes:write"]), files)?.code,
    "insufficient_scope",
  );
  // A device sign-in reaches neither.
  assert.equal(
    admit({ via: "device" } as never, upload)?.code,
    "device_session",
  );
});

test("the checks name the files they refuse, and the answer leaves out what is not a plain changed path", () => {
  const ok = checkUpload(uploadBody() as never, []);
  assert.ok("recordSha256" in ok);
  const big = checkUpload(
    uploadBody({
      extra: Array.from({ length: 17 }, (_, i) => ({
        path: `p${i}.ts`,
        text: "z".repeat(500_000),
      })),
    }) as never,
    [],
  );
  assert.ok("refusal" in big && big.refusal.body.code === "upload_too_large");
  assert.deepEqual(
    changedSubmissionFiles({
      submitted: [
        { path: "b.ts", text: "new" },
        { path: "a.ts", text: "new" },
        { path: "../x.ts", text: "x" },
        { path: "same.ts", text: "same" },
        { path: "hidden/s1.test.ts", text: "x" },
      ],
      publicText: (path) => (path === "same.ts" ? "same" : null),
      hiddenPaths: new Set(),
      privateDir: "hidden",
    }).map((file) => file.path),
    ["a.ts", "b.ts"],
  );
});
