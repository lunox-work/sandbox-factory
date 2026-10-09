import assert from "node:assert/strict";
import { test } from "node:test";

import { stepUp, type SpecDraft } from "sandbox-factory";

import {
  bountyComplexitySchema,
  bountyProposalDtoSchema,
  bountyRunKindSchema,
  bountyRunOutcomeSchema,
  createRunSchema,
  pricedComplexitySchema,
  resizeProposalSchema,
  putRateCardSchema,
  rateCardSnapshotSchema,
  respecProposalSchema,
  sizingResultSchema,
  stepResultSchema,
} from "../src/pricing.js";

test("rate cards normalize currency and require monotonic safe amounts", () => {
  const parsed = putRateCardSchema.parse({
    expectedRevision: 0,
    currency: "usd",
    xsMinor: 100,
    sMinor: 100,
    mMinor: 200,
    lMinor: 300,
    xlMinor: 400,
  });
  assert.equal(parsed.currency, "USD");
  assert.equal(
    putRateCardSchema.safeParse({ ...parsed, sMinor: 500 }).success,
    false,
  );
  assert.equal(
    putRateCardSchema.safeParse({ ...parsed, sMinor: Number.MAX_VALUE })
      .success,
    false,
  );
});

test("unsized sizing results require a reason and sized results reject one", () => {
  assert.equal(
    sizingResultSchema.safeParse({
      complexity: "unsized",
      confidence: "low",
      rationale: "The requirements are incomplete.",
    }).success,
    false,
  );
  assert.equal(
    sizingResultSchema.safeParse({
      complexity: "S",
      confidence: "high",
      rationale: "A localized change.",
      unsizedReason: "missing requirements",
    }).success,
    false,
  );
});

test("run request ids are UUIDs", () => {
  assert.equal(
    createRunSchema.safeParse({
      requestId: "28bb313f-252a-4a1d-b656-558a215b604b",
    }).success,
    true,
  );
  assert.equal(
    createRunSchema.safeParse({ requestId: "retry-me" }).success,
    false,
  );
});

test("XS is required on rate writes and accepted in sizing and review", () => {
  const card = {
    currency: "USD",
    xsMinor: 50,
    sMinor: 100,
    mMinor: 200,
    lMinor: 300,
    xlMinor: 400,
    expectedRevision: 0,
  };
  for (const xsMinor of [undefined, 0, 101]) {
    assert.equal(
      putRateCardSchema.safeParse({ ...card, xsMinor }).success,
      false,
    );
  }
  assert.equal(putRateCardSchema.parse(card).xsMinor, 50);
  assert.equal(
    sizingResultSchema.parse({
      complexity: "XS",
      confidence: "high",
      rationale: "One label correction.",
    }).complexity,
    "XS",
  );
  assert.equal(
    resizeProposalSchema.parse({ complexity: "XS", expectedRevision: 1 })
      .complexity,
    "XS",
  );
});

test("USD write limits preserve historical rate-card snapshots", () => {
  const card = {
    currency: "usd",
    xsMinor: 1000,
    sMinor: 5800,
    mMinor: 10500,
    lMinor: 15300,
    xlMinor: 100000,
    expectedRevision: 0,
  };
  assert.equal(putRateCardSchema.safeParse(card).success, true);
  assert.equal(
    putRateCardSchema.safeParse({ ...card, xlMinor: 100001 }).success,
    false,
  );
  assert.equal(
    putRateCardSchema.safeParse({ ...card, currency: "JPY", xlMinor: 200000 })
      .success,
    true,
  );
  assert.equal(
    rateCardSnapshotSchema.safeParse({ ...card, xlMinor: 200000, revision: 1 })
      .success,
    true,
  );
});

test("half sizes are prices, never the model's answer or a resize", () => {
  for (const size of ["XS+", "S+", "M+", "L+"]) {
    assert.equal(pricedComplexitySchema.safeParse(size).success, true);
    assert.equal(bountyComplexitySchema.safeParse(size).success, true);
    assert.equal(
      sizingResultSchema.safeParse({
        complexity: size,
        confidence: "high",
        rationale: "Between two sizes.",
      }).success,
      false,
    );
    assert.equal(
      resizeProposalSchema.safeParse({ complexity: size, expectedRevision: 1 })
        .success,
      false,
    );
  }
  // There is no size past XL to step into.
  assert.equal(pricedComplexitySchema.safeParse("XL+").success, false);
});

