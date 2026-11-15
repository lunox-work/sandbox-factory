/**
 * Invited contributors, through `createApp` as a request meets them: the
 * credential guard, the membership guard and the routes. The workspace's
 * owner invites; a person outside it claims, downloads, submits and reads
 * their own verdicts; everything else answers them 404. Stores are
 * in-memory doubles that keep the rules the Postgres stores keep (per
 * person dedupe, one first submission per assignment, one retry).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  AuditStore,
  ContributorStore,
  NewAuditEntry,
  NewSubmission,
  StoredArtifact,
  StoredContributorAssignment,
  StoredContributorInvite,
  StoredSubmission,
} from "@sandbox-factory/db";
import { SUBMISSION_ZIP_MAX_BYTES } from "@sandbox-factory/shared";
import {
  SANDBOX_COMMANDS,
  submittedFilesText,
  type SubmissionResult,
} from "sandbox-factory";

import {
  generateContributorSecret,
  generateSecret,
  hashSecret,
} from "../src/api-tokens/secret.js";
import type { Auth } from "../src/auth.js";
import { createApp } from "../src/routes.js";
import {
  CLAIM_ATTEMPTS,
  generateInviteToken,
  INVITE_TOKEN_PREFIX,
} from "../src/sandbox/contributors.js";
import type { SandboxRouteOptions } from "../src/sandbox/routes.js";
import { zip } from "../src/sandbox/zip.js";
import {
  memoryContributorTokens,
  memoryTokens,
  roleStore,
} from "./token-fakes.js";
import { unzip } from "./zip-reader.js";

const sha = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const PEOPLE = {
  owner: { id: "user_1", email: "ada@example.test", name: "Ada Lovelace" },
  grace: { id: "user_c", email: "grace@example.test", name: "Grace Hopper" },
  alan: { id: "user_s", email: "alan@example.test", name: "Alan Turing" },
  member: { id: "user_m", email: "kat@example.test", name: "Kat Johnson" },
} as const;
type Person = keyof typeof PEOPLE;
const as = (person: Person) => ({ cookie: `session=${person}` });

function fakeAuth(): Auth {
  return {
    api: {
      getSession: ({ headers }: { headers: Headers }) => {
        const name = /session=(\w+)/.exec(headers.get("cookie") ?? "")?.[1];
        const user =
          name === undefined
            ? undefined
            : (PEOPLE[name as Person] ?? undefined);
        return Promise.resolve(
          user === undefined
            ? null
            : { user, session: { id: `ses_${user.id}`, deviceClientId: null } },
        );
      },
    },
    handler: () => Promise.resolve(Response.json({})),
  } as unknown as Auth;
}

const descriptor = JSON.stringify({
  schemaVersion: 1,
  sandboxId: "sbx_1",
  versionId: "sbv_1",
  version: 1,
  title: "Statement fees",
  specSummary: "Each debit line shows the fee it paid.",
  complexity: "S",
  tags: ["typescript"],
  commands: SANDBOX_COMMANDS,
  toolchain: {
    node: "22.12.0",
    nodeRange: ">=22.12.0",
    npm: "10.9.2",
    typescript: "5.9.3",
    testRunner: "node:test",
    supportedPlatforms: ["darwin", "linux"],
  },
  editablePaths: ["src/fees.ts"],
  publicTests: ["tests/fees.test.ts"],
  testSummary: [{ label: "public", count: 1 }],
});
const BUILT: Record<string, string> = {
  "project/README.md": "# Statement fees\n",
  "project/sandbox-task.json": descriptor,
  "project/src/fees.ts": "export const fee = () => 0;\n",
  "private/fee-minimum.test.ts": "assert.equal(fee(1), 25);\n",
  "build-manifest.json": "{}",
};

/** The doubles, and the knobs a test turns; `extra` adds built files. */
function world(extra: Record<string, string> = {}) {
  const built = { ...BUILT, ...extra };
  const clock = { at: new Date("2026-11-15T00:00:00.000Z") };
  const objects = new Map<string, Uint8Array>(
    Object.entries(built).map(([path, text]) => [
      `runs/arn_build/${path}`,
      Buffer.from(text),
    ]),
  );
  const artifacts: StoredArtifact[] = Object.entries(built).map(
    ([path, text]) => ({
      id: `art_${path}`,
      runId: "arn_build",
      kind: "other",
      path,
      objectKey: `runs/arn_build/${path}`,
      contentType: "text/plain",
      sizeBytes: Buffer.byteLength(text),
      sha256: sha(text),
      meta: null,
      createdAt: clock.at.toISOString(),
    }),
  );
  const sandbox = {
    id: "sbx_1",
    organizationId: "org_1",
    status: "published",
    currentVersionId: "sbv_1",
    expiresAt: "2026-12-31T00:00:00.000Z",
  };
  const versions: Record<string, { frozenAt: string | null; number: number }> =
    {
      sbv_1: { frozenAt: "2026-11-14T00:00:00.000Z", number: 1 },
      // A draft beside it: never invited to.
      sbv_2: { frozenAt: null, number: 2 },
    };
  const runs = new Map<
    string,
    { id: string; status: string; params: unknown; snapshotId: string | null }
  >([
    [
      "arn_build",
      { id: "arn_build", status: "succeeded", params: {}, snapshotId: null },
    ],
  ]);
  const submissions = memorySubmissions(() => clock.at);
  const contributors = memoryContributors();
  const enqueued: {
    owner: string;
    submissionId: string;
    requestedBy: string | null;
  }[] = [];
  /** Refusals the run store answers next, in order: a brake, a quota. */
  const refusals: unknown[] = [];
  const options = {
    sandboxes: {
      get: async (owner: string, id: string) =>
        owner === "org_1" && id === "sbx_1" ? { ...sandbox } : null,
      getVersion: async (owner: string, id: string) => {
        const version = versions[id];
        return owner !== "org_1" || version === undefined
          ? null
          : {
              version: {
                id,
                sandboxId: "sbx_1",
                version: version.number,
                frozenAt: version.frozenAt,
              },
              source: { buildRunId: "arn_build", sourceSnapshotId: "rsn_1" },
            };
      },
    },
    runs: {
      get: async (owner: string, id: string) =>
        owner === "org_1" ? (runs.get(id) ?? null) : null,
      enqueue: async (
        owner: string,
        snapshotId: string | null,
        input: { params: { submissionId: string }; requestedBy: string | null },
      ) => {
        if (refusals.length > 0) return refusals.shift();
        const key = input.params.submissionId;
        const existing = [...runs.values()].find(
          (run) =>
            (run.params as { submissionId?: string }).submissionId === key,
        );
        if (existing !== undefined) {
          // An ended run with attempts left is queued again, its
          // submission reopened with it.
          if (existing.status === "failed") {
            existing.status = "queued";
            submissions.reopen(key);
          }
          return { ok: true, run: existing, created: false };
        }
        const run = {
          id: `arn_g${runs.size}`,
          status: "queued",
          params: input.params,
          snapshotId,
        };
        runs.set(run.id, run);
        enqueued.push({
          owner,
          submissionId: key,
          requestedBy: input.requestedBy,
        });
        submissions.ran(key, run.id);
        return { ok: true, run, created: true };
      },
    },
    artifacts: {
      list: async (owner: string, runId: string) =>
        owner === "org_1" && runId === "arn_build" ? artifacts : [],
    },
    objects: {
      get: async (key: string) => objects.get(key),
      put: async (key: string, bytes: Uint8Array) => {
        objects.set(key, bytes);
      },
      remove: async () => undefined,
    },
    submissions,
    contributors,
    inviteUrl: (token: string) => `https://app.example.test/invite#${token}`,
    proposals: {},
    specs: {},
    bounties: {},
    repos: {},
    ensureWorker: async () => undefined,
    now: () => clock.at,
  } as unknown as SandboxRouteOptions;
  const tokens = memoryTokens();
  const contributorTokens = memoryContributorTokens(
    Object.fromEntries(
      Object.values(PEOPLE).map((person) => [person.id, person]),
    ),
  );
  const audited: Array<{ organizationId: string } & NewAuditEntry> = [];
  const audit = {
    record: async (organizationId: string, entry: NewAuditEntry) => {
      audited.push({ organizationId, ...entry });
    },
  } as unknown as AuditStore;
  const app = createApp({
    corsOrigins: [],
    auth: fakeAuth(),
    organizations: roleStore({
      "user_1:org_1": "owner",
      "user_m:org_1": "member",
    }),
    apiTokens: tokens,
    contributorTokens,
    audit,
    publicUrl: "http://localhost:4000",
    sandbox: options,
    now: () => clock.at,
  });
  /** A person's own contributor token, as their session would mint it. */
  const contributorBearer = async (person: Person) => {
    const secret = generateContributorSecret();
    await contributorTokens.create(PEOPLE[person].id, {
      name: "Editor",
      prefix: secret.slice(0, 13),
      hash: hashSecret(secret),
      expiresAt: null,
    });
    return { authorization: `Bearer ${secret}` };
  };
  /** An MCP client at `path`, over `bearer`, against this app. */
  const mcp = async (path: string, bearer: Record<string, string>) => {
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://localhost:4000${path}`),
        {
          requestInit: { headers: bearer },
          fetch: (url, init) => Promise.resolve(app.request(String(url), init)),
        },
      ),
    );
    return client;
  };
  const request = async (
    person: Person | Record<string, string>,
    method: string,
    path: string,
    body?: unknown,
  ) => {
    // Bytes are sent as they are, as a zipped folder; anything else as JSON.
    const raw = body instanceof Uint8Array;
    const response = await app.request(path.replace(":org", "org_1"), {
      method,
      headers: {
        ...(typeof person === "string" ? as(person) : person),
        ...(body === undefined
          ? {}
          : { "content-type": raw ? "application/zip" : "application/json" }),
      },
      ...(body === undefined
        ? {}
        : { body: raw ? body : JSON.stringify(body) }),
    });
    return response;
  };
  const json = async (
    person: Person | Record<string, string>,
    method: string,
    path: string,
    body?: unknown,
  ) => {
    const response = await request(person, method, path, body);
    const text = await response.text();
    return {
      status: response.status,
      text,
      body: (text === "" ? null : JSON.parse(text)) as Record<string, any>,
      headers: response.headers,
    };
  };
  /** A grading run that ended without a verdict, as the run store ends it. */
  const errored = (submissionId: string) => {
    submissions.error(submissionId);
    for (const run of runs.values())
      if (
        (run.params as { submissionId?: string }).submissionId === submissionId
      )
        run.status = "failed";
  };
  return {
    clock,
    sandbox,
    objects,
    errored,
    submissions,
    contributors,
    enqueued,
    refusals,
    tokens,
    audited,
    contributorBearer,
    mcp,
    request,
    json,
  };
}

