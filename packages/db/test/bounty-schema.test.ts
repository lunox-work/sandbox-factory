import assert from "node:assert/strict";
import { test } from "node:test";

import { getTableConfig } from "drizzle-orm/pg-core";

import { bountyProposal, bountyRun, rateCard } from "../src/schema/bounty.js";

test("one active run is allowed per board", () => {
  const index = getTableConfig(bountyRun).indexes.find(
    ({ config }) => config.name === "bounty_run_board_active_unique",
  );
  assert.equal(index?.config.unique, true);
  assert.notEqual(index?.config.where, undefined);
});

test("run request retries are unique inside one organization", () => {
  const constraint = getTableConfig(bountyRun).uniqueConstraints.find(
    ({ name }) => name === "bounty_run_organization_request_unique",
  );
  assert.notEqual(constraint, undefined);
  assert.deepEqual(
    constraint?.columns.map(({ name }) => name),
    ["organization_id", "request_id"],
  );
});

test("one live proposal is allowed per board-local issue pointer", () => {
  const index = getTableConfig(bountyProposal).indexes.find(
    ({ config }) => config.name === "bounty_proposal_live_unique",
  );
  assert.equal(index?.config.unique, true);
  assert.notEqual(index?.config.where, undefined);
});

test("commercial rows carry non-null organization ownership", () => {
  for (const table of [rateCard, bountyRun, bountyProposal]) {
    const owner = getTableConfig(table).columns.find(
      ({ name }) => name === "organization_id",
    );
    assert.equal(owner?.notNull, true);
  }
});

test("proposal constraints pin money, lifecycle and review invariants", () => {
  const names = getTableConfig(bountyProposal).checks.map(({ name }) => name);
  for (const expected of [
    "bounty_proposal_money_check",
    "bounty_proposal_approved_sized_check",
    "bounty_proposal_status_check",
    "bounty_proposal_hash_check",
  ]) {
    assert.ok(names.includes(expected), expected);
  }
});

test("all commercial foreign-key thunks resolve", () => {
  for (const table of [rateCard, bountyRun, bountyProposal]) {
    for (const key of getTableConfig(table).foreignKeys) {
      const reference = key.reference();
      assert.ok(reference.foreignTable);
      assert.ok(reference.foreignColumns.length > 0);
    }
  }
});
