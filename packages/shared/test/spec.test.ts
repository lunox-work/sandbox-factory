import assert from "node:assert/strict";
import { test } from "node:test";

import { SPEC_LIMITS } from "sandbox-factory";

import { WEIGHT_REASON_CHARS } from "sandbox-factory";

import {
  bountySpecDtoSchema,
  bountySpecRevisionDtoSchema,
  proposalSpecResponseSchema,
  proposalSpecRevisionsResponseSchema,
  respecRequestSchema,
  scenarioSchema,
  specDraftSchema,
} from "../src/spec.js";

const scenario = {
  id: "s1",
  kind: "happy",
  title: "Invitation is delivered",
  steps: [
    { keyword: "Given", text: "a signed-in recruiter" },
    { keyword: "When", text: "they send the invitation" },
    { keyword: "Then", text: "the candidate receives it" },
  ],
  origin: "draft",
};

const draft = {
  feature: "Interview invitation delivery",
  background: ["an open requisition exists"],
  scenarios: [scenario],
  openQuestions: ["Which timezone is the slot shown in?"],
  assumptions: ["Invitations go by email only."],
};

const spec = {
  id: "bsp_1",
  organizationId: "org_1",
  proposalId: "bpr_1",
  revision: 1,
  specHash: "a".repeat(64),
  specHashVersion: 1,
  draft,
  origin: "draft",
  instruction: null,
  createdBy: null,
  runId: "brn_1",
  actualModel: "actual-model",
  promptVersion: "draft-v1",
  createdAt: "2026-09-30T00:00:00.000Z",
};

test("a well-formed draft parses unchanged", () => {
  assert.deepEqual(specDraftSchema.parse(draft), draft);
});

test("kinds, keywords and origins are closed sets", () => {
  for (const bad of [
    { ...scenario, kind: "sad" },
    { ...scenario, origin: "model" },
    { ...scenario, steps: [{ keyword: "Whenever", text: "it rains" }] },
  ]) {
    assert.equal(scenarioSchema.safeParse(bad).success, false);
  }
});

test("a weight is optional, so a spec drafted before weights still reads", () => {
  // `draft-v1` rows carry no weight at all.
  assert.deepEqual(scenarioSchema.parse(scenario), scenario);
  const weighed = {
    ...scenario,
    weight: "heavy",
    weightReason: "a new delivery job",
  };
  assert.deepEqual(scenarioSchema.parse(weighed), weighed);
  for (const bad of [
    { ...scenario, weight: "huge" },
    { ...weighed, weightReason: "" },
    { ...weighed, weightReason: "two\nlines" },
    { ...weighed, weightReason: "x".repeat(WEIGHT_REASON_CHARS + 1) },
  ]) {
    assert.equal(scenarioSchema.safeParse(bad).success, false);
  }
});

test("a scenario needs an id of its own shape and at least one step", () => {
  for (const id of ["1", "s0", "s", "scenario-1", "s1000"]) {
    assert.equal(scenarioSchema.safeParse({ ...scenario, id }).success, false);
  }
  assert.equal(
    scenarioSchema.safeParse({ ...scenario, id: "s12" }).success,
    true,
  );
  assert.equal(
    scenarioSchema.safeParse({ ...scenario, steps: [] }).success,
    false,
  );
});

test("every string is one trimmed line within its cap", () => {
  // A stored line break would become a line of Gherkin nobody wrote.
  for (const text of ["", " padded ", "two\nlines", "carriage\rreturn"]) {
    assert.equal(
      scenarioSchema.safeParse({
        ...scenario,
        steps: [{ keyword: "Given", text }],
      }).success,
      false,
      JSON.stringify(text),
    );
  }
  assert.equal(
    specDraftSchema.safeParse({
      ...draft,
      feature: "x".repeat(SPEC_LIMITS.featureChars + 1),
    }).success,
    false,
  );
  assert.equal(
    specDraftSchema.safeParse({
      ...draft,
      openQuestions: ["x".repeat(SPEC_LIMITS.noteChars + 1)],
    }).success,
    false,
  );
});

test("a stored spec may hold more scenarios than one draft may produce", () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      ...scenario,
      id: `s${index + 1}`,
    }));

  assert.equal(
    specDraftSchema.safeParse({
      ...draft,
      scenarios: many(SPEC_LIMITS.draftScenarios + 1),
    }).success,
    true,
  );
  assert.equal(
    specDraftSchema.safeParse({
      ...draft,
      scenarios: many(SPEC_LIMITS.scenarios + 1),
    }).success,
    false,
  );
});