/** An invite made by the owner, and its secret. */
async function invited(w: ReturnType<typeof world>, body: unknown = {}) {
  const made = await w.json(
    "owner",
    "POST",
    "/api/v1/orgs/:org/sandboxes/versions/sbv_1/invites",
    body,
  );
  assert.equal(made.status, 201, made.text);
  return made.body as {
    invite: { id: string; state: string };
    token: string;
    claimUrl: string;
  };
}

const solution = [
  { path: "src/fees.ts", text: "export const fee = () => 25;\n" },
];
const partial = [
  { path: "src/fees.ts", text: "export const fee = () => 1;\n" },
];
const C = "/api/v1/contributions/sbv_1";

test("owner invites, the contributor claims, downloads, submits and reads only their own verdict", async () => {
  const w = world();
  const { invite, token, claimUrl } = await invited(w, {
    label: "Grace",
    email: "grace@example.test",
  });
  assert.ok(token.startsWith(INVITE_TOKEN_PREFIX));
  assert.equal(claimUrl, `https://app.example.test/invite#${token}`);
  assert.equal(invite.state, "active");
  // The secret is shown once: never stored, never listed.
  const stored = w.contributors.invites[0];
  assert.equal(stored?.tokenSha256, hashSecret(token));
  const listed = await w.json(
    "owner",
    "GET",
    "/api/v1/orgs/:org/sandboxes/versions/sbv_1/contributors",
  );
  assert.equal(listed.status, 200);
  assert.doesNotMatch(listed.text, new RegExp(token));
  assert.doesNotMatch(listed.text, /tokenSha256/);
  assert.equal(listed.body["invites"][0].emailHint, "grace@example.test");

  // Before claiming, nothing is theirs.
  assert.equal((await w.json("grace", "GET", C)).status, 404);
  const claimed = await w.json("grace", "POST", "/api/v1/invites/claim", {
    token,
  });
  assert.equal(claimed.status, 201, claimed.text);
  const contribution = claimed.body["contribution"];
  assert.deepEqual(
    {
      ...contribution,
      assignmentId: undefined,
    },
    {
      assignmentId: undefined,
      versionId: "sbv_1",
      version: 1,
      root: "sbx_1-v1",
      title: "Statement fees",
      specSummary: "Each debit line shows the fee it paid.",
      complexity: "S",
      tags: ["typescript"],
      commands: SANDBOX_COMMANDS,
      editablePaths: ["src/fees.ts"],
      nodeRange: ">=22.12.0",
      open: true,
      closesAt: "2026-12-31T00:00:00.000Z",
      joinedAt: "2026-11-15T00:00:00.000Z",
    },
  );
  // No workspace, no organization id, no bounty.
  assert.doesNotMatch(claimed.text, /org_1|Acme|bounty/i);
  // Claimed again by them: the same access.
  const again = await w.json("grace", "POST", "/api/v1/invites/claim", {
    token,
  });
  assert.equal(again.status, 200);
  assert.equal(
    again.body["contribution"].assignmentId,
    contribution.assignmentId,
  );
  // Someone else cannot use the spent invite.
  const stolen = await w.json("alan", "POST", "/api/v1/invites/claim", {
    token,
  });
  assert.equal(stolen.status, 404);
  assert.equal(stolen.body["code"], "invite_unavailable");
  assert.equal((await w.json("alan", "GET", C)).status, 404);

  const mine = await w.json("grace", "GET", "/api/v1/contributions");
  assert.deepEqual(
    mine.body["contributions"].map(
      (entry: { versionId: string }) => entry.versionId,
    ),
    ["sbv_1"],
  );
  assert.equal(
    (await w.json("grace", "GET", C)).body["contribution"].open,
    true,
  );

  // The handout, archive and pages: public files only.
  const handout = await w.json("grace", "GET", `${C}/handout`);
  assert.equal(handout.status, 200);
  assert.deepEqual(
    handout.body["files"].map((file: { path: string }) => file.path).sort(),
    ["README.md", "sandbox-task.json", "src/fees.ts"],
  );
  assert.equal(handout.body["hiddenTests"], 1);
  assert.doesNotMatch(handout.text, /fee-minimum|private\//);
  // The build run is the workspace's: a contributor's handout names none.
  assert.equal("run" in handout.body, false);
  assert.doesNotMatch(handout.text, /arn_/);
  const archive = await w.request("grace", "GET", `${C}/archive`);
  assert.equal(archive.status, 200);
  assert.equal(archive.headers.get("content-type"), "application/zip");
  const entries = unzip(new Uint8Array(await archive.arrayBuffer()));
  assert.deepEqual(entries.map((entry) => entry.name).sort(), [
    "sbx_1-v1/README.md",
    "sbx_1-v1/sandbox-task.json",
    "sbx_1-v1/src/fees.ts",
  ]);
  const page = await w.json("grace", "GET", `${C}/handout/files?maxBytes=1000`);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /fee-minimum/);

  // The owner's own submission, which the contributor never sees.
  const owners = await w.json(
    "owner",
    "POST",
    "/api/v1/orgs/:org/sandboxes/versions/sbv_1/submissions",
    { files: solution },
  );
  assert.equal(owners.status, 202, owners.text);

  // A first submission, then other files refused: retry that one instead.
  const first = await w.json("grace", "POST", `${C}/submissions`, {
    files: partial,
  });
  assert.equal(first.status, 202, first.text);
  const submissionId = first.body["submission"].id as string;
  // Graded in the workspace, at the contributor's request.
  assert.deepEqual(w.enqueued.at(-1), {
    owner: "org_1",
    submissionId,
    requestedBy: "user_c",
  });
  // The same files as the owner's, from another person: their own.
  assert.notEqual(submissionId, owners.body["submission"].id);
  const second = await w.json("grace", "POST", `${C}/submissions`, {
    files: solution,
  });
  assert.equal(second.status, 409);
  assert.deepEqual(
    [second.body["code"], second.body["submissionId"]],
    ["already_submitted", submissionId],
  );
  // The same files again: the submission already made.
  const resent = await w.json("grace", "POST", `${C}/submissions`, {
    files: partial,
  });
  assert.equal(resent.status, 200);
  assert.equal(resent.body["submission"].id, submissionId);

  // Graded: told counts, verdict and scenario keys; never the run,
  // carry-back or merge-back.
  w.submissions.settle(submissionId, {
    public: { passed: 1, total: 1 },
    hidden: { passed: 0, total: 1 },
    verdict: "overfit",
    failedScenarios: ["s3"],
    refused: [],
    carryBack: "failed",
  });
  const verdict = await w.json(
    "grace",
    "GET",
    `${C}/submissions/${submissionId}`,
  );
  assert.equal(verdict.status, 200);
  assert.deepEqual(Object.keys(verdict.body["submission"]).sort(), [
    "createdAt",
    "errorCode",
    "failedScenarios",
    "hidden",
    "id",
    "public",
    "refused",
    "retryOf",
    "sandboxVersionId",
    "status",
    "updatedAt",
    "verdict",
  ]);
  assert.equal(verdict.body["submission"].verdict, "overfit");
  assert.doesNotMatch(verdict.text, /arn_|fee-minimum|private/);
  const listedMine = await w.json("grace", "GET", `${C}/submissions`);
  assert.deepEqual(
    listedMine.body["submissions"].map((s: { id: string }) => s.id),
    [submissionId],
  );
  // The owner's submission is not theirs to read.
  assert.equal(
    (
      await w.json(
        "grace",
        "GET",
        `${C}/submissions/${owners.body["submission"].id}`,
      )
    ).status,
    404,
  );

  // The workspace sees who made it.
  const read = await w.json(
    "owner",
    "GET",
    `/api/v1/orgs/:org/sandboxes/submissions/${submissionId}`,
  );
  assert.deepEqual(read.body["submission"].contributor, {
    assignmentId: contribution.assignmentId,
    userId: "user_c",
    name: "Grace Hopper",
    email: "grace@example.test",
  });
  const all = await w.json(
    "owner",
    "GET",
    "/api/v1/orgs/:org/sandboxes/versions/sbv_1/submissions",
  );
  assert.deepEqual(
    all.body["submissions"].map(
      (s: { contributor: { name: string } | null }) =>
        s.contributor?.name ?? null,
    ),
    ["Grace Hopper", null],
  );
  // Its one retry is the contributor's, not the owner's to spend.
  const ownerRetry = await w.json(
    "owner",
    "POST",
    `/api/v1/orgs/:org/sandboxes/submissions/${submissionId}/retry`,
    { files: solution },
  );
  assert.equal(ownerRetry.status, 409);
  assert.equal(ownerRetry.body["code"], "contributor_submission");

  const retried = await w.json(
    "grace",
    "POST",
    `${C}/submissions/${submissionId}/retry`,
    { files: solution },
  );
  assert.equal(retried.status, 202, retried.text);
  assert.equal(retried.body["submission"].retryOf, submissionId);
  w.submissions.settle(retried.body["submission"].id, {
    public: { passed: 1, total: 1 },
    hidden: { passed: 1, total: 1 },
    verdict: "passed",
    failedScenarios: [],
    refused: [],
  });
  const used = await w.json(
    "grace",
    "POST",
    `${C}/submissions/${submissionId}/retry`,
    { files: [{ path: "src/fees.ts", text: "x" }] },
  );
  assert.equal(used.status, 409);
  assert.equal(used.body["code"], "retry_used");
  // Not errored: nothing to grade again. The owner's: not theirs.
  assert.equal(
    (await w.json("grace", "POST", `${C}/submissions/${submissionId}/regrade`))
      .body["code"],
    "not_errored",
  );
  assert.equal(
    (
      await w.json(
        "grace",
        "POST",
        `${C}/submissions/${owners.body["submission"].id}/retry`,
        { files: partial },
      )
    ).status,
    404,
  );
});

