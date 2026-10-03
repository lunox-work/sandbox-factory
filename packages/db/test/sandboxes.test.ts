import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApprovedTaskSnapshot, ScopeRecord } from "sandbox-factory";
import { createSandboxStore, sandboxSlug } from "../src/sandboxes.js";
import type {
  SandboxRow,
  SandboxVersionRow,
  SandboxVersionSourceRow,
} from "../src/schema.js";
import { createFakeDb, createSequencedFakeDb } from "./fake-db.js";

const now = new Date("2026-10-02T00:00:00Z");
const sandboxRow = (overrides: Partial<SandboxRow> = {}): SandboxRow => ({
  id: "sbx_1",
  organizationId: "owner",
  slug: "abc123def456",
  status: "draft",
  publicRepoId: null,
  currentVersionId: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});
const versionRow = (
  overrides: Partial<SandboxVersionRow> = {},
): SandboxVersionRow => ({
  id: "sbv_1",
  sandboxId: "sbx_1",
  version: 1,
  title: "Fix it",
  specSummary: "Summary",
  complexity: "M",
  tags: [],
  testSummary: [],
  publicBaseCommitSha: null,
  readme: null,
  languages: null,
  frozenAt: null,
  createdAt: now,
  ...overrides,
});
const approvedTask: ApprovedTaskSnapshot = {
  schemaVersion: 1,
  title: "Fix it",
  summary: "Summary",
  spec: null,
  pricing: null,
  selectedBy: "user",
  selectedAt: now.toISOString(),
  jiraIssueIds: [],
};
const scope: ScopeRecord = {
  editablePaths: ["src/app.ts"],
  generatedPaths: [],
  permittedOperations: ["edit"],
  dependencies: [],
  blockers: [],
};
const sourceRow = (
  overrides: Partial<SandboxVersionSourceRow> = {},
): SandboxVersionSourceRow => ({
  sandboxVersionId: "sbv_1",
  sourceSnapshotId: "rsn_1",
  sliceRunId: "arn_slice",
  manifestSha256: "m".repeat(64),
  contractSha256: "c".repeat(64),
  transformConfigSha256: "t".repeat(64),
  approvedTaskSha256: "a".repeat(64),
  approvedTask,
  aliasRules: [],
  dependencyChoices: {},
  acceptanceTests: [],
  fixtures: null,
  scope,
  harnessSha256: null,
  toolchainDigest: null,
  buildRunId: null,
  roundTripRunId: null,
  disclosureRunId: null,
  approvedBy: null,
  approvedAt: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});
const newVersion = {
  title: "Fix it",
  specSummary: "Summary",
  complexity: "M",
  tags: ["ts"],
  source: {
    sourceSnapshotId: "rsn_1",
    sliceRunId: "arn_slice",
    manifestSha256: "m".repeat(64),
    contractSha256: "c".repeat(64),
    transformConfigSha256: "t".repeat(64),
    approvedTaskSha256: "a".repeat(64),
    approvedTask,
    aliasRules: [
      {
        before: "Acme",
        after: "Widget",
        kind: "identifier" as const,
        paths: [],
      },
    ],
    dependencyChoices: {},
    acceptanceTests: [],
    scope,
  },
};

