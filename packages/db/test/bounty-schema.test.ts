import assert from "node:assert/strict";
import { test } from "node:test";

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  BOUNTY_COMPLEXITIES,
  MODEL_BOUNTY_COMPLEXITIES,
} from "sandbox-factory";

import {
  BOUNTY_SPEC_ORIGINS,
  bountyProposal,
  bountyRun,
  bountySpec,
  rateCard,
} from "../src/schema/bounty.js";

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
  for (const table of [rateCard, bountyRun, bountyProposal, bountySpec]) {
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

test("a spec has one row per revision and goes with its proposal", () => {
  const config = getTableConfig(bountySpec);
  const unique = config.uniqueConstraints.find(
    ({ name }) => name === "bounty_spec_proposal_revision_unique",
  );
  assert.deepEqual(
    unique?.columns.map(({ name }) => name),
    ["proposal_id", "revision"],
  );

  // Derived ticket text must not outlive the proposal or the organization
  // it was drafted for; who or what drafted it may go without taking it.
  const onDelete = Object.fromEntries(
    config.foreignKeys.map((key) => [
      key.reference().columns[0]?.name,
      key.onDelete,
    ]),
  );
  assert.deepEqual(onDelete, {
    organization_id: "cascade",
    proposal_id: "cascade",
    created_by: "set null",
    run_id: "set null",
  });

  const checks = config.checks.map(({ name }) => name);
  for (const expected of [
    "bounty_spec_revision_check",
    "bounty_spec_origin_check",
    "bounty_spec_hash_check",
  ]) {
    assert.ok(checks.includes(expected), expected);
  }
  assert.deepEqual(BOUNTY_SPEC_ORIGINS, ["draft", "expand", "trim", "answer"]);
});

test("a proposal's spec pointer is optional and positive", () => {
  const config = getTableConfig(bountyProposal);
  const column = config.columns.find(({ name }) => name === "spec_revision");
  assert.equal(column?.notNull, false);
  assert.ok(
    config.checks.some(
      ({ name }) => name === "bounty_proposal_spec_revision_check",
    ),
  );
});

/** The quoted values a check constraint lists, in order. */
function checkValues(table: PgTable, name: string): string[] {
  const check = getTableConfig(table).checks.find(
    (candidate) => candidate.name === name,
  );
  assert.ok(check !== undefined, name);
  const text = check.value.queryChunks
    .map((chunk) =>
      typeof chunk === "object" &&
      chunk !== null &&
      "value" in chunk &&
      Array.isArray(chunk.value)
        ? chunk.value.join("")
        : "",
    )
    .join("");
  return [...text.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? "");
}

test("the size checks are the core enums: half sizes for the price, never for the model", () => {
  assert.deepEqual(
    checkValues(bountyProposal, "bounty_proposal_complexity_check"),
    [...BOUNTY_COMPLEXITIES],
  );
  assert.deepEqual(
    checkValues(bountyProposal, "bounty_proposal_model_complexity_check"),
    [...MODEL_BOUNTY_COMPLEXITIES],
  );
});

test("a proposal's step is optional, and its version goes with it", () => {
  const config = getTableConfig(bountyProposal);
  for (const name of ["step", "step_version"]) {
    const column = config.columns.find((candidate) => candidate.name === name);
    assert.equal(column?.notNull, false, name);
  }
  assert.ok(
    config.checks.some(({ name }) => name === "bounty_proposal_step_check"),
  );
});

test("all commercial foreign-key thunks resolve", () => {
  for (const table of [rateCard, bountyRun, bountyProposal, bountySpec]) {
    for (const key of getTableConfig(table).foreignKeys) {
      const reference = key.reference();
      assert.ok(reference.foreignTable);
      assert.ok(reference.foreignColumns.length > 0);
    }
  }
});
