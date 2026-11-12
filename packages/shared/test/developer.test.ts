import assert from "node:assert/strict";
import { test } from "node:test";

import {
  apiTokenDtoSchema,
  createApiTokenSchema,
  createCliTokenSchema,
  createdApiTokenResponseSchema,
  oauthGrantListSchema,
  organizationResponseSchema,
  usageQuerySchema,
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