test("the listing reads the descriptor only as the build recorded it; altered bytes list nothing", async () => {
  const w = world();
  const { token } = await invited(w);
  assert.equal(
    (await w.json("grace", "POST", "/api/v1/invites/claim", { token })).status,
    201,
  );
  // Same length, other bytes: the size check passes, the hash does not.
  const key = "runs/arn_build/project/sandbox-task.json";
  w.objects.set(key, Buffer.from(descriptor.replace("Statement", "Stolen us")));
  const listed = await w.json("grace", "GET", C);
  assert.equal(listed.status, 200);
  assert.equal(listed.body["contribution"].title, null);
  assert.deepEqual(listed.body["contribution"].editablePaths, []);
  // Truncated: the size check alone refuses it.
  w.objects.set(key, Buffer.from(descriptor.slice(0, 10)));
  assert.equal(
    (await w.json("grace", "GET", C)).body["contribution"].title,
    null,
  );
});

test("a contributor reaches nothing of the workspace: logs, private files, merge-back, members, other versions", async () => {
  const w = world();
  const { token } = await invited(w);
  await w.json("grace", "POST", "/api/v1/invites/claim", { token });
  const first = await w.json("grace", "POST", `${C}/submissions`, {
    files: partial,
  });
  const sid = first.body["submission"].id as string;
  w.submissions.settle(sid, {
    public: { passed: 1, total: 1 },
    hidden: { passed: 1, total: 1 },
    verdict: "passed",
    failedScenarios: [],
    refused: [],
  });
  for (const [method, path] of [
    ["GET", "/api/v1/orgs/:org"],
    ["GET", "/api/v1/orgs/:org/members"],
    ["GET", "/api/v1/orgs/:org/sandboxes/versions/sbv_1/files"],
    [
      "GET",
      "/api/v1/orgs/:org/sandboxes/versions/sbv_1/files/content?path=private/fee-minimum.test.ts",
    ],
    ["GET", "/api/v1/orgs/:org/sandboxes/versions/sbv_1/handout"],
    ["GET", "/api/v1/orgs/:org/sandboxes/versions/sbv_1/archive"],
    ["GET", "/api/v1/orgs/:org/sandboxes/versions/sbv_1/submissions"],
    ["GET", `/api/v1/orgs/:org/sandboxes/submissions/${sid}`],
    ["POST", `/api/v1/orgs/:org/sandboxes/submissions/${sid}/merge`],
    ["GET", "/api/v1/orgs/:org/sandboxes/versions/sbv_1/contributors"],
    ["GET", "/api/v1/orgs/:org/github/runs/arn_build/log"],
    ["GET", "/api/v1/contributions/sbv_2"],
    ["GET", "/api/v1/contributions/sbv_2/archive"],
    ["POST", "/api/v1/contributions/sbv_2/submissions"],
  ] as const) {
    const answered = await w.json(
      "grace",
      method,
      path,
      method === "POST" ? { files: solution } : undefined,
    );
    assert.equal(answered.status, 404, `${method} ${path}: ${answered.text}`);
  }
  // A workspace's credential never reaches a contributor's routes, nor claims.
  const secret = generateSecret();
  await w.tokens.create("org_1", {
    createdBy: "user_1",
    name: "ci",
    prefix: secret.slice(0, 12),
    hash: hashSecret(secret),
    scopes: ["workspace:read", "submissions:write"],
    expiresAt: null,
  });
  const bearer = { authorization: `Bearer ${secret}` };
  for (const [method, path] of [
    ["GET", "/api/v1/contributions"],
    ["GET", `${C}/archive`],
    ["POST", "/api/v1/invites/claim"],
  ] as const) {
    const answered = await w.json(
      bearer,
      method,
      path,
      method === "POST" ? {} : undefined,
    );
    assert.equal(answered.status, 403, path);
    assert.equal(answered.body["code"], "workspace_credential");
  }
  // Signed out: nothing.
  assert.equal((await w.json({}, "GET", C)).status, 401);
});

