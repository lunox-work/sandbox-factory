import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { test } from "node:test";

import { Hono } from "hono";

import {
  createGithubOidcVerifier,
  GITHUB_OIDC_ISSUER,
  type GithubOidcVerifier,
} from "../src/judge/oidc.js";
import { mountJudgeRoutes } from "../src/judge/routes.js";

const NOW = Date.parse("2026-11-12T00:00:00.000Z");
const AUDIENCE = "https://platform.lunox.work";
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });

const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
function jwt(
  claims: Record<string, unknown>,
  { kid = "k1", key = privateKey, alg = "RS256" } = {} as {
    kid?: string;
    key?: KeyObject;
    alg?: string;
  },
) {
  const head = b64({ alg, kid, typ: "JWT" });
  const body = b64(claims);
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${head}.${body}`),
    key,
  ).toString("base64url");
  return `${head}.${body}.${signature}`;
}
const claims = (overrides: Record<string, unknown> = {}) => ({
  iss: GITHUB_OIDC_ISSUER,
  aud: AUDIENCE,
  exp: NOW / 1000 + 300,
  nbf: NOW / 1000 - 10,
  repository_id: "42",
  repository: "acme/shop",
  sha: "c0ffee",
  ref: "refs/pull/7/merge",
  ...overrides,
});

function keysFetch(status = 200) {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(
      JSON.stringify({
        keys: [
          { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" },
          { kty: "EC", kid: "ec", crv: "P-256", x: "x", y: "y" },
        ],
      }),
      { status },
    );
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

test("a GitHub OIDC token is accepted when GitHub signed it for this platform and it is live", async () => {
  const keys = keysFetch();
  const verifier = createGithubOidcVerifier({
    audience: AUDIENCE,
    fetch: keys.fetch,
    now: () => NOW,
  });
  assert.deepEqual(await verifier.verify(jwt(claims())), {
    ok: true,
    claims: {
      repositoryId: "42",
      repository: "acme/shop",
      sha: "c0ffee",
      ref: "refs/pull/7/merge",
    },
  });
  // An audience list naming this platform, too; the keys are read once.
  assert.equal(
    (await verifier.verify(jwt(claims({ aud: ["other", AUDIENCE] })))).ok,
    true,
  );
  assert.deepEqual(keys.calls, [`${GITHUB_OIDC_ISSUER}/.well-known/jwks`]);

  const reason = async (token: string) => {
    const result = await verifier.verify(token);
    return result.ok ? "ok" : result.reason;
  };
  assert.equal(await reason("not.a"), "malformed");
  assert.equal(await reason("a.b.c"), "malformed");
  assert.equal(await reason(jwt(claims(), { alg: "HS256" })), "malformed");
  assert.equal(
    await reason(jwt(claims(), { key: other.privateKey })),
    "bad_signature",
  );
  assert.equal(
    await reason(jwt(claims({ iss: "https://evil.test" }))),
    "wrong_issuer",
  );
  assert.equal(
    await reason(jwt(claims({ aud: "https://other.test" }))),
    "wrong_audience",
  );
  assert.equal(await reason(jwt(claims({ exp: NOW / 1000 - 120 }))), "expired");
  assert.equal(await reason(jwt(claims({ exp: "soon" }))), "expired");
  assert.equal(await reason(jwt(claims({ nbf: NOW / 1000 + 120 }))), "expired");
  assert.equal(await reason(jwt(claims({ repository_id: 42 }))), "malformed");
  // A key GitHub does not publish, after reading the keys again.
  assert.equal(await reason(jwt(claims(), { kid: "k9" })), "unknown_key");
  assert.equal(keys.calls.length, 2);

  const down = createGithubOidcVerifier({
    audience: AUDIENCE,
    fetch: keysFetch(503).fetch,
    now: () => NOW,
  });
  const result = await down.verify(jwt(claims()));
  assert.deepEqual(result, { ok: false, reason: "keys_unavailable" });
  // The default fetch and clock are the process's own.
  assert.ok(createGithubOidcVerifier({ audience: AUDIENCE }));
});

const stamp = "2026-11-12T00:00:00.000Z";
/** A verifier that takes `token:<repository id>` as a token for that repository. */
const fakeVerifier: GithubOidcVerifier = {
  verify: async (token) =>
    token.startsWith("token:")
      ? {
          ok: true,
          claims: {
            repositoryId: token.slice(6),
            repository: "acme/shop",
            sha: "c0ffee",
            ref: "refs/heads/main",
          },
        }
      : { ok: false, reason: "bad_signature" },
};

function judgeFixture(
  overrides: { frozen?: boolean; unhealthy?: boolean; limit?: boolean } = {},
) {
  const enqueued: unknown[] = [];
  const stored: Record<string, Buffer> = {};
  let made = false;
  const submission = (status = "queued") => ({
    id: "sbm_1",
    sandboxVersionId: "sbv_1",
    submittedBy: null,
    patchSha256: "a".repeat(64),
    status,
    result:
      status === "passed"
        ? {
            public: { passed: 1, total: 1 },
            hidden: { passed: 2, total: 2 },
            verdict: "passed",
            failedScenarios: [],
          }
        : null,
    runId: "arn_grade",
    retryOf: null,
    createdAt: stamp,
    updatedAt: stamp,
  });
  const created: unknown[] = [];
  const app = new Hono();
  mountJudgeRoutes(app, {
    verifier: fakeVerifier,
    sandboxes: {
      getVersion: async (owner: string, id: string) =>
        owner === "org_1" && id === "sbv_1"
          ? ({
              version: {
                id,
                sandboxId: "sbx_1",
                frozenAt: overrides.frozen === false ? null : stamp,
              },
              source: { sourceSnapshotId: "rsn_1" },
            } as never)
          : null,
      get: async (owner: string, id: string) =>
        owner === "org_1" && id === "sbx_1"
          ? ({ id, sourceRepoId: "ghr_1" } as never)
          : null,
    },
    repos: {
      get: async (owner: string, id: string) =>
        owner === "org_1" && id === "ghr_1"
          ? ({
              id,
              externalId: "42",
              connectionId: "ghc_1",
              syncStatus: "ok",
            } as never)
          : null,
    },
    installationHealthy: async () => overrides.unhealthy !== true,
    submissions: {
      create: async (owner: string, input: unknown) => {
        created.push({ owner, ...(input as object) });
        const first = !made;
        made = true;
        return { ok: true, created: first, submission: submission() } as never;
      },
      get: async (owner: string, id: string) =>
        owner === "org_1" && id === "sbm_1"
          ? (submission("passed") as never)
          : null,
    },
    objects: {
      put: async (key: string, body: Uint8Array) => {
        stored[key] = Buffer.from(body);
      },
    },
    runs: {
      enqueue: async (
        owner: string,
        snapshotId: string | null,
        input: unknown,
      ) => {
        enqueued.push({ owner, snapshotId, ...(input as object) });
        return overrides.limit === true
          ? ({ ok: false, reason: "limit" } as never)
          : ({ ok: true } as never);
      },
    },
    ensureWorker: async () => {},
  });
  const call = (
    method: string,
    path: string,
    token: string | undefined,
    body?: unknown,
  ) =>
    app.request(path, {
      method,
      headers: {
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { call, enqueued, created, stored };
}

const files = [{ path: "src/a.ts", text: "export const a = 1;\n" }];
const ask = { workspace: "org_1", versionId: "sbv_1", files };

test("the CI judge takes a pull request's files from the repository the version was sliced from, and grades them in its names", async () => {
  const f = judgeFixture();
  const first = await f.call("POST", "/api/judge", "token:42", ask);
  assert.equal(first.status, 202);
  const body = (await first.json()) as {
    submission: { id: string; runId: unknown };
  };
  assert.equal(body.submission.id, "sbm_1");
  // Nothing of the run is told: the verdict is read from the submission.
  assert.equal(body.submission.runId, null);
  assert.equal((f.created[0] as { submittedBy: unknown }).submittedBy, null);
  assert.deepEqual(
    (f.enqueued[0] as { snapshotId: string; params: unknown }).params,
    {
      deadlineMinutes: 60,
      grader: "submission",
      submissionId: "sbm_1",
      sandboxVersionId: "sbv_1",
      patchSha256: (f.created[0] as { patchSha256: string }).patchSha256,
      names: "repository",
    },
  );
  assert.equal((f.enqueued[0] as { snapshotId: string }).snapshotId, "rsn_1");
  assert.equal(Object.keys(f.stored).length, 1);
  // The same files again: the submission already made, and no second run.
  const again = await f.call("POST", "/api/judge", "token:42", ask);
  assert.equal(again.status, 200);
  assert.equal(f.enqueued.length, 1);

  const read = await f.call(
    "GET",
    "/api/judge/sbm_1?workspace=org_1",
    "token:42",
  );
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("cache-control"), "no-store");
  const verdict = (await read.json()) as {
    submission: { verdict: string; hidden: unknown };
  };
  assert.equal(verdict.submission.verdict, "passed");
  assert.deepEqual(verdict.submission.hidden, { passed: 2, total: 2 });
});

test("the CI judge refuses without a token, a bad one, another repository's, a draft, an unhealthy installation and a full queue", async () => {
  const status = async (
    token: string | undefined,
    body: unknown = ask,
    overrides = {},
  ) => {
    const response = await judgeFixture(overrides).call(
      "POST",
      "/api/judge",
      token,
      body,
    );
    const json = (await response.json()) as { code?: string };
    return [response.status, json.code];
  };
  assert.deepEqual(await status(undefined), [401, "oidc_required"]);
  assert.deepEqual(await status("forged"), [401, "oidc_bad_signature"]);
  // Another repository's run reads the version as not found.
  assert.deepEqual(await status("token:99"), [404, "not_found"]);
  assert.deepEqual(await status("token:42", { ...ask, workspace: "org_2" }), [
    404,
    "not_found",
  ]);
  assert.deepEqual(await status("token:42", { ...ask, versionId: "sbv_x" }), [
    404,
    "not_found",
  ]);
  assert.deepEqual(await status("token:42", ask, { frozen: false }), [
    404,
    "not_found",
  ]);
  assert.deepEqual(await status("token:42", ask, { unhealthy: true }), [
    404,
    "not_found",
  ]);
  assert.deepEqual(await status("token:42", { ...ask, files: [] }), [
    400,
    "invalid_submission",
  ]);
  assert.deepEqual(await status("token:42", ask, { limit: true }), [
    409,
    "run_limit",
  ]);

  const f = judgeFixture();
  assert.equal(
    (await f.call("GET", "/api/judge/sbm_1?workspace=org_1", "token:99"))
      .status,
    404,
  );
  assert.equal(
    (await f.call("GET", "/api/judge/sbm_x?workspace=org_1", "token:42"))
      .status,
    404,
  );
  assert.equal(
    (await f.call("GET", "/api/judge/sbm_1", "token:42")).status,
    404,
  );
  assert.equal(
    (await f.call("GET", "/api/judge/sbm_1?workspace=org_1", undefined)).status,
    401,
  );
});