test("create needs an owned source repository and owned issue pointers, then writes three tables", async () => {
  const fake = createSequencedFakeDb([
    [{ role: "source", syncStatus: "ok" }],
    [{ id: "jri_1" }, { id: "jri_2" }],
    [sandboxRow()],
    [],
    [],
  ]);
  const result = await createSandboxStore(fake.db).create("owner", {
    sourceRepoId: "ghr_1",
    jiraIssueIds: ["jri_2", "jri_1", "jri_2"],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.sandbox.sourceRepoId, "ghr_1");
  assert.deepEqual(result.sandbox.jiraIssueIds, ["jri_1", "jri_2"]);
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[2]?.kind, "insert");
  assert.match(String(fake.calls[2]?.values?.["slug"]), /^[a-f0-9]{12}$/);
  assert.equal(fake.calls[3]?.values?.["sourceRepoId"], "ghr_1");
  assert.equal(fake.calls.length, 5);
  assert.deepEqual(
    await createSandboxStore(createSequencedFakeDb([[]]).db).create("owner", {
      sourceRepoId: "ghr_x",
      jiraIssueIds: [],
    }),
    { ok: false, reason: "repo_not_found" },
  );
  assert.deepEqual(
    await createSandboxStore(
      createSequencedFakeDb([[{ role: "source", syncStatus: "gone" }]]).db,
    ).create("owner", { sourceRepoId: "ghr_x", jiraIssueIds: [] }),
    { ok: false, reason: "repo_not_found" },
  );
  assert.deepEqual(
    await createSandboxStore(
      createSequencedFakeDb([[{ role: "sandbox", syncStatus: "ok" }]]).db,
    ).create("owner", { sourceRepoId: "ghr_pub", jiraIssueIds: [] }),
    { ok: false, reason: "repo_role" },
  );
  assert.deepEqual(
    await createSandboxStore(
      createSequencedFakeDb([
        [{ role: "source", syncStatus: "ok" }],
        [{ id: "jri_1" }],
      ]).db,
    ).create("owner", {
      sourceRepoId: "ghr_1",
      jiraIssueIds: ["jri_1", "jri_9"],
    }),
    { ok: false, reason: "issue_not_found" },
  );
  // No issues: the issue lookup and insert are skipped.
  const bare = createSequencedFakeDb([
    [{ role: "source", syncStatus: "ok" }],
    [sandboxRow()],
    [],
  ]);
  const created = await createSandboxStore(bare.db).create("owner", {
    sourceRepoId: "ghr_1",
    jiraIssueIds: [],
  });
  assert.equal(created.ok, true);
  assert.equal(bare.calls.length, 3);
  await assert.rejects(
    createSandboxStore(
      createSequencedFakeDb([[{ role: "source", syncStatus: "ok" }], []]).db,
    ).create("owner", { sourceRepoId: "ghr_1", jiraIssueIds: [] }),
    /returned no row/,
  );
  assert.match(sandboxSlug(), /^[a-f0-9]{12}$/);
});

test("list and get join the source and the issue pointers under the owner", async () => {
  const fake = createSequencedFakeDb([
    [
      { sandbox: sandboxRow(), sourceRepoId: "ghr_1" },
      { sandbox: sandboxRow({ id: "sbx_2" }), sourceRepoId: "ghr_2" },
    ],
    [
      { sandboxId: "sbx_1", jiraIssueId: "jri_b" },
      { sandboxId: "sbx_1", jiraIssueId: "jri_a" },
    ],
  ]);
  const list = await createSandboxStore(fake.db).list("owner");
  assert.deepEqual(
    list.map((item) => [item.id, item.sourceRepoId, item.jiraIssueIds]),
    [
      ["sbx_1", "ghr_1", ["jri_a", "jri_b"]],
      ["sbx_2", "ghr_2", []],
    ],
  );
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[0]?.ordered, true);
  assert.deepEqual(
    await createSandboxStore(createFakeDb([]).db).list("owner"),
    [],
  );
  const one = createSequencedFakeDb([
    [{ sandbox: sandboxRow(), sourceRepoId: "ghr_1" }],
    [],
  ]);
  const got = await createSandboxStore(one.db).get("owner", "sbx_1");
  assert.equal(got?.slug, "abc123def456");
  assert.equal(got?.createdAt, now.toISOString());
  assert.equal(
    await createSandboxStore(createFakeDb([]).db).get("owner", "sbx_x"),
    null,
  );
});