test("a contributor never sees the disclosure findings or the acknowledgements", async () => {
  // The build recorded findings an owner has yet to acknowledge.
  const w = world({
    "build-manifest.json": JSON.stringify({
      gates: {
        roundTrip: { status: "not_applicable", files: 0, problems: [] },
        disclosure: {
          status: "pending_acknowledgement",
          scannedBy: "upload",
          names: 0,
          blocking: 0,
          acknowledgedAt: "publish",
          findings: [
            {
              kind: "url",
              file: "src/fees.ts",
              line: 1,
              value: "https://wiki.halcyon.internal/fees",
              term: "wiki.halcyon.internal",
              acknowledged: false,
            },
          ],
          total: 1,
          acknowledged: 0,
        },
      },
    }),
  });
  const { token } = await invited(w);
  await w.json("grace", "POST", "/api/v1/invites/claim", { token });
  for (const path of [
    "/api/v1/contributions",
    C,
    `${C}/handout`,
    `${C}/handout/files`,
  ]) {
    const read = await w.json("grace", "GET", path);
    assert.equal(read.status, 200, `${path}: ${read.text}`);
    assert.doesNotMatch(read.text, /halcyon|disclosure|acknowledg/i, path);
  }
  // The workspace's routes that hold them answer as if nothing were there.
  for (const [method, path] of [
    ["GET", "/api/v1/orgs/:org/sandboxes/versions/sbv_1"],
    ["GET", "/api/v1/orgs/:org/github/runs/arn_build/artifacts"],
    [
      "PUT",
      "/api/v1/orgs/:org/sandboxes/versions/sbv_1/disclosure-acknowledgements",
    ],
  ] as const) {
    const answered = await w.json(
      "grace",
      method,
      path,
      method === "PUT"
        ? {
            acknowledgements: [
              { kind: "host", value: "wiki.halcyon.internal" },
            ],
          }
        : undefined,
    );
    assert.equal(answered.status, 404, `${method} ${path}: ${answered.text}`);
    assert.doesNotMatch(answered.text, /halcyon/);
  }
});

test("revoking the contributor ends their access at once; a revoked or expired invite admits no one", async () => {
  const w = world();
  const { token } = await invited(w);
  const claimed = await w.json("grace", "POST", "/api/v1/invites/claim", {
    token,
  });
  const assignmentId = claimed.body["contribution"].assignmentId as string;
  assert.equal((await w.json("grace", "GET", `${C}/handout`)).status, 200);
  const revoked = await w.json(
    "owner",
    "POST",
    `/api/v1/orgs/:org/sandboxes/contributors/${assignmentId}/revoke`,
  );
  assert.equal(revoked.status, 200);
  assert.ok(revoked.body["contributor"].revokedAt);
  for (const path of [C, `${C}/handout`, `${C}/archive`, `${C}/submissions`])
    assert.equal((await w.json("grace", "GET", path)).status, 404, path);
  assert.equal(
    (await w.json("grace", "POST", `${C}/submissions`, { files: partial }))
      .status,
    404,
  );
  assert.deepEqual(
    (await w.json("grace", "GET", "/api/v1/contributions")).body[
      "contributions"
    ],
    [],
  );
  // Their spent invite does not bring them back.
  assert.equal(
    (await w.json("grace", "POST", "/api/v1/invites/claim", { token })).status,
    404,
  );
  // Another workspace's ids are as missing as none.
  assert.equal(
    (
      await w.json(
        "owner",
        "POST",
        "/api/v1/orgs/:org/sandboxes/contributors/cas_nope/revoke",
      )
    ).status,
    404,
  );

  // A revoked invite.
  const second = await invited(w);
  const off = await w.json(
    "owner",
    "POST",
    `/api/v1/orgs/:org/sandboxes/invites/${second.invite.id}/revoke`,
  );
  assert.equal(off.body["invite"].state, "revoked");
  assert.equal(
    (
      await w.json("alan", "POST", "/api/v1/invites/claim", {
        token: second.token,
      })
    ).body["code"],
    "invite_unavailable",
  );
  assert.equal(
    (
      await w.json(
        "owner",
        "POST",
        "/api/v1/orgs/:org/sandboxes/invites/cin_nope/revoke",
      )
    ).status,
    404,
  );

  // An expired one: fourteen days by default.
  const third = await invited(w);
  w.clock.at = new Date(w.clock.at.getTime() + 14 * 24 * 60 * 60_000);
  assert.equal(
    (
      await w.json("alan", "POST", "/api/v1/invites/claim", {
        token: third.token,
      })
    ).status,
    404,
  );
  const states = await w.json(
    "owner",
    "GET",
    "/api/v1/orgs/:org/sandboxes/versions/sbv_1/contributors",
  );
  assert.deepEqual(
    states.body["invites"].map((entry: { state: string }) => entry.state),
    ["expired", "revoked", "claimed"],
  );
  // An unknown secret is the same answer.
  assert.equal(
    (
      await w.json("alan", "POST", "/api/v1/invites/claim", {
        token: generateInviteToken(),
      })
    ).body["code"],
    "invite_unavailable",
  );
});

