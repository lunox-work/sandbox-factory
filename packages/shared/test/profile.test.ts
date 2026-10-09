import assert from "node:assert/strict";
import { test } from "node:test";
import { scopeSubmissionSchema } from "../src/analysis.js";
import {
  bountyProfileDtoSchema,
  complexityProfileSchema,
  proposalProfileResponseSchema,
} from "../src/profile.js";

const profile = {
  version: "profile-v1",
  slice: {
    files: 9,
    bytes: 42_000,
    modules: ["src/mailer", "src/scheduler"],
    stubCoverage: "full",
    blockers: 0,
    ready: true,
  },
  touchedModules: ["src/mailer", "src/scheduler"],
  externals: { services: ["email"], environment: 1, seams: 1 },
  spec: {
    scenarios: 3,
    kinds: {
      happy: 1,
      boundary: 0,
      unhappy: 0,
      recovery: 2,
      permission: 0,
      concurrency: 0,
      "non-functional": 0,
    },
    openQuestions: 0,
    assumptions: 1,
  },
  tests: { files: 4, untestedModules: ["src/scheduler"] },
  pattern: { path: "src/mailer/offer.ts", reason: "retries idempotently" },
  nonFunctional: { scenarios: 0, migrations: false, ci: true },
  risks: [],
};

const stored = {
  id: "bpf_1",
  proposalId: "bpr_1",
  specRevision: 2,
  repository: "acme/app",
  status: "ready",
  errorCode: null,
  runErrorCode: null,
  snapshotId: "rsn_1",
  scopeRunId: "arn_1",
  sliceRunId: "arn_2",
  profile,
  createdAt: "2026-10-03T00:00:00.000Z",
  updatedAt: "2026-10-03T00:05:00.000Z",
};

test("a profile parses whole, and a version or count it does not know is refused", () => {
  assert.deepEqual(complexityProfileSchema.parse(profile), profile);
  assert.equal(
    complexityProfileSchema.safeParse({ ...profile, version: "profile-v0" })
      .success,
    false,
  );
  assert.equal(
    complexityProfileSchema.safeParse({
      ...profile,
      slice: { ...profile.slice, files: -1 },
    }).success,
    false,
  );
});

test("a profile stored with its bounty's type and priority reads without them", () => {
  // Profiles measured before bounties dropped them still hold the pair.
  assert.deepEqual(
    complexityProfileSchema.parse({
      ...profile,
      bounty: { issueType: "Bug", priority: null },
    }),
    profile,
  );
});

test("a stored profile carries its status, and a failure its codes", () => {
  assert.deepEqual(bountyProfileDtoSchema.parse(stored), stored);
  const failed = bountyProfileDtoSchema.parse({
    ...stored,
    status: "failed",
    errorCode: "scope_failed",
    runErrorCode: "agent_unavailable",
    profile: null,
  });
  assert.equal(failed.runErrorCode, "agent_unavailable");
  assert.equal(
    bountyProfileDtoSchema.safeParse({ ...stored, status: "measuring" })
      .success,
    false,
  );
});

test("a proposal's profiles are one per repository its work touches", () => {
  const web = { ...stored, id: "bpf_2", repository: "acme/web" };
  assert.deepEqual(
    proposalProfileResponseSchema.parse({ profiles: [stored, web] }).profiles,
    [stored, web],
  );
  // Never profiled: its work touched no repository with a snapshot.
  assert.deepEqual(proposalProfileResponseSchema.parse({ profiles: [] }), {
    profiles: [],
  });
  // An API from before several profiles answers with none of them.
  assert.deepEqual(proposalProfileResponseSchema.parse({ profile: null }), {
    profiles: [],
  });
  // One whose snapshot is gone, or written before repositories were named.
  assert.equal(
    bountyProfileDtoSchema.parse({ ...stored, repository: null }).repository,
    null,
  );
  const { repository: _unsaid, ...older } = stored;
  assert.equal(bountyProfileDtoSchema.parse(older).repository, null);
});

test("a scope submission may name a pattern to follow, or none", () => {
  const submission = {
    entryPoints: [{ path: "src/a.ts", reason: "changes" }],
    budget: { maxFiles: 10, maxDepth: 2 },
    includeInferred: false,
    seams: [],
    summary: "A change.",
    risks: [],
  };
  assert.equal(scopeSubmissionSchema.safeParse(submission).success, true);
  assert.equal(
    scopeSubmissionSchema.safeParse({ ...submission, pattern: null }).success,
    true,
  );
  assert.equal(
    scopeSubmissionSchema.safeParse({
      ...submission,
      pattern: { path: "/etc/passwd", reason: "absolute" },
    }).success,
    false,
  );
});
