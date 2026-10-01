import assert from "node:assert/strict";
import { test } from "node:test";

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

import { user } from "../src/schema/auth.js";
import {
  githubConnection,
  githubGrant,
  githubRepo,
} from "../src/schema/github.js";
import { organization } from "../src/schema/organizations.js";

/**
 * The GitHub tables' invariants that only the schema states: who owns each
 * row, what cascades with it, and the uniqueness that turns a second
 * organization's link into `claimed` rather than a second token-minting row.
 */

function foreignKeys(table: PgTable) {
  return getTableConfig(table).foreignKeys.map((key) => ({
    table: key.reference().foreignTable,
    columns: key.reference().columns.map((column) => column.name),
    onDelete: key.onDelete,
  }));
}

test("every GitHub table is owned by an organization and goes with it", () => {
  for (const table of [githubConnection, githubGrant, githubRepo]) {
    const config = getTableConfig(table);
    const owner = config.columns.find(
      (column) => column.name === "organization_id",
    );
    assert.equal(owner?.notNull, true, `${config.name} owner is nullable`);
    assert.ok(
      foreignKeys(table).some(
        (key) => key.table === organization && key.onDelete === "cascade",
      ),
      `${config.name} does not cascade from organization`,
    );
  }
});

test("an installation is linked to one organization at most", () => {
  const installation = getTableConfig(githubConnection).columns.find(
    (column) => column.name === "installation_id",
  );

  assert.equal(installation?.isUnique, true);
  assert.equal(installation?.notNull, true);
});

test("a person holds one grant per organization, which goes with them", () => {
  const config = getTableConfig(githubGrant);

  assert.ok(
    config.uniqueConstraints.some(
      (constraint) => constraint.name === "github_grant_org_user_unique",
    ),
  );
  assert.ok(
    foreignKeys(githubGrant).some(
      (key) => key.table === user && key.onDelete === "cascade",
    ),
  );
});

test("grant tokens are stored only as ciphertext columns", () => {
  const columns = getTableConfig(githubGrant).columns.map(
    (column) => column.name,
  );

  assert.ok(columns.includes("access_token_enc"));
  assert.ok(columns.includes("refresh_token_enc"));
  assert.ok(!columns.some((name) => /token$/.test(name)));
});

test("a repository is registered once per connection and goes with it", () => {
  const config = getTableConfig(githubRepo);

  assert.ok(
    config.uniqueConstraints.some(
      (constraint) =>
        constraint.name === "github_repo_connection_external_unique",
    ),
  );
  // The connection and its owner together, so a row cannot name one
  // organization's connection under another organization's id.
  assert.ok(
    foreignKeys(githubRepo).some(
      (key) =>
        key.table === githubConnection &&
        key.onDelete === "cascade" &&
        key.columns.join(",") === "connection_id,organization_id",
    ),
  );
  assert.ok(
    getTableConfig(githubConnection).uniqueConstraints.some(
      (constraint) =>
        constraint.name === "github_connection_id_organization_unique",
    ),
  );
  assert.ok(
    config.indexes.some(
      (index) => index.config.name === "github_repo_organization_id_idx",
    ),
  );
});

test("a new repository waits as pending, and is assumed private", () => {
  const columns = getTableConfig(githubRepo).columns;

  assert.equal(
    columns.find((column) => column.name === "sync_status")?.default,
    "pending",
  );
  assert.equal(
    columns.find((column) => column.name === "is_private")?.default,
    true,
  );
});