test("invites are an owner's or admin's, for the current published version; members claim nothing", async () => {
  const w = world();
  const path = "/api/v1/orgs/:org/sandboxes/versions/sbv_1/invites";
  assert.equal((await w.json("member", "POST", path, {})).status, 403);
  assert.equal(
    (
      await w.json(
        "member",
        "GET",
        "/api/v1/orgs/:org/sandboxes/versions/sbv_1/contributors",
      )
    ).status,
    403,
  );
  assert.equal((await w.json("alan", "POST", path, {})).status, 404);
  assert.equal(
    (await w.json("owner", "POST", path, { maxClaims: 99 })).body["code"],
    "invalid_invite",
  );
  assert.equal((await w.json("owner", "POST", path, { label: 1 })).status, 400);
  const draft = await w.json(
    "owner",
    "POST",
    "/api/v1/orgs/:org/sandboxes/versions/sbv_2/invites",
    {},
  );
  assert.equal(draft.status, 409);
  assert.equal(draft.body["code"], "not_published");
  assert.equal(
    (
      await w.json(
        "owner",
        "POST",
        "/api/v1/orgs/:org/sandboxes/versions/sbv_x/invites",
        {},
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await w.json(
        "owner",
        "GET",
        "/api/v1/orgs/:org/sandboxes/versions/sbv_x/contributors",
      )
    ).status,
    404,
  );

  // A member works from the workspace; the invite is not spent.
  const { token } = await invited(w);
  const member = await w.json("member", "POST", "/api/v1/invites/claim", {
    token,
  });
  assert.equal(member.status, 409);
  assert.equal(member.body["code"], "already_member");
  assert.equal(w.contributors.invites.at(-1)?.claims, 0);

  // Unpublished after the invite: nothing claimed, nothing submitted.
  const claimed = await w.json("grace", "POST", "/api/v1/invites/claim", {
    token,
  });
  assert.equal(claimed.status, 201);
  w.sandbox.status = "draft";
  const closed = await w.json("grace", "POST", `${C}/submissions`, {
    files: partial,
  });
  assert.equal(closed.status, 409);
  assert.equal(closed.body["code"], "not_open");
  assert.equal(
    (await w.json("grace", "GET", C)).body["contribution"].open,
    false,
  );
  const late = await invited(w).catch(() => null);
  assert.equal(late, null, "an unpublished version takes no invite");
  w.sandbox.status = "published";
  const next = await invited(w, { maxClaims: 2 });
  w.sandbox.expiresAt = "2026-11-01T00:00:00.000Z";
  assert.equal(
    (
      await w.json("alan", "POST", "/api/v1/invites/claim", {
        token: next.token,
      })
    ).status,
    404,
  );
  assert.equal(
    (await w.json("grace", "POST", "/api/v1/invites/claim", {})).status,
    400,
  );
});

test("claims are rate limited per person", async () => {
  const w = world();
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS.limit; attempt += 1)
    assert.equal(
      (
        await w.json("alan", "POST", "/api/v1/invites/claim", {
          token: `${INVITE_TOKEN_PREFIX}guess${attempt}`,
        })
      ).status,
      404,
    );
  const limited = await w.json("alan", "POST", "/api/v1/invites/claim", {
    token: `${INVITE_TOKEN_PREFIX}guess`,
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.body["code"], "rate_limited");
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  // Another person is counted apart; the window passes.
  assert.equal(
    (
      await w.json("grace", "POST", "/api/v1/invites/claim", {
        token: `${INVITE_TOKEN_PREFIX}guess`,
      })
    ).status,
    404,
  );
  w.clock.at = new Date(w.clock.at.getTime() + CLAIM_ATTEMPTS.windowMs);
  assert.equal(
    (
      await w.json("alan", "POST", "/api/v1/invites/claim", {
        token: `${INVITE_TOKEN_PREFIX}guess`,
      })
    ).status,
    404,
  );
});

test("an errored submission of theirs is graded again without spending the retry", async () => {
  const w = world();
  const { token } = await invited(w);
  await w.json("grace", "POST", "/api/v1/invites/claim", { token });
  const first = await w.json("grace", "POST", `${C}/submissions`, {
    files: partial,
  });
  const sid = first.body["submission"].id as string;
  w.errored(sid);
  const regraded = await w.json(
    "grace",
    "POST",
    `${C}/submissions/${sid}/regrade`,
  );
  assert.equal(regraded.status, 200, regraded.text);
  assert.equal(regraded.body["submission"].status, "queued");
  // The deployment takes no submissions without storage.
  const unknown = await w.json(
    "grace",
    "POST",
    `${C}/submissions/sbm_x/regrade`,
  );
  assert.equal(unknown.status, 404);
  const invalid = await w.json("grace", "POST", `${C}/submissions`, {
    files: [],
  });
  assert.equal(invalid.status, 400);
});

test("a braked or over-quota grading attempt is a 429 with Retry-After, the submission kept for later", async () => {
  const w = world();
  const { token } = await invited(w);
  await w.json("grace", "POST", "/api/v1/invites/claim", { token });
  // A dry run never reaches the run store, so no brake counts it.
  const preview = await w.json("grace", "POST", `${C}/submissions?dryRun=1`, {
    files: partial,
  });
  assert.equal(preview.status, 200, preview.text);
  assert.equal(w.enqueued.length, 0);
  w.refusals.push({
    ok: false,
    reason: "rate_limited",
    scope: "assignment",
    limit: 10,
    retryAt: new Date(w.clock.at.getTime() + 3_600_000),
  });
  const braked = await w.json("grace", "POST", `${C}/submissions`, {
    files: partial,
  });
  assert.equal(braked.status, 429, braked.text);
  // Until the rolling day's oldest attempt leaves it, in whole seconds of
  // the app's clock, not the wall clock.
  assert.equal(braked.headers.get("retry-after"), "3600");
  assert.equal(braked.body["code"], "rate_limited");
  assert.equal(braked.body["scope"], "assignment");
  assert.equal(braked.body["retryable"], true);
  assert.match(braked.body["error"], /The submission is kept/);
  // The month's evaluator time spent: refused until the reset, by kind.
  w.refusals.push({
    ok: false,
    reason: "quota_exceeded",
    kind: "evaluator_seconds",
    used: 360_000,
    limit: 360_000,
    resetsAt: new Date("2026-12-01T00:00:00.000Z"),
  });
  const spent = await w.json("grace", "POST", `${C}/submissions`, {
    files: partial,
  });
  assert.equal(spent.status, 429, spent.text);
  assert.equal(spent.body["code"], "quota_exceeded");
  assert.equal(spent.body["kind"], "evaluator_seconds");
  // From 2026-11-15T00:00Z, the app's now, to the month's reset: 16 days.
  assert.equal(spent.headers.get("retry-after"), String(16 * 86_400));
  // Sent again once admitted, the same files queue the kept submission.
  const listed = await w.json("grace", "GET", `${C}/submissions`);
  assert.equal(listed.body["submissions"].length, 1);
  const queued = await w.json("grace", "POST", `${C}/submissions`, {
    files: partial,
  });
  assert.equal(queued.status, 202, queued.text);
  assert.equal(w.enqueued.length, 1);
});

test("a contributor token works the contributor routes as its person, and nothing of the workspace", async () => {
  const w = world();
  const { token } = await invited(w);
  const grace = await w.contributorBearer("grace");
  // Claimed with the token, as a CLI would after the link.
  const claimed = await w.json(grace, "POST", "/api/v1/invites/claim", {
    token,
  });
  assert.equal(claimed.status, 201, claimed.text);
  const listed = await w.json(grace, "GET", "/api/v1/contributions");
  assert.deepEqual(
    listed.body["contributions"].map(
      (entry: { versionId: string }) => entry.versionId,
    ),
    ["sbv_1"],
  );
  const page = await w.json(grace, "GET", `${C}/handout/files`);
  assert.equal(page.status, 200, page.text);
  assert.ok(
    page.body["files"].some(
      (file: { path: string }) => file.path === "src/fees.ts",
    ),
  );
  assert.equal((await w.request(grace, "GET", `${C}/archive`)).status, 200);
  const made = await w.json(grace, "POST", `${C}/submissions`, {
    files: partial,
  });
  assert.equal(made.status, 202, made.text);
  const sid = made.body["submission"].id as string;
  assert.equal(
    (await w.json(grace, "GET", `${C}/submissions/${sid}`)).status,
    200,
  );
  // Recorded in the workspace whose version it is, as the contributor.
  const entry = w.audited.find(
    (each) => each.route === "/api/v1/contributions/:vid/submissions",
  );
  assert.equal(entry?.organizationId, "org_1");
  assert.equal(entry?.via, "contributor");
  assert.equal(entry?.userId, "user_c");
  assert.equal(entry?.status, 202);
  // Nothing of the workspace, whatever the path names.
  for (const path of [
    "/api/v1/orgs/org_1",
    "/api/v1/orgs/org_1/sandboxes/versions/sbv_1/handout",
    `/api/v1/orgs/org_1/sandboxes/submissions/${sid}`,
    "/api/v1/me/orgs",
  ]) {
    const answered = await w.json(grace, "GET", path);
    assert.equal(answered.status, 403, path);
    assert.equal(answered.body["code"], "contributor_credential", path);
  }
  // Another person's token sees none of it.
  const alan = await w.contributorBearer("alan");
  assert.equal((await w.json(alan, "GET", C)).status, 404);
  assert.equal(
    (await w.json(alan, "GET", `${C}/submissions/${sid}`)).status,
    404,
  );
  // An owner's own contributor token reaches no workspace either.
  const owner = await w.contributorBearer("owner");
  assert.equal(
    (await w.json(owner, "GET", "/api/v1/orgs/org_1/sandboxes")).status,
    403,
  );
});

test("files[] previews what it would submit with ?dryRun=1, storing nothing", async () => {
  const w = world(PROJECT);
  const { token } = await invited(w);
  await w.json("grace", "POST", "/api/v1/invites/claim", { token });
  const preview = await w.json("grace", "POST", `${C}/submissions?dryRun=1`, {
    files: [
      ...solution,
      { path: ".vscode/settings.json", text: "{}" },
      { path: "package.json", text: "{}\n" },
      // Unchanged: not a change at all.
      { path: "tsconfig.json", text: "{}\n" },
    ],
  });
  assert.equal(preview.status, 200, preview.text);
  assert.deepEqual(preview.body["preview"].files, [
    { path: "src/fees.ts", change: "changed" },
  ]);
  assert.deepEqual(preview.body["preview"].ignored, [".vscode/settings.json"]);
  assert.deepEqual(preview.body["preview"].missing, []);
  assert.deepEqual(
    preview.body["preview"].refused.map((each: { path: string }) => each.path),
    ["package.json"],
  );
  assert.equal(w.submissions.rows.length, 0, "a dry run stores nothing");
  // A clean one previews clean, then submits as it said.
  const clean = await w.json("grace", "POST", `${C}/submissions?dryRun=1`, {
    files: solution,
  });
  assert.deepEqual(clean.body["preview"].refused, []);
  const made = await w.json("grace", "POST", `${C}/submissions`, {
    files: solution,
  });
  assert.equal(made.status, 202);
  const sid = made.body["submission"].id as string;
  w.submissions.settle(sid, {
    public: { passed: 1, total: 1 },
    hidden: { passed: 0, total: 1 },
    verdict: "overfit",
    failedScenarios: ["s1"],
    refused: [],
  });
  const retry = await w.json(
    "grace",
    "POST",
    `${C}/submissions/${sid}/retry?dryRun=1`,
    { files: partial },
  );
  assert.equal(retry.status, 200, retry.text);
  assert.equal(w.submissions.rows.length, 1);
});

test("files[] preview and submission drop the same build output beside its source", async () => {
  const w = world(PROJECT);
  const { token } = await invited(w);
  await w.json("grace", "POST", "/api/v1/invites/claim", { token });
  // What `npm run build` wrote beside the source, sent along with it.
  const sent = [
    ...solution,
    { path: "src/fees.js", text: "export const fee = () => 25;\n" },
    { path: "src/fees.js.map", text: "{}" },
    { path: ".lunox/contribution.json", text: "{}" },
  ];
  const preview = await w.json("grace", "POST", `${C}/submissions?dryRun=1`, {
    files: sent,
  });
  assert.equal(preview.status, 200, preview.text);
  assert.deepEqual(preview.body["preview"].files, [
    { path: "src/fees.ts", change: "changed" },
  ]);
  assert.equal(preview.body["preview"].skipped, 2);
  assert.deepEqual(preview.body["preview"].ignored, [
    ".lunox/contribution.json",
  ]);
  assert.deepEqual(preview.body["preview"].refused, []);
  const made = await w.json("grace", "POST", `${C}/submissions`, {
    files: sent,
  });
  assert.equal(made.status, 202, made.text);
  // Stored as the preview said, so grading never sees the `.js` to refuse.
  const row = w.submissions.rows[0];
  assert.equal(
    Buffer.from(
      w.objects.get(row?.patchKey ?? "") ?? new Uint8Array(),
    ).toString("utf8"),
    submittedFilesText(solution),
  );
  // Build output alone is no submission.
  const built = await w.json(
    "grace",
    "POST",
    `${C}/submissions/${made.body["submission"].id as string}/retry`,
    { files: [{ path: "src/fees.js.map", text: "{}" }] },
  );
  assert.equal(built.status, 400, built.text);
  assert.equal(built.body["code"], "no_task_files");
});

test("over MCP at /mcp/contribute, a contributor token lists, reads, previews and submits", async () => {
  const w = world();
  const { token } = await invited(w);
  await w.json("grace", "POST", "/api/v1/invites/claim", { token });
  const client = await w.mcp(
    "/mcp/contribute",
    await w.contributorBearer("grace"),
  );
  const text = (result: unknown) =>
    (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
  const listed = JSON.parse(
    text(await client.callTool({ name: "list_contributions", arguments: {} })),
  ) as { contributions: Array<{ versionId: string; editablePaths: string[] }> };
  assert.deepEqual(
    listed.contributions.map((each) => each.versionId),
    ["sbv_1"],
  );
  assert.deepEqual(listed.contributions[0]?.editablePaths, ["src/fees.ts"]);
  const files = JSON.parse(
    text(
      await client.callTool({
        name: "get_project_files",
        arguments: { versionId: "sbv_1" },
      }),
    ),
  ) as { files: Array<{ path: string }> };
  assert.ok(files.files.some((file) => file.path === "src/fees.ts"));
  assert.doesNotMatch(JSON.stringify(files), /fee-minimum/);
  const preview = await client.callTool({
    name: "preview_submission",
    arguments: { versionId: "sbv_1", files: solution },
  });
  assert.notEqual(preview.isError, true, text(preview));
  assert.equal(w.submissions.rows.length, 0);
  const submitted = await client.callTool({
    name: "submit",
    arguments: { versionId: "sbv_1", files: solution },
  });
  assert.notEqual(submitted.isError, true, text(submitted));
  const sid = (JSON.parse(text(submitted)) as { submission: { id: string } })
    .submission.id;
  const read = await client.callTool({
    name: "get_my_submission",
    arguments: { versionId: "sbv_1", submissionId: sid },
  });
  assert.match(text(read), /"status": "queued"/);
  // A second first submission names the first.
  const again = await client.callTool({
    name: "submit",
    arguments: { versionId: "sbv_1", files: partial },
  });
  assert.equal(again.isError, true);
  assert.match(text(again), /already_submitted/);
  await client.close();
  // A workspace token at this endpoint reaches none of it.
  const secret = generateSecret();
  await w.tokens.create("org_1", {
    createdBy: "user_1",
    name: "ci",
    prefix: secret.slice(0, 12),
    hash: hashSecret(secret),
    scopes: ["workspace:read", "submissions:write"],
    expiresAt: null,
  });
  const workspace = await w.mcp("/mcp/contribute", {
    authorization: `Bearer ${secret}`,
  });
  const refused = await workspace.callTool({
    name: "list_contributions",
    arguments: {},
  });
  assert.equal(refused.isError, true);
  assert.match(text(refused), /workspace_credential/);
  await workspace.close();
});

/** Submissions in memory, by the store's rules. */
/** Files under a project's built paths, as the zip tests build on. */
const PROJECT = {
  "project/package.json": '{"name":"fees","scripts":{"test":"node --test"}}\n',
  "project/package-lock.json": "{}\n",
  "project/tsconfig.json": "{}\n",
  "project/TASK.md": "# Task: Statement fees\n",
  "project/.vscode/settings.json": '{"files.exclude":{}}\n',
  "project/tests/public/fees.test.ts": "test('fee', () => {});\n",
};

/** A folder as an unzipper would get it: `files` under `root/`, zipped. */
async function zipped(
  files: Record<string, string | Uint8Array>,
  root = "sbx_1-v1/",
): Promise<Uint8Array> {
  const archive = await zip(
    Object.entries(files).map(([name, content]) => ({
      name: `${root}${name}`,
      bytes: typeof content === "string" ? Buffer.from(content) : content,
    })),
  );
  return Buffer.concat(archive.chunks);
}

/** The downloaded project, as the contributor's folder holds it. */
const downloaded = (): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries({ ...BUILT, ...PROJECT })
      .filter(([path]) => path.startsWith("project/"))
      .map(([path, text]) => [path.slice("project/".length), text]),
  ),
});

