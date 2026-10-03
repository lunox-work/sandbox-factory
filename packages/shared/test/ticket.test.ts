import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSandboxSchema,
  createTicketSchema,
  proposeTicketSchema,
  ticketDtoSchema,
  ticketListResponseSchema,
  ticketSpecHash,
  updateTicketSchema,
} from "../src/index.js";

const stamp = "2026-10-03T00:00:00.000Z";

const summary = {
  id: "tkt_1",
  organizationId: "org_1",
  number: 7,
  key: "T-7",
  title: "Invitations are not sent",
  issueType: "Bug",
  priority: null,
  labels: ["email"],
  origin: "manual",
  repoId: null,
  revision: 1,
  jira: null,
  proposal: null,
  createdAt: stamp,
  updatedAt: stamp,
};

test("a ticket written here needs only a title", () => {
  assert.deepEqual(createTicketSchema.parse({ title: "  Fix login  " }), {
    title: "Fix login",
    description: "",
    issueType: "Task",
    priority: null,
    labels: [],
    repoId: null,
  });
  assert.equal(createTicketSchema.safeParse({ title: " " }).success, false);
  assert.equal(createTicketSchema.safeParse({}).success, false);
});

test("a ticket's text is bounded as a Jira description is", () => {
  assert.equal(
    createTicketSchema.safeParse({
      title: "t",
      description: "x".repeat(20_000),
    }).success,
    true,
  );
  assert.equal(
    createTicketSchema.safeParse({
      title: "t",
      description: "x".repeat(20_001),
    }).success,
    false,
  );
  assert.equal(
    createTicketSchema.safeParse({ title: "x".repeat(256) }).success,
    false,
  );
});

test("labels are trimmed and kept once each", () => {
  assert.deepEqual(
    createTicketSchema.parse({ title: "t", labels: [" ui ", "ui", "email"] })
      .labels,
    ["ui", "email"],
  );
  assert.equal(
    createTicketSchema.safeParse({
      title: "t",
      labels: Array.from({ length: 21 }, (_, i) => `l${i}`),
    }).success,
    false,
  );
});

test("unknown fields are refused rather than dropped", () => {
  assert.equal(
    createTicketSchema.safeParse({ title: "t", origin: "jira" }).success,
    false,
  );
});

test("a change names its revision and at least one field", () => {
  assert.equal(
    updateTicketSchema.safeParse({ expectedRevision: 1 }).success,
    false,
  );
  assert.deepEqual(
    updateTicketSchema.parse({ expectedRevision: 2, repoId: null }),
    { expectedRevision: 2, repoId: null },
  );
  assert.equal(updateTicketSchema.safeParse({ title: "t" }).success, false);
});

test("a proposal for a ticket is named by its request id", () => {
  assert.equal(
    proposeTicketSchema.safeParse({
      requestId: "8f0b4a1e-9a77-4c35-9a52-3f0f5b2d3c11",
    }).success,
    true,
  );
  assert.equal(
    proposeTicketSchema.safeParse({ requestId: "x" }).success,
    false,
  );
});

test("a ticket reads with or without a Jira issue and a proposal", () => {
  const detail = {
    ...summary,
    description: "Steps",
    components: [],
    inputTruncated: false,
    createdBy: "user_1",
  };
  assert.equal(ticketDtoSchema.safeParse(detail).success, true);
  assert.equal(
    ticketDtoSchema.safeParse({
      ...detail,
      origin: "jira",
      key: "APP-3",
      jira: {
        issueId: "jri_1",
        boardId: "jrb_1",
        connectionId: "jrc_1",
        key: "APP-3",
        url: "https://acme.atlassian.net/browse/APP-3",
        removedAt: null,
      },
      proposal: {
        id: "bpr_1",
        status: "proposed",
        complexity: "M",
        amountMinor: 10_500,
        currency: "USD",
      },
    }).success,
    true,
  );
  assert.equal(
    ticketListResponseSchema.safeParse({
      tickets: [summary],
      nextCursor: null,
    }).success,
    true,
  );
});

test("a sandbox is cut for tickets", () => {
  assert.deepEqual(createSandboxSchema.parse({ sourceRepoId: "ghr_1" }), {
    sourceRepoId: "ghr_1",
    ticketIds: [],
  });
  assert.equal(
    createSandboxSchema.safeParse({
      sourceRepoId: "ghr_1",
      jiraIssueIds: ["jri_1"],
    }).success,
    false,
  );
});

test("re-exports the one ticket hash", async () => {
  assert.equal((await ticketSpecHash("a", "b", "Task")).length, 64);
});