test("a version is cut only from a succeeded slice of the sandbox's own source, numbered after the last", async () => {
  const fake = createSequencedFakeDb([
    [{ sandbox: sandboxRow(), sourceRepoId: "ghr_1" }],
    [{ commitSha: "a".repeat(40) }],
    [{ version: 2 }],
    [versionRow({ version: 3 })],
    [sourceRow()],
  ]);
  const result = await createSandboxStore(fake.db).createVersion(
    "owner",
    "sbx_1",
    newVersion,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.version.version, 3);
  assert.equal(fake.calls[5]?.kind, "update");
  assert.ok(fake.calls[5]?.values?.["updatedAt"] instanceof Date);
  assert.equal(result.source.sourceCommitSha, "a".repeat(40));
  assert.deepEqual(result.source.aliasRules, []);
  assert.equal(fake.calls[0]?.lock, "update");
  assert.equal(fake.calls[1]?.filtered, true);
  assert.equal(fake.calls[3]?.values?.["version"], 3);
  assert.deepEqual(
    fake.calls[4]?.values?.["aliasRules"],
    newVersion.source.aliasRules,
  );
  assert.equal(fake.calls[4]?.values?.["fixtures"], null);
  assert.deepEqual(
    await createSandboxStore(createSequencedFakeDb([[]]).db).createVersion(
      "owner",
      "sbx_x",
      newVersion,
    ),
    { ok: false, reason: "not-found" },
  );
  assert.deepEqual(
    await createSandboxStore(
      createSequencedFakeDb([
        [{ sandbox: sandboxRow(), sourceRepoId: "ghr_1" }],
        [],
      ]).db,
    ).createVersion("owner", "sbx_1", newVersion),
    { ok: false, reason: "slice_mismatch" },
  );
  // A first version starts at 1 even when the max query returns nothing.
  const first = createSequencedFakeDb([
    [{ sandbox: sandboxRow(), sourceRepoId: "ghr_1" }],
    [{ commitSha: "a".repeat(40) }],
    [],
    [versionRow()],
    [sourceRow()],
  ]);
  await createSandboxStore(first.db).createVersion(
    "owner",
    "sbx_1",
    newVersion,
  );
  assert.equal(first.calls[3]?.values?.["version"], 1);
  await assert.rejects(
    createSandboxStore(
      createSequencedFakeDb([
        [{ sandbox: sandboxRow(), sourceRepoId: "ghr_1" }],
        [{ commitSha: "a".repeat(40) }],
        [{ version: 0 }],
        [],
      ]).db,
    ).createVersion("owner", "sbx_1", newVersion),
    /version insert returned no row/,
  );
  await assert.rejects(
    createSandboxStore(
      createSequencedFakeDb([
        [{ sandbox: sandboxRow(), sourceRepoId: "ghr_1" }],
        [{ commitSha: "a".repeat(40) }],
        [{ version: 0 }],
        [versionRow()],
        [],
      ]).db,
    ).createVersion("owner", "sbx_1", newVersion),
    /source insert returned no row/,
  );
});

test("versions list newest first and read with their private source", async () => {
  const fake = createFakeDb([
    { version: versionRow({ version: 2, id: "sbv_2" }) },
    { version: versionRow() },
  ]);
  const list = await createSandboxStore(fake.db).listVersions("owner", "sbx_1");
  assert.deepEqual(
    list.map((v) => v.version),
    [2, 1],
  );
  assert.equal(fake.calls[0]?.ordered, true);
  const one = await createSandboxStore(
    createFakeDb([
      {
        version: versionRow({ frozenAt: now }),
        source: sourceRow({ approvedAt: now, approvedBy: "user" }),
        commitSha: "b".repeat(40),
      },
    ]).db,
  ).getVersion("owner", "sbv_1");
  assert.equal(one?.version.frozenAt, now.toISOString());
  assert.equal(one?.source.approvedAt, now.toISOString());
  assert.equal(one?.source.sourceCommitSha, "b".repeat(40));
  assert.equal(
    await createSandboxStore(createFakeDb([]).db).getVersion("owner", "sbv_x"),
    null,
  );
});