test("a zipped project folder: previewed, then submitted as its changed task files alone", async () => {
  const w = world(PROJECT);
  const { token } = await invited(w);
  await w.json("grace", "POST", "/api/v1/invites/claim", { token });
  const folder = await zipped({
    ...downloaded(),
    "src/fees.ts": solution[0]?.text ?? "",
    // What the editor, the build, npm and the OS leave in the folder.
    ".vscode/settings.json": '{"editor.formatOnSave":true}\n',
    "TASK.md": "# Task: Statement fees\n\nMy notes.\n",
    "src/fees.js": "export const fee = () => 25;\n",
    "src/fees.js.map": "{}",
    "tests/public/fees.test.js": "test();\n",
    "node_modules/typescript/package.json": '{"name":"typescript"}',
    "node_modules/.package-lock.json": "{}",
    ".git/HEAD": "ref: refs/heads/main\n",
    ".DS_Store": new Uint8Array([0, 1, 2, 255]),
  });

  const preview = await w.json(
    "grace",
    "POST",
    `${C}/submissions/zip?dryRun=1`,
    folder,
  );
  assert.equal(preview.status, 200, preview.text);
  assert.deepEqual(preview.body["preview"], {
    files: [{ path: "src/fees.ts", change: "changed" }],
    ignored: [".vscode/settings.json", "TASK.md"],
    skipped: 7,
    missing: [],
    refused: [],
  });
  assert.equal(w.submissions.rows.length, 0, "a dry run stores nothing");

  const made = await w.json("grace", "POST", `${C}/submissions/zip`, folder);
  assert.equal(made.status, 202, made.text);
  const submission = made.body["submission"];
  assert.equal(submission.status, "queued");
  const row = w.submissions.rows[0];
  assert.equal(row?.assignmentId !== null, true);
  // Stored exactly as the same files sent as `files[]` would be.
  const stored = w.objects.get(row?.patchKey ?? "");
  assert.equal(
    Buffer.from(stored ?? new Uint8Array()).toString("utf8"),
    submittedFilesText(solution),
  );
  const asJson = await w.json("grace", "POST", `${C}/submissions`, {
    files: [...solution, { path: ".vscode/settings.json", text: "{}" }],
  });
  assert.equal(asJson.status, 200, "the same submission, not a second");
  assert.equal(asJson.body["submission"].id, submission.id);

  // Its one retry, as a folder too, once it has a verdict.
  w.submissions.settle(submission.id, {
    public: { passed: 1, total: 1 },
    hidden: { passed: 0, total: 1 },
    verdict: "overfit",
    failedScenarios: ["s3"],
    refused: [],
  });
  const retried = await w.json(
    "grace",
    "POST",
    `${C}/submissions/${submission.id}/retry/zip`,
    await zipped({
      ...downloaded(),
      "src/fees.ts": "export const fee = () => 26;\n",
    }),
  );
  assert.equal(retried.status, 202, retried.text);
  assert.equal(retried.body["submission"].retryOf, submission.id);
});

