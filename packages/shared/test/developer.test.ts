import assert from "node:assert/strict";
import { test } from "node:test";

import {
  apiTokenDtoSchema,
  contributorTokenDtoSchema,
  CONTRIBUTOR_TOKEN_DEFAULT_DAYS,
  createApiTokenSchema,
  createContributorTokenSchema,
  createdContributorTokenResponseSchema,
  createCliTokenSchema,
  createdApiTokenResponseSchema,
  oauthGrantListSchema,
  organizationResponseSchema,
  usageQuerySchema,
  usageResponseSchema,
} from "../src/index.js";

const token = {
  id: "tok_1",
  name: "CI",
  prefix: "lnx_abcd1234",
  scopes: ["workspace:read"],
  createdBy: { id: "user_1", name: "Ada Lovelace" },
  createdAt: "2026-11-12T00:00:00.000Z",
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
};

test("a token is created with a name and known scopes, each once", () => {
  assert.deepEqual(
    createApiTokenSchema.parse({ name: " CI ", scopes: ["judge"] }),
    { name: "CI", scopes: ["judge"] },
  );
  for (const body of [
    { name: "", scopes: ["judge"] },
    { name: "CI", scopes: [] },
    { name: "CI", scopes: ["tokens:write"] },
    { name: "CI", scopes: ["judge", "judge"] },
    { name: "CI", scopes: ["judge"], expiresInDays: 0 },
  ])
    assert.equal(createApiTokenSchema.safeParse(body).success, false);
});

test("a listed token never carries a secret; the created one carries it once", () => {
  assert.equal(
    "secret" in apiTokenDtoSchema.parse({ ...token, secret: "x" }),
    false,
  );
  assert.equal(
    createdApiTokenResponseSchema.safeParse({ token, secret: "sk_live" })
      .success,
    false,
  );
  assert.equal(
    createdApiTokenResponseSchema.safeParse({ token, secret: "lnx_abc" })
      .success,
    true,
  );
});

test("a CLI token names a known client", () => {
  assert.deepEqual(createCliTokenSchema.parse({ client: "carveout" }), {
    client: "carveout",
  });
  assert.equal(
    createCliTokenSchema.safeParse({ client: "vscode" }).success,
    false,
  );
});

test("usage reads thirty days unless asked, at most ninety", () => {
  assert.deepEqual(usageQuerySchema.parse({}), { days: 30 });
  assert.deepEqual(usageQuerySchema.parse({ days: "7" }), { days: 7 });
  assert.equal(usageQuerySchema.safeParse({ days: "91" }).success, false);
});

test("usage carries the month's evaluator seconds and counts beside its model tokens", () => {
  const month = {
    from: "2026-11-01T00:00:00.000Z",
    resetsAt: "2026-12-01T00:00:00.000Z",
  };
  const usage = {
    window: { from: month.from, to: month.resetsAt, days: 30 },
    runs: [],
    modelTokens: {
      ...month,
      used: 0,
      limit: 1,
      remaining: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    evaluatorSeconds: {
      ...month,
      used: 75,
      limit: 360_000,
      remaining: 359_925,
      jobs: 3,
      byKind: [{ kind: "submission_grade", seconds: 75, jobs: 3 }],
    },
    thisMonth: {
      gradingAttempts: 2,
      contributorGradingAttempts: 1,
      uploads: 0,
    },
  };
  assert.deepEqual(usageResponseSchema.parse(usage), usage);
  assert.equal(
    usageResponseSchema.safeParse({
      ...usage,
      evaluatorSeconds: { ...usage.evaluatorSeconds, used: -1 },
    }).success,
    false,
  );
  const { thisMonth: _, ...older } = usage;
  assert.equal(usageResponseSchema.safeParse(older).success, false);
});

test("an organization read carries the caller's role", () => {
  const parsed = organizationResponseSchema.parse({
    organization: { id: "org_1", name: "Acme", slug: "acme" },
    role: "admin",
  });
  assert.equal(parsed.organization.kind, "team");
  assert.equal(parsed.role, "admin");
});

test("a granted app lists its client, the person and the scopes, never a token", () => {
  const grant = {
    id: "consent_1",
    client: { id: "client_1", name: null },
    user: { id: "user_1", name: "Ada Lovelace" },
    scopes: ["workspace:read", "offline_access"],
    createdAt: "2026-11-12T00:00:00.000Z",
    updatedAt: "2026-11-12T00:00:00.000Z",
    lastUsedAt: null,
  };
  const parsed = oauthGrantListSchema.parse({
    grants: [{ ...grant, accessToken: "lnxat_secret" }],
  });
  assert.deepEqual(parsed.grants, [grant]);
});

test("a contributor token is named, lasts 90 days unless said, and is never a workspace token", () => {
  assert.deepEqual(createContributorTokenSchema.parse({ name: " Cursor " }), {
    name: "Cursor",
    expiresInDays: CONTRIBUTOR_TOKEN_DEFAULT_DAYS,
  });
  assert.equal(
    createContributorTokenSchema.parse({ name: "CLI", expiresInDays: null })
      .expiresInDays,
    null,
  );
  for (const bad of [{ name: "" }, { name: "x", expiresInDays: 0 }])
    assert.equal(createContributorTokenSchema.safeParse(bad).success, false);
  const listed = {
    id: "ctk_1",
    name: "Cursor",
    prefix: "lnxc_abcd1234",
    createdAt: "2026-11-15T00:00:00.000Z",
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
  };
  assert.deepEqual(contributorTokenDtoSchema.parse(listed), listed);
  // A workspace token's prefix is not a contributor token's.
  assert.equal(
    contributorTokenDtoSchema.safeParse({ ...listed, prefix: "lnx_abcd1234" })
      .success,
    false,
  );
  assert.equal(
    createdContributorTokenResponseSchema.safeParse({
      token: listed,
      secret: "lnx_abc",
    }).success,
    false,
  );
});