test("a draft's transform can change and invalidates its evidence; a frozen version refuses", async () => {
  const current = {
    version: versionRow(),
    source: sourceRow({ buildRunId: "arn_old" }),
    commitSha: "a".repeat(40),
  };
  const fake = createSequencedFakeDb([
    [current],
    [versionRow({ title: "Renamed" })],
    [
      sourceRow({
        aliasRules: [
          { before: "A", after: "B", kind: "identifier", paths: [] },
        ],
        buildRunId: null,
      }),
    ],
  ]);
  const result = await createSandboxStore(fake.db).updateDraft(
    "owner",
    "sbv_1",
    {
      title: "Renamed",
      aliasRules: [{ before: "A", after: "B", kind: "identifier", paths: [] }],
      transformConfigSha256: "n".repeat(64),
    },
    now,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.version.title, "Renamed");
  assert.equal(result.source.buildRunId, null);
  assert.equal(fake.calls[0]?.lock, "update");
  assert.equal(fake.calls[1]?.kind, "update");
  assert.equal(fake.calls[1]?.filtered, true);
  assert.equal(fake.calls[2]?.values?.["buildRunId"], null);
  assert.equal(fake.calls[2]?.values?.["approvedBy"], null);
  assert.equal(fake.calls[2]?.values?.["updatedAt"], now);
  // The parent sandbox moves too, for listings that sort by it.
  assert.equal(fake.calls[3]?.kind, "update");
  assert.deepEqual(fake.calls[3]?.values, { updatedAt: now });
  assert.equal(fake.calls.length, 4);
  // A transform merged onto a stale read is refused, not written over.
  const stale = createSequencedFakeDb([[current]]);
  assert.deepEqual(
    await createSandboxStore(stale.db).updateDraft("owner", "sbv_1", {
      aliasRules: [],
      transformConfigSha256: "n".repeat(64),
      expectedTransformConfigSha256: "o".repeat(64),
    }),
    { ok: false, reason: "conflict" },
  );
  assert.equal(stale.calls.length, 1);
  const fresh = createSequencedFakeDb([[current], [sourceRow()]]);
  const merged = await createSandboxStore(fresh.db).updateDraft(
    "owner",
    "sbv_1",
    {
      acceptanceTests: [],
      transformConfigSha256: "n".repeat(64),
      expectedTransformConfigSha256: "t".repeat(64),
    },
  );
  assert.equal(merged.ok, true);
  assert.equal(fresh.calls[1]?.values?.["harnessSha256"], null);
  // Nothing to change: one read, no writes.
  const empty = createSequencedFakeDb([[current]]);
  const same = await createSandboxStore(empty.db).updateDraft(
    "owner",
    "sbv_1",
    {},
  );
  assert.equal(same.ok && same.version.id, "sbv_1");
  assert.equal(empty.calls.length, 1);
  assert.deepEqual(
    await createSandboxStore(createSequencedFakeDb([[]]).db).updateDraft(
      "owner",
      "sbv_x",
      { title: "x" },
    ),
    { ok: false, reason: "not-found" },
  );
  assert.deepEqual(
    await createSandboxStore(
      createSequencedFakeDb([
        [{ ...current, version: versionRow({ frozenAt: now }) }],
      ]).db,
    ).updateDraft("owner", "sbv_1", { title: "x" }),
    { ok: false, reason: "frozen" },
  );
  // A freeze that lands between the read and the write is still refused.
  assert.deepEqual(
    await createSandboxStore(
      createSequencedFakeDb([[current], []]).db,
    ).updateDraft("owner", "sbv_1", { title: "x" }),
    { ok: false, reason: "frozen" },
  );
  assert.deepEqual(
    await createSandboxStore(
      createSequencedFakeDb([[current], []]).db,
    ).updateDraft("owner", "sbv_1", { scope }),
    { ok: false, reason: "not-found" },
  );
});

test("fixtures are part of the transform: replacing or dropping them clears evidence", async () => {
  const fixtures = {
    fixtureRunId: "arn_fixtures",
    fixtures: [
      {
        module: "src/db.ts",
        symbol: "db",
        member: "users.find",
        call: "call" as const,
        implementation: "async (id) => ({ id })",
        reason: "a known user",
      },
    ],
    scenario: "console.log(1);",
  };
  const current = {
    version: versionRow(),
    source: sourceRow({ harnessSha256: "h".repeat(64) }),
    commitSha: "a".repeat(40),
  };
  const fake = createSequencedFakeDb([[current], [sourceRow({ fixtures })]]);
  const result = await createSandboxStore(fake.db).updateDraft(
    "owner",
    "sbv_1",
    { fixtures, transformConfigSha256: "n".repeat(64) },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.source.fixtures, fixtures);
  assert.deepEqual(fake.calls[1]?.values?.["fixtures"], fixtures);
  assert.equal(fake.calls[1]?.values?.["harnessSha256"], null);
  const dropped = createSequencedFakeDb([[current], [sourceRow()]]);
  const cleared = await createSandboxStore(dropped.db).updateDraft(
    "owner",
    "sbv_1",
    { fixtures: null },
  );
  assert.equal(cleared.ok && cleared.source.fixtures, null);
  assert.equal(dropped.calls[1]?.values?.["fixtures"], null);
  assert.equal(dropped.calls[1]?.values?.["buildRunId"], null);
});

