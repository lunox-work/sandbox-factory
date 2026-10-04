import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMPLEXITY_PROFILE_VERSION,
  buildComplexityProfile,
  treeFacts,
} from "../src/index.js";
import type { ProfileInput, Scenario } from "../src/index.js";

const scenario = (id: string, kind: Scenario["kind"]): Scenario => ({
  id,
  kind,
  title: id,
  steps: [{ keyword: "Given", text: "a step" }],
  origin: "draft",
  weight: "moderate",
});

/** A repository shaped like the worked example: scheduler, mailer, offers. */
const facts = treeFacts([
  { path: "src/scheduler/interview.ts", size: 4_000 },
  { path: "src/scheduler/calendar.ts", size: 2_000 },
  { path: "src/mailer/invite.ts", size: 3_000 },
  { path: "src/mailer/invite.test.ts", size: 1_000 },
  { path: "src/mailer/offer.ts", size: 3_000 },
  { path: "src/db/migrations/0001_init.sql", size: 500 },
  { path: "src/db/client.ts", size: 800 },
  { path: ".github/workflows/ci.yml", size: 300 },
  { path: "README.md", size: 100 },
]);

const input: ProfileInput = {
  bounty: { issueType: "Bug", priority: "High" },
  spec: {
    scenarios: [
      scenario("s1", "happy"),
      scenario("s2", "recovery"),
      scenario("s3", "happy"),
    ],
    openQuestions: [],
    assumptions: ["Retries key on an idempotency token per interview."],
  },
  facts,
  scope: {
    entryPoints: [
      { path: "src/scheduler/interview.ts", reason: "saves the interview" },
      { path: "src/mailer/invite.ts", reason: "sends the invitation" },
    ],
    seams: [{ module: "src/db/client.ts", kind: "database", reason: "I/O" }],
    risks: ["Retries only exist as a mock."],
    pattern: { path: "src/mailer/offer.ts", reason: "retries idempotently" },
  },
  slice: {
    stubCoverage: "full",
    ready: true,
    counts: { includedFiles: 3, includedBytes: 10_000, blockers: 0 },
    included: [
      "src/scheduler/interview.ts",
      "src/scheduler/calendar.ts",
      "src/mailer/invite.ts",
    ],
    externals: {
      packages: [
        { service: "email" },
        { service: "postgres" },
        { service: "email" },
      ],
      environment: ["SMTP_HOST", "DATABASE_URL"],
    },
  },
};

test("a profile measures the slice, where the change lands and what guards it", () => {
  const profile = buildComplexityProfile(input);
  assert.equal(profile.version, COMPLEXITY_PROFILE_VERSION);
  assert.deepEqual(profile.bounty, { issueType: "Bug", priority: "High" });
  assert.deepEqual(profile.slice, {
    files: 3,
    bytes: 10_000,
    modules: ["src/mailer", "src/scheduler"],
    stubCoverage: "full",
    blockers: 0,
    ready: true,
  });
  assert.deepEqual(profile.touchedModules, ["src/mailer", "src/scheduler"]);
  // Services once each, sorted; environment and seams counted.
  assert.deepEqual(profile.externals, {
    services: ["email", "postgres"],
    environment: 2,
    seams: 1,
  });
  assert.equal(profile.spec.scenarios, 3);
  assert.equal(profile.spec.kinds.happy, 2);
  assert.equal(profile.spec.kinds.recovery, 1);
  assert.equal(profile.spec.kinds.permission, 0);
  assert.equal(profile.spec.openQuestions, 0);
  assert.equal(profile.spec.assumptions, 1);
  // The mailer has a test; the scheduler has none.
  assert.deepEqual(profile.tests, {
    files: 1,
    untestedModules: ["src/scheduler"],
  });
  assert.deepEqual(profile.pattern, input.scope.pattern);
  // Migrations sit in src/db, which the change does not touch; CI does run.
  assert.deepEqual(profile.nonFunctional, {
    scenarios: 0,
    migrations: false,
    ci: true,
  });
  assert.deepEqual(profile.risks, ["Retries only exist as a mock."]);
});

test("a change landing beside migrations, with no pattern, no CI and a non-functional scenario", () => {
  const profile = buildComplexityProfile({
    ...input,
    spec: {
      ...input.spec,
      scenarios: [scenario("s1", "non-functional")],
      openQuestions: ["Which timezone?", "Who is notified?"],
    },
    facts: { ...facts, infraDirectories: ["deploy"] },
    scope: {
      ...input.scope,
      entryPoints: [{ path: "src/db/client.ts", reason: "the schema" }],
      pattern: undefined,
    },
  });
  assert.deepEqual(profile.touchedModules, ["src/db"]);
  assert.equal(profile.pattern, null);
  assert.equal(profile.spec.openQuestions, 2);
  assert.deepEqual(profile.tests, { files: 0, untestedModules: ["src/db"] });
  assert.deepEqual(profile.nonFunctional, {
    scenarios: 1,
    migrations: true,
    ci: false,
  });
});

test("CircleCI counts as CI wherever it sits, and a scope from before patterns names none", () => {
  for (const directory of [".circleci", "services/api/.circleci"]) {
    const profile = buildComplexityProfile({
      ...input,
      facts: { ...facts, infraDirectories: [directory] },
    });
    assert.equal(profile.nonFunctional.ci, true, directory);
  }
  const { pattern: _pattern, ...older } = input.scope;
  assert.equal(
    buildComplexityProfile({ ...input, scope: older }).pattern,
    null,
  );
});