test("a folder changing read-only files is refused by name before any submission", async () => {
  const w = world(PROJECT);
  const { token } = await invited(w);
  await w.json("grace", "POST", "/api/v1/invites/claim", { token });
  const folder = await zipped({
    ...downloaded(),
    "src/fees.ts": solution[0]?.text ?? "",
    "package.json": '{"name":"fees","scripts":{"test":"true"}}\n',
    "tests/public/fees.test.ts": "test.skip('fee', () => {});\n",
  });
  const refused = await w.json("grace", "POST", `${C}/submissions/zip`, folder);
  assert.equal(refused.status, 422, refused.text);
  assert.equal(refused.body["code"], "folder_refused");
  assert.match(
    refused.body["error"],
    /cannot be submitted as it is: package\.json, tests\/public\/fees\.test\.ts\. Revert/,
  );
  assert.deepEqual(
    refused.body["refused"].map((each: { path: string }) => each.path),
    ["package.json", "tests/public/fees.test.ts"],
  );
  assert.match(refused.body["refused"][0].reason, /Revert it/);
  // What it would submit once they are reverted.
  assert.deepEqual(refused.body["preview"].files, [
    { path: "src/fees.ts", change: "changed" },
  ]);
  assert.equal(w.submissions.rows.length, 0);
  // The dry run says the same, as a report.
  const preview = await w.json(
    "grace",
    "POST",
    `${C}/submissions/zip?dryRun=1`,
    folder,
  );
  assert.equal(preview.status, 200);
  assert.equal(preview.body["preview"].refused.length, 2);
});

test("a folder that deleted its task file, changed nothing, or is another folder is refused", async () => {
  const w = world(PROJECT);
  const { token } = await invited(w);
  await w.json("grace", "POST", "/api/v1/invites/claim", { token });
  const { "src/fees.ts": _deleted, ...withoutTask } = downloaded();
  const deleted = await w.json(
    "grace",
    "POST",
    `${C}/submissions/zip`,
    await zipped(withoutTask),
  );
  assert.equal(deleted.status, 422, deleted.text);
  assert.deepEqual(deleted.body["refused"], [
    {
      path: "src/fees.ts",
      reason:
        "Deleted. A submission cannot delete a file yet: restore it from the downloaded project.",
    },
  ]);
  // Zipped from inside the folder, unchanged: nothing to submit.
  const unchanged = await w.json(
    "grace",
    "POST",
    `${C}/submissions/zip`,
    await zipped(downloaded(), ""),
  );
  assert.equal(unchanged.status, 422);
  assert.equal(unchanged.body["code"], "no_changes");
  const other = await w.json(
    "grace",
    "POST",
    `${C}/submissions/zip`,
    await zipped({ "index.ts": "export {};\n" }, ""),
  );
  assert.equal(other.body["code"], "not_the_project");
  const wrong = await w.json(
    "grace",
    "POST",
    `${C}/submissions/zip`,
    await zipped({
      ...downloaded(),
      "sandbox-task.json": descriptor.replace('"sbv_1"', '"sbv_9"'),
    }),
  );
  assert.equal(wrong.status, 422);
  assert.equal(wrong.body["code"], "wrong_version");
  assert.equal(w.submissions.rows.length, 0);
});

test("unsafe, oversized and malformed uploads are refused before reading a file", async () => {
  const w = world(PROJECT);
  const { token } = await invited(w);
  await w.json("grace", "POST", "/api/v1/invites/claim", { token });
  for (const name of ["../evil.ts", "/etc/passwd", "src\\..\\x.ts"]) {
    const slip = await w.json(
      "grace",
      "POST",
      `${C}/submissions/zip`,
      await zipped({ ...downloaded(), [name]: "x" }, ""),
    );
    assert.equal(slip.status, 400, name);
    assert.equal(slip.body["code"], "unsafe_zip", name);
  }
  const big = await w.json(
    "grace",
    "POST",
    `${C}/submissions/zip`,
    new Uint8Array(SUBMISSION_ZIP_MAX_BYTES + 1),
  );
  assert.equal(big.status, 413);
  assert.equal(big.body["code"], "zip_too_large");
  const junk = await w.json(
    "grace",
    "POST",
    `${C}/submissions/zip`,
    new Uint8Array([1, 2, 3, 4]),
  );
  assert.equal(junk.status, 400);
  assert.equal(junk.body["code"], "invalid_zip");
  const asText = await w.request(
    { ...as("grace"), "content-type": "text/plain" },
    "POST",
    `${C}/submissions/zip`,
  );
  assert.equal(asText.status, 415);
  // Not theirs: as missing as any other version.
  assert.equal(
    (
      await w.json(
        "alan",
        "POST",
        `${C}/submissions/zip`,
        await zipped(downloaded()),
      )
    ).status,
    404,
  );
  assert.equal(w.submissions.rows.length, 0);
});

test("owners submit a zipped folder too; files[] drops guide and editor files", async () => {
  const w = world(PROJECT);
  const made = await w.json(
    "owner",
    "POST",
    "/api/v1/orgs/:org/sandboxes/versions/sbv_1/submissions/zip",
    await zipped({ ...downloaded(), "src/fees.ts": solution[0]?.text ?? "" }),
  );
  assert.equal(made.status, 202, made.text);
  // A member cannot.
  assert.equal(
    (
      await w.json(
        "member",
        "POST",
        "/api/v1/orgs/:org/sandboxes/versions/sbv_1/submissions/zip",
        await zipped(downloaded()),
      )
    ).status,
    403,
  );
  // `files[]` with a changed editor file: the task file alone is stored.
  const json = await w.json(
    "owner",
    "POST",
    "/api/v1/orgs/:org/sandboxes/versions/sbv_1/submissions",
    {
      files: [
        ...partial,
        { path: ".vscode/settings.json", text: "{}" },
        { path: "TASK.md", text: "notes" },
      ],
    },
  );
  assert.equal(json.status, 202, json.text);
  const row = w.submissions.rows[0];
  assert.equal(
    Buffer.from(
      w.objects.get(row?.patchKey ?? "") ?? new Uint8Array(),
    ).toString("utf8"),
    submittedFilesText(partial),
  );
  const guideOnly = await w.json(
    "owner",
    "POST",
    "/api/v1/orgs/:org/sandboxes/versions/sbv_1/submissions",
    { files: [{ path: ".vscode/settings.json", text: "{}" }] },
  );
  assert.equal(guideOnly.status, 400);
  assert.equal(guideOnly.body["code"], "no_task_files");
});