test("recording a build clears the old build's evidence, and refuses a changed transform", async () => {
  const current = {
    version: versionRow(),
    source: sourceRow({
      buildRunId: "arn_old",
      harnessSha256: "h".repeat(64),
      toolchainDigest: "d".repeat(64),
    }),
    commitSha: "a".repeat(40),
  };
  const fake = createSequencedFakeDb([
    [current],
    [sourceRow({ buildRunId: "arn_new" })],
  ]);
  const recorded = await createSandboxStore(fake.db).recordBuild(
    "owner",
    "sbv_1",
    "arn_new",
    "t".repeat(64),
    now,
  );
  assert.equal(recorded.ok && recorded.source.buildRunId, "arn_new");
  assert.equal(fake.calls[0]?.lock, "update");
  assert.equal(fake.calls[1]?.values?.["buildRunId"], "arn_new");
  assert.equal(fake.calls[1]?.values?.["harnessSha256"], null);
  assert.equal(fake.calls[1]?.values?.["roundTripRunId"], null);
  assert.deepEqual(fake.calls[2]?.values, { updatedAt: now });
  const store = (rows: readonly (readonly unknown[])[]) =>
    createSandboxStore(createSequencedFakeDb(rows).db);
  assert.deepEqual(
    await store([[current]]).recordBuild(
      "owner",
      "sbv_1",
      "arn_new",
      "x".repeat(64),
    ),
    { ok: false, reason: "conflict" },
  );
  assert.deepEqual(
    await store([
      [{ ...current, version: versionRow({ frozenAt: now }) }],
    ]).recordBuild("owner", "sbv_1", "arn_new", "t".repeat(64)),
    { ok: false, reason: "frozen" },
  );
  assert.deepEqual(
    await store([[]]).recordBuild("owner", "sbv_x", "arn_new", "t".repeat(64)),
    { ok: false, reason: "not-found" },
  );
  assert.deepEqual(
    await store([[current], []]).recordBuild(
      "owner",
      "sbv_1",
      "arn_new",
      "t".repeat(64),
    ),
    { ok: false, reason: "not-found" },
  );
});

test("a build's output is kept only while the draft still points at that build", async () => {
  const current = {
    version: versionRow(),
    source: sourceRow({ buildRunId: "arn_build" }),
    commitSha: "a".repeat(40),
  };
  const output = {
    harnessSha256: "h".repeat(64),
    toolchainDigest: "d".repeat(64),
  };
  const fake = createSequencedFakeDb([[current], []]);
  assert.equal(
    await createSandboxStore(fake.db).recordBuildOutput(
      "owner",
      "sbv_1",
      "arn_build",
      output,
      now,
    ),
    true,
  );
  assert.equal(fake.calls[0]?.lock, "update");
  assert.deepEqual(fake.calls[1]?.values, { ...output, updatedAt: now });
  assert.deepEqual(fake.calls[2]?.values, { updatedAt: now });
  for (const rows of [
    [],
    [{ ...current, source: sourceRow({ buildRunId: "arn_newer" }) }],
    [{ ...current, version: versionRow({ frozenAt: now }) }],
  ]) {
    const refused = createSequencedFakeDb([rows]);
    assert.equal(
      await createSandboxStore(refused.db).recordBuildOutput(
        "owner",
        "sbv_1",
        "arn_build",
        output,
      ),
      false,
    );
    assert.equal(refused.calls.length, 1);
  }
});

test("replay context says whether the original source and slice are still there", async () => {
  const store = createSandboxStore(
    createSequencedFakeDb([
      [{ source: sourceRow() }],
      [{ commitSha: "a".repeat(40), syncStatus: "gone" }],
      [{ status: "succeeded", artifacts: "3" }],
    ]).db,
  );
  const context = await store.replayContext("owner", "sbv_1");
  assert.deepEqual(context?.snapshot, {
    commitSha: "a".repeat(40),
    repoGone: true,
  });
  assert.deepEqual(context?.sliceRun, {
    status: "succeeded",
    artifactsPresent: true,
  });
  assert.equal(context?.source.sourceCommitSha, "a".repeat(40));
  const missing = await createSandboxStore(
    createSequencedFakeDb([[{ source: sourceRow() }], [], []]).db,
  ).replayContext("owner", "sbv_1");
  assert.equal(missing?.snapshot, null);
  assert.equal(missing?.sliceRun, null);
  assert.equal(missing?.source.sourceCommitSha, "");
  assert.equal(
    await createSandboxStore(createFakeDb([]).db).replayContext(
      "owner",
      "sbv_x",
    ),
    null,
  );
});
