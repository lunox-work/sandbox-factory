/**
 * Reading what an agent run answered: a scope proposal and a fixture set,
 * each from the bounded copy its artifact row carries. Both are made by a
 * bounty's flow now, so the views offer nothing that would act on them —
 * no "Use this scope", no picker.
 */

import { render, screen } from "./render";
import { expect, test } from "vitest";
import type { FixtureSetDto, ScopeProposalDto } from "@sandbox-factory/shared";
import {
  FixtureSetView,
  ScopeProposalView,
} from "../src/features/analysis/AgentViews";

const usage = {
  model: "claude-opus-5-5",
  turns: 6,
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 9000,
  cacheWriteTokens: 300,
};
const proposal: ScopeProposalDto = {
  schemaVersion: 1,
  toolVersion: "scope@1",
  sourceSnapshotId: "rsn_1",
  sourceCommitSha: "a".repeat(40),
  graphRunId: "arn_1",
  proposalId: "bpr_1",
  specRevision: 2,
  entryPoints: [
    { path: "src/rules.ts", reason: "the discount rule changes here" },
    { path: "src/app.ts", reason: "calls the rule" },
  ],
  budget: { maxFiles: 8, maxDepth: 0 },
  includeInferred: true,
  seams: [{ module: "lib/db.ts", kind: "database", reason: "queries orders" }],
  summary: "The developer changes how discounts stack.",
  risks: ["The price cache is mocked."],
  check: {
    stubCoverage: "full",
    ready: true,
    includedFiles: 2,
    outboundModules: 1,
    blockers: 0,
  },
  usage,
};
const fixtureSet: FixtureSetDto = {
  schemaVersion: 1,
  toolVersion: "fixtures@1",
  sliceRunId: "arn_slice",
  sourceSnapshotId: "rsn_1",
  sourceCommitSha: "a".repeat(40),
  proposalId: "bpr_1",
  specRevision: 2,
  fixtures: [
    {
      module: "lib/db.ts",
      symbol: "db",
      member: "orders.find",
      call: "call",
      implementation: "async (id) => ({ id, total: 40 })",
      reason: "an order to discount",
    },
    {
      module: "lib/db.ts",
      symbol: "Client",
      member: null,
      call: "construct",
      implementation: "() => ({ open: true })",
      reason: "a client",
    },
  ],
  scenario: 'import { run } from "../src/app.js";\nconsole.log(run());\n',
  summary: "Walks a discounted order.",
  usage,
};

test("a scope proposal reads its check, entry points, seams, risks and usage", () => {
  render(<ScopeProposalView proposal={proposal} />);
  expect(
    screen.getByText("The developer changes how discounts stack."),
  ).toBeTruthy();
  expect(screen.getByText("Slices cleanly")).toBeTruthy();
  expect(screen.getByText("coverage: full")).toBeTruthy();
  expect(screen.getByText("depth 0 · up to 8 files")).toBeTruthy();
  expect(screen.getByText("the discount rule changes here")).toBeTruthy();
  expect(screen.getByText("calls the rule")).toBeTruthy();
  expect(
    screen.getByText("Follows relations the structure analysis inferred."),
  ).toBeTruthy();
  expect(screen.getByText("queries orders")).toBeTruthy();
  expect(screen.getByText("The price cache is mocked.")).toBeTruthy();
  expect(
    screen.getByText(/6 turns · 10,500 tokens \(9,000 cached\)/),
  ).toBeTruthy();
  // Read-only: the bounty that asked for it is where it is acted on.
  expect(screen.queryByRole("button")).toBe(null);
  expect(screen.queryByText("Use this scope")).toBe(null);
});

test("a proposal with blockers and no seams says so", () => {
  render(
    <ScopeProposalView
      proposal={{
        ...proposal,
        seams: [],
        risks: [],
        includeInferred: false,
        check: { ...proposal.check, ready: false, blockers: 2 },
      }}
    />,
  );
  expect(screen.getByText("2 blockers")).toBeTruthy();
  expect(
    screen.getByText("The agent named no cut module as a seam."),
  ).toBeTruthy();
  expect(screen.queryByText("Risks")).toBe(null);
});

test("a fixture set reads its fixtures, walkthrough and usage", () => {
  render(<FixtureSetView set={fixtureSet} />);
  expect(screen.getByText("Walks a discounted order.")).toBeTruthy();
  expect(screen.getByText(/Fixtures \(2\)/)).toBeTruthy();
  expect(screen.getByText("lib/db.ts · db.orders.find")).toBeTruthy();
  expect(screen.getByText("lib/db.ts · new Client")).toBeTruthy();
  expect(screen.getByText("async (id) => ({ id, total: 40 })")).toBeTruthy();
  expect(screen.getByText(/console\.log\(run\(\)\);/)).toBeTruthy();
  expect(
    screen.getByText(/6 turns · 10,500 tokens \(9,000 cached\)/),
  ).toBeTruthy();
});

test("an empty fixture set says every call keeps its recorded mock", () => {
  render(<FixtureSetView set={{ ...fixtureSet, fixtures: [] }} />);
  expect(
    screen.getByText("Every mocked call keeps returning a recorded mock."),
  ).toBeTruthy();
});