test("scenario ids are unique inside a spec", () => {
  const parsed = specDraftSchema.safeParse({
    ...draft,
    scenarios: [scenario, { ...scenario, title: "Again" }],
  });
  assert.equal(parsed.success, false);
});

test("a spec with no scenario has to say what it was missing", () => {
  assert.equal(
    specDraftSchema.safeParse({ ...draft, scenarios: [] }).success,
    true,
  );
  assert.equal(
    specDraftSchema.safeParse({ ...draft, scenarios: [], openQuestions: [] })
      .success,
    false,
  );
});

test("a spec revision carries its provenance, nullable where a person or run is absent", () => {
  assert.deepEqual(bountySpecDtoSchema.parse(spec), spec);
  const byReviewer = {
    ...spec,
    origin: "expand",
    instruction: "More unhappy paths",
    createdBy: "user_1",
    runId: null,
    actualModel: null,
    promptVersion: null,
  };
  assert.deepEqual(bountySpecDtoSchema.parse(byReviewer), byReviewer);
  for (const bad of [
    { ...spec, origin: "rewrite" },
    { ...spec, revision: 0 },
    { ...spec, specHash: "short" },
  ]) {
    assert.equal(bountySpecDtoSchema.safeParse(bad).success, false);
  }
});

test("the spec read answers null for a proposal with no spec", () => {
  assert.deepEqual(proposalSpecResponseSchema.parse({ spec: null }), {
    spec: null,
  });
  assert.equal(proposalSpecResponseSchema.parse({ spec }).spec?.revision, 1);
});

test("a revision listing carries counts, not scenarios", () => {
  const revision = {
    revision: 2,
    origin: "draft",
    instruction: null,
    scenarioCount: 7,
    openQuestionCount: 0,
    createdBy: null,
    createdAt: "2026-09-30T00:00:00.000Z",
    current: true,
  };
  assert.deepEqual(bountySpecRevisionDtoSchema.parse(revision), revision);
  assert.deepEqual(
    proposalSpecRevisionsResponseSchema.parse({ revisions: [revision] }),
    { revisions: [revision] },
  );
  assert.equal(
    bountySpecRevisionDtoSchema.safeParse({ ...revision, scenarioCount: -1 })
      .success,
    false,
  );
});

test("a spec change asks for kinds or an instruction, answers or removals", () => {
  const valid = [
    { mode: "expand", kinds: ["boundary", "recovery"] },
    { mode: "expand", instruction: "Cover a recruiter on a phone." },
    { mode: "expand", kinds: ["permission"], instruction: "Guests too." },
    {
      mode: "answer",
      answers: [
        { question: "Which timezone is the slot shown in?", answer: "UTC." },
      ],
    },
    { mode: "trim", removeScenarioIds: ["s1", "s12"] },
  ];
  for (const request of valid) {
    assert.ok(respecRequestSchema.safeParse(request).success, request.mode);
  }
  // An instruction is trimmed, and an answer too.
  assert.deepEqual(
    respecRequestSchema.parse({ mode: "expand", instruction: "  More.  " }),
    { mode: "expand", instruction: "More." },
  );

  const invalid = [
    {},
    { mode: "rewrite" },
    // Nothing to expand by.
    { mode: "expand" },
    { mode: "expand", kinds: [] },
    { mode: "expand", kinds: ["boundary", "boundary"] },
    { mode: "expand", kinds: ["sideways"] },
    { mode: "expand", instruction: "   " },
    { mode: "expand", instruction: "x".repeat(501) },
    { mode: "answer", answers: [] },
    { mode: "answer", answers: [{ question: "Who?", answer: " " }] },
    { mode: "answer", answers: [{ question: "Who?\nWhy?", answer: "Me." }] },
    {
      mode: "answer",
      answers: [
        { question: "Who?", answer: "Me." },
        { question: "Who?", answer: "You." },
      ],
    },
    { mode: "trim", removeScenarioIds: [] },
    { mode: "trim", removeScenarioIds: ["s0"] },
    { mode: "trim", removeScenarioIds: ["s1", "s1"] },
  ];
  for (const request of invalid) {
    assert.equal(
      respecRequestSchema.safeParse(request).success,
      false,
      JSON.stringify(request),
    );
  }
});