function memorySubmissions(now: () => Date) {
  const rows: (StoredSubmission & {
    patchKey: string;
    organizationId: string;
  })[] = [];
  const stamp = () => now().toISOString();
  const find = (owner: string, id: string) =>
    rows.find((row) => row.organizationId === owner && row.id === id);
  const strip = ({
    patchKey: _key,
    organizationId: _owner,
    ...row
  }: (typeof rows)[number]): StoredSubmission => row;
  const insert = (
    owner: string,
    input: NewSubmission,
    retryOf: string | null,
  ) => {
    const row = {
      id: `sbm_${rows.length + 1}`,
      organizationId: owner,
      sandboxVersionId: input.sandboxVersionId,
      submittedBy: input.submittedBy,
      patchKey: input.patchKey,
      patchSha256: input.patchSha256,
      status: "queued" as const,
      result: null,
      errorCode: null,
      runId: null,
      retryOf,
      assignmentId: input.assignmentId ?? null,
      createdAt: stamp(),
      updatedAt: stamp(),
    };
    rows.unshift(row);
    return row;
  };
  const replace = (id: string, patch: Partial<(typeof rows)[number]>) => {
    const index = rows.findIndex((row) => row.id === id);
    const row = rows[index];
    if (row !== undefined) rows[index] = { ...row, ...patch };
  };
  return {
    rows,
    async create(owner: string, input: NewSubmission) {
      if (owner !== "org_1" || input.sandboxVersionId !== "sbv_1")
        return { ok: false as const, reason: "not-found" as const };
      const found = rows.find(
        (row) =>
          row.sandboxVersionId === input.sandboxVersionId &&
          row.patchSha256 === input.patchSha256 &&
          row.submittedBy === input.submittedBy,
      );
      if (found !== undefined)
        return { ok: true as const, submission: strip(found), created: false };
      const first = rows.find(
        (row) =>
          input.assignmentId != null &&
          row.assignmentId === input.assignmentId &&
          row.retryOf === null,
      );
      if (first !== undefined)
        return {
          ok: false as const,
          reason: "already_submitted" as const,
          submissionId: first.id,
        };
      return {
        ok: true as const,
        submission: strip(insert(owner, input, null)),
        created: true,
      };
    },
    async get(owner: string, id: string) {
      const row = find(owner, id);
      return row === undefined
        ? null
        : { ...strip(row), patchKey: row.patchKey };
    },
    async list(
      owner: string,
      versionId: string,
      filter: { submittedBy?: string } = {},
    ) {
      return rows
        .filter(
          (row) =>
            row.organizationId === owner &&
            row.sandboxVersionId === versionId &&
            (filter.submittedBy === undefined ||
              row.submittedBy === filter.submittedBy),
        )
        .map(strip);
    },
    async retry(
      owner: string,
      id: string,
      input: Omit<NewSubmission, "sandboxVersionId">,
    ) {
      const original = find(owner, id);
      if (original === undefined)
        return { ok: false as const, reason: "not-found" as const };
      if (
        original.status === "errored" &&
        original.patchSha256 === input.patchSha256
      )
        return {
          ok: true as const,
          submission: strip(original),
          created: false,
          regrade: true as const,
        };
      if (
        original.assignmentId !== null &&
        original.submittedBy !== input.submittedBy
      )
        return {
          ok: false as const,
          reason: "contributor_submission" as const,
        };
      if (original.retryOf !== null)
        return { ok: false as const, reason: "is_retry" as const };
      if (original.status === "passed")
        return { ok: false as const, reason: "passed" as const };
      if (original.status === "queued" || original.status === "running")
        return { ok: false as const, reason: "not_finished" as const };
      const made = rows.find((row) => row.retryOf === id);
      if (made !== undefined)
        return made.patchSha256 === input.patchSha256
          ? { ok: true as const, submission: strip(made), created: false }
          : { ok: false as const, reason: "retry_used" as const };
      return {
        ok: true as const,
        submission: strip(
          insert(
            owner,
            { ...input, sandboxVersionId: original.sandboxVersionId },
            id,
          ),
        ),
        created: true,
      };
    },
    /** What the run store does as its runs move. */
    ran(id: string, runId: string) {
      replace(id, { runId });
    },
    reopen(id: string) {
      replace(id, { status: "queued", errorCode: null });
    },
    settle(id: string, result: SubmissionResult) {
      replace(id, {
        status: result.verdict === "passed" ? "passed" : "failed",
        result,
        updatedAt: stamp(),
      });
    },
    error(id: string) {
      replace(id, { status: "errored", errorCode: "grading_failed" });
    },
  };
}

/** Invites and assignments in memory, by the store's rules. */
function memoryContributors(): ContributorStore & {
  invites: StoredContributorInvite[];
  assignments: StoredContributorAssignment[];
} {
  const invites: StoredContributorInvite[] = [];
  const assignments: StoredContributorAssignment[] = [];
  const users: Record<string, { id: string; name: string; email: string }> =
    Object.fromEntries(
      Object.values(PEOPLE).map((person) => [person.id, { ...person }]),
    );
  const live = (versionId: string, userId: string) =>
    assignments.find(
      (row) =>
        row.sandboxVersionId === versionId &&
        row.user.id === userId &&
        row.revokedAt === null,
    );
  return {
    invites,
    assignments,
    async createInvite(owner, input) {
      if (
        owner !== "org_1" ||
        !["sbv_1", "sbv_2"].includes(input.sandboxVersionId)
      )
        return null;
      const invite: StoredContributorInvite = {
        id: `cin_${invites.length + 1}`,
        organizationId: owner,
        sandboxVersionId: input.sandboxVersionId,
        createdBy: { id: input.createdBy, name: "Ada Lovelace" },
        emailHint: input.emailHint,
        label: input.label,
        tokenSha256: input.tokenSha256,
        expiresAt: input.expiresAt,
        maxClaims: input.maxClaims,
        claims: 0,
        revokedAt: null,
        claimedBy: null,
        claimedAt: null,
        createdAt: new Date(invites.length),
      };
      invites.unshift(invite);
      return invite;
    },
    async listInvites(owner, versionId) {
      return invites.filter(
        (row) =>
          row.organizationId === owner && row.sandboxVersionId === versionId,
      );
    },
    async revokeInvite(owner, id, at) {
      const index = invites.findIndex(
        (row) => row.organizationId === owner && row.id === id,
      );
      const row = invites[index];
      if (row === undefined) return null;
      invites[index] = { ...row, revokedAt: row.revokedAt ?? at };
      return invites[index] ?? null;
    },
    async listAssignments(owner, versionId) {
      return assignments.filter(
        (row) =>
          row.organizationId === owner && row.sandboxVersionId === versionId,
      );
    },
    async revokeAssignment(owner, id, at) {
      const index = assignments.findIndex(
        (row) => row.organizationId === owner && row.id === id,
      );
      const row = assignments[index];
      if (row === undefined) return null;
      assignments[index] = { ...row, revokedAt: row.revokedAt ?? at };
      return assignments[index] ?? null;
    },
    async findInvite(hash) {
      return invites.find((row) => row.tokenSha256 === hash) ?? null;
    },
    async claim(owner, inviteId, userId, at) {
      const index = invites.findIndex(
        (row) => row.organizationId === owner && row.id === inviteId,
      );
      const invite = invites[index];
      if (invite === undefined) return { ok: false, reason: "unavailable" };
      const held = live(invite.sandboxVersionId, userId);
      if (held !== undefined)
        return { ok: true, assignment: held, created: false };
      if (
        invite.revokedAt !== null ||
        invite.expiresAt.getTime() <= at.getTime() ||
        invite.claims >= invite.maxClaims
      )
        return { ok: false, reason: "unavailable" };
      const user = users[userId];
      if (user === undefined) return { ok: false, reason: "unavailable" };
      const assignment: StoredContributorAssignment = {
        id: `cas_${assignments.length + 1}`,
        organizationId: owner,
        sandboxVersionId: invite.sandboxVersionId,
        user,
        inviteId,
        createdAt: at,
        revokedAt: null,
      };
      assignments.unshift(assignment);
      invites[index] = {
        ...invite,
        claims: invite.claims + 1,
        claimedBy: invite.claimedBy ?? userId,
        claimedAt: invite.claimedAt ?? at,
      };
      return { ok: true, assignment, created: true };
    },
    async assignmentFor(userId, versionId) {
      return live(versionId, userId) ?? null;
    },
    async assignmentsOf(userId) {
      return assignments.filter(
        (row) => row.user.id === userId && row.revokedAt === null,
      );
    },
  };
}
