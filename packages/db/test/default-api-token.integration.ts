/**
 * A person's default API token against Postgres, since what keeps it one per
 * person per workspace is the partial unique index and the check, not the
 * store's code.
 *
 * Outside the ordinary test glob, as the bounty concurrency checks are: it
 * creates and drops a database. Run it with
 * `npm run test:bounty-concurrency -w @sandbox-factory/db`.
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import postgres from "postgres";

import { createTokenCipher } from "../src/cipher.js";
import { createApiTokenStore, createConnection } from "../src/index.js";
import { runMigrations } from "../src/migrate.js";

const ADMIN_URL =
  process.env["DATABASE_URL"] ??
  "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const SCRATCH_DB = "sandbox_factory_default_token_test";

function scratchUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
}

const cipher = createTokenCipher(Buffer.alloc(32, 3).toString("base64"));

const input = (secret: string) => ({
  createdBy: "user_default",
  name: "Default",
  prefix: secret.slice(0, 12),
  hash: secret.padEnd(64, "0").slice(0, 64),
  scopes: ["workspace:read"] as const,
  expiresAt: null,
  secret,
});

describe("default API tokens", () => {
  let sql: postgres.Sql;
  let connection: ReturnType<typeof createConnection>;

  before(async () => {
    const admin = postgres(ADMIN_URL, { max: 1 });
    try {
      await admin.unsafe(`drop database if exists ${SCRATCH_DB}`);
      await admin.unsafe(`create database ${SCRATCH_DB}`);
    } finally {
      await admin.end();
    }
    await runMigrations({ url: scratchUrl(), migrationsFolder: "drizzle" });
    sql = postgres(scratchUrl(), { max: 1 });
    await sql`
      insert into "user" (id, name, email, username, display_username)
      values ('user_default', 'Ada', 'ada@example.test', 'ada', 'ada')
    `;
    await sql`
      insert into organization (id, name, slug)
      values ('org_default', 'Default Org', 'default-org')
    `;
    connection = createConnection({ url: scratchUrl(), max: 2 });
  });

  after(async () => {
    await connection.close();
    await sql.end();
    const admin = postgres(ADMIN_URL, { max: 1 });
    try {
      await admin.unsafe(`drop database if exists ${SCRATCH_DB}`);
    } finally {
      await admin.end();
    }
  });

  test("one live default per person, sealed, and remade after a revoke", async () => {
    const tokens = createApiTokenStore(connection.db, cipher);
    const first = `lnx_${"a".repeat(40)}`;
    const made = await tokens.createDefault("org_default", input(first));
    assert.ok(made !== undefined);

    // Two first visits at once: the index lets one in.
    const raced = await tokens.createDefault(
      "org_default",
      input(`lnx_${"b".repeat(40)}`),
    );
    assert.equal(raced, undefined);

    const found = await tokens.findDefault("org_default", "user_default");
    assert.equal(found?.token.id, made.id);
    assert.equal(found?.secret, first);
    const [row] = await sql<{ secret_enc: string }[]>`
      select secret_enc from api_token where id = ${made.id}
    `;
    assert.equal(row?.secret_enc.includes(first), false);

    await tokens.revoke("org_default", made.id);
    assert.equal(
      await tokens.findDefault("org_default", "user_default"),
      undefined,
    );
    const second = `lnx_${"c".repeat(40)}`;
    const remade = await tokens.createDefault("org_default", input(second));
    assert.ok(remade !== undefined);
    assert.equal(
      (await tokens.findDefault("org_default", "user_default"))?.secret,
      second,
    );
  });

  test("only a default token may keep its secret", async () => {
    await assert.rejects(
      sql`
        insert into api_token (id, organization_id, created_by, name, prefix, hash, scopes, secret_enc)
        values ('tok_bad', 'org_default', 'user_default', 'CI', 'lnx_x', ${"f".repeat(64)}, '[]'::jsonb, 'v1:x')
      `,
      /api_token_default_secret_check/,
    );
  });
});
