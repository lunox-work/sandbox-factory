import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ApplyRubricInput,
  ProposalMutationResult,
  StoredBountyProfile,
  StoredBountyProposal,
  StoredBountySpec,
} from "@sandbox-factory/db";
import {
  COMPLEXITY_PROFILE_VERSION,
  DEFAULT_RATE_CARD,
  assessRubric,
  stepUp,
  type ComplexityProfile,
  type SpecDraft,
} from "sandbox-factory";

import {
  RubricPricer,
  rubricCode,
  rubricPrice,
  weightPointsOf,
} from "../src/pricing/rubric.js";

const OWNER = "org_1";

const draft: SpecDraft = {
  feature: "Interview invitations",
  background: [],
  scenarios: [
    {
      id: "s1",
      kind: "happy",
      title: "One invitation",
      steps: [
        { keyword: "When", text: "the interview is saved" },
        { keyword: "Then", text: "one email is sent" },
        { keyword: "And", text: "it names the time" },
      ],
      origin: "draft",
      weight: "moderate",
    },
    {
      id: "s2",
      kind: "recovery",
      title: "A retry sends no duplicate",
      steps: [{ keyword: "Then", text: "exactly one email" }],
      origin: "draft",
      weight: "heavy",
    },
  ],
  openQuestions: [],
  assumptions: [],
};

const measured: ComplexityProfile = {
  version: COMPLEXITY_PROFILE_VERSION,
  slice: {
    files: 4,
    bytes: 20_000,
    modules: ["src/mailer", "src/scheduler"],
    stubCoverage: "full",
    blockers: 0,
    ready: true,
  },
  touchedModules: ["src/mailer", "src/scheduler"],
  externals: { services: ["email"], environment: 1, seams: 0 },
  spec: {
    scenarios: 2,
    kinds: {
      happy: 1,
      boundary: 0,
      unhappy: 0,
      recovery: 1,
      permission: 0,
      concurrency: 0,
      "non-functional": 0,
    },
    openQuestions: 0,
    assumptions: 0,
  },
  tests: { files: 1, untestedModules: ["src/scheduler"] },
  pattern: null,
  nonFunctional: { scenarios: 0, migrations: false, ci: true },
  risks: [],
};

const step = stepUp("M", draft, draft);
assert.ok(step !== null);