const sized: SpecDraft = {
  feature: "Invitations",
  background: [],
  scenarios: [
    {
      id: "s1",
      kind: "happy",
      title: "Sent",
      steps: [{ keyword: "Then", text: "it is sent" }],
      origin: "draft",
      weight: "light",
    },
  ],
  openQuestions: [],
  assumptions: [],
};

test("a step as core computes it is a step the wire carries", () => {
  const grown: SpecDraft = {
    ...sized,
    scenarios: [
      ...sized.scenarios,
      {
        id: "s2",
        kind: "recovery",
        title: "Retried",
        steps: [{ keyword: "Then", text: "it is sent again" }],
        origin: "expansion",
        weight: "heavy",
      },
    ],
  };
  const step = stepUp("S", sized, grown);
  assert.deepEqual(stepResultSchema.parse(step), step);
  // A base is a whole size: a half size is only ever where a step lands.
  assert.equal(
    stepResultSchema.safeParse({ ...step, base: "S+" }).success,
    false,
  );
  assert.equal(
    stepResultSchema.safeParse({
      ...step,
      settings: { ...step?.settings, pointsPerStep: 0 },
    }).success,
    false,
  );
});

test("a proposal carries its step, null when there is none", () => {
  const proposal = {
    id: "bpr_1",
    organizationId: "org_1",
    runId: "brn_1",
    bountyId: "bty_1",
    issueKey: "APP-1",
    title: "Add a checkout form",
    specHash: "a".repeat(64),
    specHashVersion: 1,
    rateCard: {
      currency: "USD",
      xsMinor: 1,
      sMinor: 2,
      mMinor: 3,
      lMinor: 4,
      xlMinor: 5,
      revision: 1,
    },
    modelComplexity: "S",
    modelConfidence: "high",
    modelRationale: "One form.",
    unsizedReason: null,
    inputTruncated: false,
    actualModel: "model",
    promptVersion: "jira-size-v2",
    complexity: "S+",
    sizedBy: "model",
    resizedBy: null,
    resizedAt: null,
    amountMinor: 3,
    currency: "USD",
    status: "proposed",
    revision: 1,
    specRevision: 2,
    step: stepUp("S", sized, sized),
    decidedAt: null,
    decidedBy: null,
    decisionDeliveryPolicy: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  assert.equal(bountyProposalDtoSchema.safeParse(proposal).success, true);
  assert.equal(
    bountyProposalDtoSchema.safeParse({ ...proposal, step: null }).success,
    true,
  );
  // The repositories its work touches, none when an answer leaves them out.
  assert.deepEqual(bountyProposalDtoSchema.parse(proposal).repositories, []);
  const touched = [
    { repoId: "ghr_1", snapshotId: "rsn_1" },
    { repoId: "ghr_2", snapshotId: "rsn_2" },
  ];
  assert.deepEqual(
    bountyProposalDtoSchema.parse({ ...proposal, repositories: touched })
      .repositories,
    touched,
  );
  assert.equal(
    bountyProposalDtoSchema.safeParse({
      ...proposal,
      repositories: [{ repoId: "ghr_1" }],
    }).success,
    false,
  );
  // The model's own size stays whole whatever the step made of it.
  assert.equal(
    bountyProposalDtoSchema.safeParse({ ...proposal, modelComplexity: "S+" })
      .success,
    false,
  );
});

test("a respec names the proposal revision, its request and what it asks", () => {
  const body = {
    expectedRevision: 3,
    requestId: "28bb313f-252a-4a1d-b656-558a215b604b",
    request: { mode: "trim", removeScenarioIds: ["s2"] },
  };
  assert.deepEqual(respecProposalSchema.parse(body), body);
  assert.equal(
    respecProposalSchema.safeParse({ ...body, request: undefined }).success,
    false,
  );
  assert.equal(
    respecProposalSchema.safeParse({ ...body, requestId: "again" }).success,
    false,
  );
  // A respec run, and what its outcome says the change did.
  assert.equal(bountyRunKindSchema.parse("respec"), "respec");
  assert.deepEqual(
    bountyRunOutcomeSchema.parse({
      externalIssueId: "10001",
      issueKey: "NOX-1",
      status: "proposed",
      previousComplexity: "S",
      pointsDelta: -4,
    }),
    {
      externalIssueId: "10001",
      issueKey: "NOX-1",
      status: "proposed",
      previousComplexity: "S",
      pointsDelta: -4,
    },
  );
  assert.equal(
    bountyRunOutcomeSchema.safeParse({
      externalIssueId: "10001",
      issueKey: "NOX-1",
      status: "proposed",
      pointsDelta: 1.5,
    }).success,
    false,
  );
});