function proposal(
  overrides: Partial<StoredBountyProposal> = {},
): StoredBountyProposal {
  return {
    id: "bpr_1",
    organizationId: OWNER,
    runId: "brn_1",
    bountyId: "bty_1",
    issueKey: null,
    title: "Invitations",
    specHash: "a".repeat(64),
    specHashVersion: 2,
    rateCard: { ...DEFAULT_RATE_CARD, revision: 1 },
    modelComplexity: "M",
    modelConfidence: "high",
    modelRationale: "Two modules.",
    unsizedReason: null,
    inputTruncated: false,
    actualModel: "model",
    promptVersion: "v1",
    complexity: "M",
    sizedBy: "model",
    resizedBy: null,
    resizedAt: null,
    amountMinor: DEFAULT_RATE_CARD.mMinor,
    currency: "USD",
    status: "proposed",
    revision: 3,
    version: 0,
    versionedAt: null,
    specRevision: 2,
    step,
    rubric: null,
    repositories: [],
    contextVersions: { jira: null, github: null },
    decidedAt: null,
    decidedBy: null,
    decisionDeliveryPolicy: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function profile(
  overrides: Partial<StoredBountyProfile> = {},
): StoredBountyProfile {
  return {
    id: "bpf_1",
    organizationId: OWNER,
    proposalId: "bpr_1",
    specRevision: 2,
    specHash: "a".repeat(64),
    snapshotId: "rsn_1",
    repository: "acme/app",
    status: "ready",
    errorCode: null,
    runErrorCode: null,
    scopeRunId: "arn_scope",
    sliceRunId: "arn_slice",
    profile: measured,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function harness(
  stored: StoredBountyProposal | null = proposal(),
  options: {
    conflicts?: number;
    specs?: boolean;
    throws?: boolean;
    /** Every profile of the proposal; its revision's are read. */
    profiles?: StoredBountyProfile[];
  } = {},
) {
  let current = stored;
  const profiles = options.profiles ?? [profile()];
  const revisions: number[] = [];
  let conflicts = options.conflicts ?? 0;
  const writes: { revision: number; input: ApplyRubricInput }[] = [];
  const errors: string[] = [];
  const pricer = new RubricPricer({
    proposals: {
      get: async () => {
        if (options.throws === true) throw new Error("db down");
        return current;
      },
      applyRubric: async (
        _owner,
        _id,
        revision,
        input,
      ): Promise<ProposalMutationResult> => {
        writes.push({ revision, input });
        if (current === null) return { ok: false, reason: "not-found" };
        if (conflicts > 0) {
          conflicts -= 1;
          // Someone else wrote first: the next read sees their revision.
          current = { ...current, revision: current.revision + 1 };
          return { ok: false, reason: "changed", current };
        }
        current = { ...current, rubric: input.rubric };
        return { ok: true, proposal: current };
      },
    },
    profiles: {
      forRevision: async (_owner, proposalId, revision) => {
        revisions.push(revision);
        return profiles.filter(
          (stored) =>
            stored.proposalId === proposalId &&
            stored.specRevision === revision,
        );
      },
    },
    specs: {
      get: async (_owner, proposalId, revision) =>
        options.specs === false
          ? null
          : ({ proposalId, revision, draft } as unknown as StoredBountySpec),
    },
    onError: (code) => errors.push(code),
  });
  return { pricer, writes, errors, revisions };
}

test("a measured profile sizes a model-sized proposal by the rubric", async () => {
  const h = harness();
  await h.pricer.settled(OWNER, profile());
  assert.equal(h.writes.length, 1);
  const [write] = h.writes;
  assert.equal(write?.revision, 3);
  const expected = assessRubric({
    spec: draft,
    code: {
      status: "measured",
      profiles: [{ repository: "acme/app", profile: measured }],
      specRevision: 2,
    },
  });
  assert.deepEqual(write?.input.rubric, expected);
  // 2 + 4 scenario points, 2 + 1 for tests, 1 + 3 + 2 + 2 for code = 17: M.
  assert.equal(expected.points, 17);
  assert.deepEqual(write?.input.price, {
    complexity: "M",
    amountMinor: DEFAULT_RATE_CARD.mMinor,
    currency: "USD",
  });
  assert.deepEqual(h.errors, []);
});

test("a reviewer's size stands; the rubric is recorded beside it", async () => {
  const h = harness(proposal({ sizedBy: "reviewer", complexity: "L" }));
  await h.pricer.settled(OWNER, profile());
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0]?.input.price, null);
  assert.equal(h.writes[0]?.input.rubric.size, "M");
});

test("a failed profile is recorded as failed, and sizes nothing", async () => {
  const failed = profile({
    status: "failed",
    profile: null,
    errorCode: "scope_failed",
  });
  const h = harness(proposal(), { profiles: [failed] });
  await h.pricer.settled(OWNER, failed);
  assert.equal(h.writes[0]?.input.price, null);
  assert.equal(h.writes[0]?.input.rubric.code.status, "failed");
  assert.equal(h.writes[0]?.input.rubric.size, null);
});

test("approved, re-priced, specless and missing proposals are left alone", async () => {
  for (const stored of [
    null,
    proposal({ status: "approved" }),
    proposal({ specRevision: null }),
    // Re-priced since: the profile was measured for an older spec.
    proposal({ specRevision: 1 }),
  ]) {
    const h = harness(stored);
    await h.pricer.settled(OWNER, profile());
    assert.deepEqual(h.writes, []);
  }
  const noSpec = harness(proposal(), { specs: false });
  await noSpec.pricer.settled(OWNER, profile());
  assert.deepEqual(noSpec.writes, []);
});

test("a profile measured for an earlier spec scores the proposal's current one", async () => {
  const h = harness(proposal({ specRevision: 4 }));
  await h.pricer.settled(OWNER, profile({ specRevision: 2 }));
  assert.equal(h.writes[0]?.input.rubric.code.specRevision, 2);
  assert.equal(h.writes[0]?.input.price?.complexity, "M");
  // Its own revision's profiles, not the proposal's.
  assert.deepEqual(h.revisions, [2]);
});

test("the code is scored over every repository the work touches, once each has settled", async () => {
  const app = profile();
  const web = profile({
    id: "bpf_2",
    snapshotId: "rsn_2",
    repository: "acme/web",
    status: "slicing",
    profile: null,
  });
  // Another revision's profile is not this one's.
  const older = profile({ id: "bpf_0", specRevision: 1, status: "failed" });

  const waiting = harness(proposal(), { profiles: [app, web, older] });
  await waiting.pricer.settled(OWNER, app);
  assert.equal(waiting.writes[0]?.input.rubric.code.status, "pending");
  assert.equal(waiting.writes[0]?.input.rubric.size, null);
  assert.equal(waiting.writes[0]?.input.price, null);

  const settled = { ...web, status: "ready" as const, profile: measured };
  const both = harness(proposal(), { profiles: [app, settled, older] });
  await both.pricer.settled(OWNER, settled);
  const rubric = both.writes[0]?.input.rubric;
  assert.ok(rubric !== undefined);
  assert.equal(rubric.code.status, "measured");
  const code = rubric.dimensions.find(({ id }) => id === "code");
  const repositories = code?.factors.find(({ id }) => id === "repositories");
  // The second repository adds the integration across the two.
  assert.equal(repositories?.points, 4);
  assert.match(repositories?.evidence ?? "", /acme\/app/);
  assert.match(repositories?.evidence ?? "", /acme\/web/);
  assert.ok(rubric.points > (waiting.writes[0]?.input.rubric.points ?? 0));
  assert.deepEqual(
    both.writes[0]?.input.price,
    rubricPrice(rubric, proposal()),
  );
});

test("a write that meets a concurrent change is tried again, a few times", async () => {
  const once = harness(proposal(), { conflicts: 1 });
  await once.pricer.settled(OWNER, profile());
  assert.deepEqual(
    once.writes.map(({ revision }) => revision),
    [3, 4],
  );
  assert.deepEqual(once.errors, []);

  // Three, and once more for the one profile whose settle could have
  // written first; then it is reported, as nothing comes to correct it.
  const always = harness(proposal(), { conflicts: 20 });
  await always.pricer.settled(OWNER, profile());
  assert.equal(always.writes.length, 4);
  assert.deepEqual(always.errors, ["bounty_rubric_contended"]);
});

test("a revision with several profiles is tried again once for each", async () => {
  const profiles = ["bpf_1", "bpf_2", "bpf_3"].map((id) => profile({ id }));
  const h = harness(proposal(), { conflicts: 20, profiles });
  await h.pricer.settled(OWNER, profile());
  assert.equal(h.writes.length, 6);
  assert.deepEqual(h.errors, ["bounty_rubric_contended"]);
});

test("a failure is reported, never thrown", async () => {
  const h = harness(proposal(), { throws: true });
  await h.pricer.settled(OWNER, profile());
  assert.deepEqual(h.errors, ["bounty_rubric_failed"]);
});

test("the code the rubric reads follows its profiles' statuses", () => {
  assert.deepEqual(rubricCode([], "pending"), { status: "pending" });
  assert.deepEqual(rubricCode([], "unavailable"), { status: "unavailable" });
  assert.deepEqual(rubricCode([profile()], "unavailable"), {
    status: "measured",
    profiles: [{ repository: "acme/app", profile: measured }],
    specRevision: 2,
  });
  assert.deepEqual(
    rubricCode([profile({ status: "failed", profile: null })], "pending"),
    { status: "failed" },
  );
  for (const status of ["queued", "scoping", "slicing"] as const)
    assert.deepEqual(
      rubricCode([profile({ status, profile: null })], "unavailable"),
      { status: "pending" },
    );

  const web = profile({ id: "bpf_2", repository: "acme/web" });
  // One failed fails the code, whatever the rest say.
  assert.deepEqual(
    rubricCode(
      [profile(), web, profile({ status: "failed", profile: null })],
      "pending",
    ),
    { status: "failed" },
  );
  // One still in flight leaves it pending.
  assert.deepEqual(
    rubricCode(
      [profile(), profile({ status: "slicing", profile: null })],
      "unavailable",
    ),
    { status: "pending" },
  );
  // Every one ready is measured, a repository removed since among them.
  assert.deepEqual(
    rubricCode([profile(), web, profile({ repository: null })], "pending"),
    {
      status: "measured",
      profiles: [
        { repository: "acme/app", profile: measured },
        { repository: "acme/web", profile: measured },
        { repository: "a removed repository", profile: measured },
      ],
      specRevision: 2,
    },
  );
});

test("weights come from the step, then the last assessment, then the defaults", () => {
  const weights = { light: 3, moderate: 3, heavy: 3 };
  assert.deepEqual(
    weightPointsOf({
      step: { ...step, settings: { ...step.settings, weightPoints: weights } },
      rubric: null,
    }),
    weights,
  );
  const rubric = assessRubric({
    spec: draft,
    code: { status: "pending" },
    weightPoints: weights,
  });
  assert.deepEqual(weightPointsOf({ step: null, rubric }), weights);
  assert.deepEqual(weightPointsOf({ step: null, rubric: null }), {
    light: 1,
    moderate: 2,
    heavy: 4,
  });
});

test("an assessment prices on the proposal's card only once it has a size", () => {
  const card = proposal();
  assert.equal(
    rubricPrice(
      assessRubric({ spec: draft, code: { status: "pending" } }),
      card,
    ),
    null,
  );
  assert.deepEqual(
    rubricPrice(
      assessRubric({
        spec: draft,
        code: {
          status: "measured",
          profiles: [{ repository: "acme/app", profile: measured }],
          specRevision: 2,
        },
      }),
      card,
    ),
    { complexity: "M", amountMinor: DEFAULT_RATE_CARD.mMinor, currency: "USD" },
  );
});
