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
  bountyId: "bty_1",
  slug: "abc123def456",
  status: "draft",
  publicRepoId: null,
  currentVersionId: null,
  expiresAt: null,
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
const approvedPricing = {
  proposalId: "bpr_1",
  proposalRevision: 2,
  complexity: "M",
  amountMinor: 50_000,
  currency: "USD",
  status: "approved",
  decidedAt: now.toISOString(),
} as const;
const approvedTask: ApprovedTaskSnapshot = {
  schemaVersion: 3,
  title: "Fix it",
  summary: "Summary",
  spec: null,
  pricing: approvedPricing,
  selectedBy: "user",
  selectedAt: now.toISOString(),
  bountyId: "bty_1",
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
  starterRunId: null,
  starterSha256: null,
  transformConfigSha256: "t".repeat(64),
  approvedTaskSha256: "a".repeat(64),
  approvedTask,
  proposalVersion: 1,
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
    proposalVersion: 1,
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

test("a sandbox is made for an owned bounty, with its repository when one is named", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "bty_1" }],
    [],
    [{ role: "source", syncStatus: "ok" }],
    [sandboxRow()],
    [],
  ]);
  const result = await createSandboxStore(fake.db).create("owner", {
    bountyId: "bty_1",
    sourceRepoId: "ghr_1",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.sandbox.bountyId, "bty_1");
  assert.equal(result.sandbox.sourceRepoId, "ghr_1");
  // The bounty is held against a removal for as long as this runs.
  assert.equal(fake.calls[0]?.lock, "key share");
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[2]?.filtered, true);
  assert.equal(fake.calls[3]?.kind, "insert");
  assert.equal(fake.calls[3]?.values?.["bountyId"], "bty_1");
  assert.match(String(fake.calls[3]?.values?.["slug"]), /^[a-f0-9]{12}$/);
  assert.equal(fake.calls[4]?.values?.["sourceRepoId"], "ghr_1");
  assert.equal(fake.calls.length, 5);
  assert.match(sandboxSlug(), /^[a-f0-9]{12}$/);
});

test("a sandbox needs no repository: none is looked up and none is linked", async () => {
  const bare = createSequencedFakeDb([[{ id: "bty_1" }], [], [sandboxRow()]]);
  const created = await createSandboxStore(bare.db).create("owner", {
    bountyId: "bty_1",
    sourceRepoId: null,
  });
  assert.equal(created.ok, true);
  if (created.ok) assert.equal(created.sandbox.sourceRepoId, null);
  assert.equal(bare.calls.length, 3);
  await assert.rejects(
    createSandboxStore(
      createSequencedFakeDb([[{ id: "bty_1" }], [], []]).db,
    ).create("owner", { bountyId: "bty_1", sourceRepoId: null }),
    /returned no row/,
  );
});

test("a sandbox is refused for another owner's bounty, a second one, or an unusable repository", async () => {
  const refused = async (
    responses: readonly (readonly unknown[] | Error)[],
    sourceRepoId: string | null = "ghr_1",
  ) =>
    createSandboxStore(createSequencedFakeDb(responses).db).create("owner", {
      bountyId: "bty_1",
      sourceRepoId,
    });
  assert.deepEqual(await refused([[]]), {
    ok: false,
    reason: "bounty_not_found",
  });
  assert.deepEqual(await refused([[{ id: "bty_1" }], [{ id: "sbx_0" }]]), {
    ok: false,
    reason: "bounty_has_sandbox",
  });
  assert.deepEqual(await refused([[{ id: "bty_1" }], [], []]), {
    ok: false,
    reason: "repo_not_found",
  });
  assert.deepEqual(
    await refused([
      [{ id: "bty_1" }],
      [],
      [{ role: "source", syncStatus: "gone" }],
    ]),
    { ok: false, reason: "repo_not_found" },
  );
  assert.deepEqual(
    await refused([
      [{ id: "bty_1" }],
      [],
      [{ role: "sandbox", syncStatus: "ok" }],
    ]),
    { ok: false, reason: "repo_role" },
  );
  // Two creates at once: the loser meets the winner's unique row.
  const taken = Object.assign(new Error("duplicate"), { code: "23505" });
  assert.deepEqual(await refused([[{ id: "bty_1" }], [], taken], null), {
    ok: false,
    reason: "bounty_has_sandbox",
  });
  const down = new Error("database down");
  await assert.rejects(refused([[{ id: "bty_1" }], [], down], null), /down/);
});

test("a sandbox made without a repository has one linked once", async () => {
  const fake = createSequencedFakeDb([
    [sandboxRow()],
    [],
    [{ role: "source", syncStatus: "ok" }],
    [],
  ]);
  const linked = await createSandboxStore(fake.db).linkSource(
    "owner",
    "sbx_1",
    "ghr_1",
  );
  assert.deepEqual(
    linked.ok ? [linked.sandbox.id, linked.sandbox.sourceRepoId] : linked,
    ["sbx_1", "ghr_1"],
  );
  // Locked as cutting a version locks it, and its link read after the lock,
  // so one linked meanwhile is seen rather than met as a duplicate key.
  assert.equal(fake.calls[0]?.lock, "update");
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[1]?.lock, undefined);
  assert.equal(fake.calls[2]?.filtered, true);
  assert.equal(fake.calls[3]?.kind, "insert");
  assert.deepEqual(fake.calls[3]?.values, {
    sandboxId: "sbx_1",
    sourceRepoId: "ghr_1",
  });

  // The repository it already has is no change, and writes nothing.
  const again = createSequencedFakeDb([
    [sandboxRow()],
    [{ sourceRepoId: "ghr_1" }],
  ]);
  assert.equal(
    (await createSandboxStore(again.db).linkSource("owner", "sbx_1", "ghr_1"))
      .ok,
    true,
  );
  assert.equal(again.calls.length, 2);

  const link = (responses: readonly (readonly unknown[])[]) =>
    createSandboxStore(createSequencedFakeDb(responses).db).linkSource(
      "owner",
      "sbx_1",
      "ghr_1",
    );
  // Its versions are bound to the repository it has.
  assert.deepEqual(await link([[sandboxRow()], [{ sourceRepoId: "ghr_2" }]]), {
    ok: false,
    reason: "source_linked",
  });
  assert.deepEqual(await link([[]]), { ok: false, reason: "not-found" });
  assert.deepEqual(await link([[sandboxRow()], [], []]), {
    ok: false,
    reason: "repo_not_found",
  });
  assert.deepEqual(
    await link([[sandboxRow()], [], [{ role: "source", syncStatus: "gone" }]]),
    { ok: false, reason: "repo_not_found" },
  );
  assert.deepEqual(
    await link([[sandboxRow()], [], [{ role: "sandbox", syncStatus: "ok" }]]),
    { ok: false, reason: "repo_role" },
  );
});

test("list and get read each sandbox with its bounty and its repository, if any", async () => {
  const fake = createSequencedFakeDb([
    [
      { sandbox: sandboxRow(), sourceRepoId: "ghr_1" },
      {
        sandbox: sandboxRow({ id: "sbx_2", bountyId: "bty_2" }),
        sourceRepoId: null,
      },
    ],
  ]);
  const list = await createSandboxStore(fake.db).list("owner");
  assert.deepEqual(
    list.map((item) => [item.id, item.bountyId, item.sourceRepoId]),
    [
      ["sbx_1", "bty_1", "ghr_1"],
      ["sbx_2", "bty_2", null],
    ],
  );
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[0]?.ordered, true);
  assert.deepEqual(
    await createSandboxStore(createFakeDb([]).db).list("owner"),
    [],
  );
  const one = createSequencedFakeDb([
    [{ sandbox: sandboxRow(), sourceRepoId: "ghr_1" }],
  ]);
  const got = await createSandboxStore(one.db).get("owner", "sbx_1");
  assert.equal(got?.slug, "abc123def456");
  assert.equal(got?.bountyId, "bty_1");
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
  // Without a repository there is nothing to have sliced.
  assert.deepEqual(
    await createSandboxStore(
      createSequencedFakeDb([[{ sandbox: sandboxRow(), sourceRepoId: null }]])
        .db,
    ).createVersion("owner", "sbx_1", newVersion),
    { ok: false, reason: "no_source" },
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

/** A generated version's source: a starter run where the slice was. */
const generatedRow = (overrides: Partial<SandboxVersionSourceRow> = {}) =>
  sourceRow({
    sourceSnapshotId: null,
    sliceRunId: null,
    manifestSha256: null,
    contractSha256: null,
    starterRunId: "arn_starter",
    buildRunId: "arn_starter",
    ...overrides,
  });
const starterVersion = {
  ...newVersion,
  id: "sbv_new",
  source: {
    origin: "starter" as const,
    starterRunId: "arn_starter",
    transformConfigSha256: "t".repeat(64),
    approvedTaskSha256: "a".repeat(64),
    approvedTask,
    proposalVersion: 1,
    aliasRules: [],
    dependencyChoices: {},
    acceptanceTests: [],
    scope,
  },
};

test("a version is generated only without a repository, from the owner's run queued for it", async () => {
  const fake = createSequencedFakeDb([
    [{ sandbox: sandboxRow(), sourceRepoId: null }],
    [{ id: "arn_starter" }],
    [],
    [{ version: 1 }],
    [versionRow({ id: "sbv_new", version: 2 })],
    [generatedRow({ sandboxVersionId: "sbv_new" })],
  ]);
  const result = await createSandboxStore(fake.db).createVersion(
    "owner",
    "sbx_1",
    starterVersion,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.source.origin, "starter");
  assert.equal(result.source.sourceCommitSha, null);
  assert.equal(result.source.starterRunId, "arn_starter");
  // The run was looked up under the owner, and is the version's build too.
  assert.equal(fake.calls[1]?.filtered, true);
  // Another version's starter under way was looked for, under the owner.
  assert.equal(fake.calls[2]?.filtered, true);
  assert.equal(fake.calls[2]?.limited, 1);
  assert.equal(fake.calls[4]?.values?.["id"], "sbv_new");
  assert.equal(fake.calls[5]?.values?.["starterRunId"], "arn_starter");
  assert.equal(fake.calls[5]?.values?.["buildRunId"], "arn_starter");
  assert.equal(fake.calls[5]?.values?.["sliceRunId"], undefined);
  // A sandbox with a repository slices its versions instead.
  assert.deepEqual(
    await createSandboxStore(
      createSequencedFakeDb([
        [{ sandbox: sandboxRow(), sourceRepoId: "ghr_1" }],
      ]).db,
    ).createVersion("owner", "sbx_1", starterVersion),
    { ok: false, reason: "source_linked" },
  );
  // A run that is not the owner's, or was queued for another version.
  assert.deepEqual(
    await createSandboxStore(
      createSequencedFakeDb([
        [{ sandbox: sandboxRow(), sourceRepoId: null }],
        [],
      ]).db,
    ).createVersion("owner", "sbx_1", starterVersion),
    { ok: false, reason: "starter_mismatch" },
  );
  // A second Generate while the first version's starter is still queued
  // or running makes no second version.
  const busy = createSequencedFakeDb([
    [{ sandbox: sandboxRow(), sourceRepoId: null }],
    [{ id: "arn_starter" }],
    [{ id: "arn_earlier" }],
  ]);
  assert.deepEqual(
    await createSandboxStore(busy.db).createVersion(
      "owner",
      "sbx_1",
      starterVersion,
    ),
    { ok: false, reason: "starter_in_progress" },
  );
  assert.equal(busy.calls[0]?.lock, "update");
  assert.equal(busy.calls.length, 3);
});

test("a starter run's output settles on its draft only while the draft still points at it", async () => {
  const current = {
    version: versionRow(),
    source: generatedRow(),
    commitSha: null,
  };
  const output = {
    starterSha256: "s".repeat(64),
    aliasRules: [
      {
        before: "AcmeCart",
        after: "Cart",
        kind: "identifier" as const,
        paths: [],
      },
    ],
    acceptanceTests: [
      {
        path: "tests/private/a.test.ts",
        text: "",
        expectedBaseline: "fail" as const,
      },
    ],
    scope,
    transformConfigSha256: "n".repeat(64),
    build: { harnessSha256: "h".repeat(64), toolchainDigest: "d".repeat(64) },
  };
  const fake = createSequencedFakeDb([[current], [], []]);
  assert.equal(
    await createSandboxStore(fake.db).recordStarterOutput(
      "owner",
      "sbv_1",
      "arn_starter",
      output,
      now,
    ),
    true,
  );
  assert.equal(fake.calls[0]?.lock, "update");
  assert.deepEqual(fake.calls[1]?.values, {
    starterSha256: output.starterSha256,
    aliasRules: output.aliasRules,
    acceptanceTests: output.acceptanceTests,
    scope,
    transformConfigSha256: output.transformConfigSha256,
    harnessSha256: "h".repeat(64),
    toolchainDigest: "d".repeat(64),
    updatedAt: now,
  });
  // A build that was not ready proves nothing.
  const unready = createSequencedFakeDb([[current], [], []]);
  await createSandboxStore(unready.db).recordStarterOutput(
    "owner",
    "sbv_1",
    "arn_starter",
    { ...output, build: null },
  );
  assert.equal(unready.calls[1]?.values?.["harnessSha256"], null);
  assert.equal(unready.calls[1]?.values?.["toolchainDigest"], null);
  for (const rows of [
    [],
    [{ ...current, source: generatedRow({ starterRunId: "arn_other" }) }],
    [{ ...current, source: generatedRow({ buildRunId: "arn_rebuilt" }) }],
    [{ ...current, version: versionRow({ frozenAt: now }) }],
  ]) {
    const refused = createSequencedFakeDb([rows]);
    assert.equal(
      await createSandboxStore(refused.db).recordStarterOutput(
        "owner",
        "sbv_1",
        "arn_starter",
        output,
      ),
      false,
    );
    assert.equal(refused.calls.length, 1);
  }
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

test("recording a build clears the old build's evidence but not its own, and refuses and cancels a changed or frozen one", async () => {
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
  // A refused build is cancelled while it is still queued, so it gives back
  // its active slot; the draft is not touched.
  for (const [rows, expectedHash, reason] of [
    [[current], "x".repeat(64), "conflict"],
    [
      [{ ...current, version: versionRow({ frozenAt: now }) }],
      "t".repeat(64),
      "frozen",
    ],
  ] as const) {
    const refused = createSequencedFakeDb([rows]);
    assert.deepEqual(
      await createSandboxStore(refused.db).recordBuild(
        "owner",
        "sbv_1",
        "arn_new",
        expectedHash,
        now,
      ),
      { ok: false, reason },
    );
    assert.equal(refused.calls.length, 2);
    assert.equal(refused.calls[1]?.kind, "update");
    assert.equal(refused.calls[1]?.filtered, true);
    assert.deepEqual(refused.calls[1]?.values, {
      status: "failed",
      errorCode: "cancelled",
      errorDetail: null,
      finishedAt: now,
    });
  }
  assert.deepEqual(
    await store([[]]).recordBuild("owner", "sbv_x", "arn_new", "t".repeat(64)),
    { ok: false, reason: "not-found" },
  );
  // The build the draft already points at, asked for again, keeps what it
  // proved: nothing is written.
  const same = createSequencedFakeDb([[current]]);
  const kept = await createSandboxStore(same.db).recordBuild(
    "owner",
    "sbv_1",
    "arn_old",
    "t".repeat(64),
    now,
  );
  assert.equal(kept.ok && kept.source.harnessSha256, "h".repeat(64));
  assert.equal(kept.ok && kept.source.toolchainDigest, "d".repeat(64));
  assert.equal(same.calls.length, 1);
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
  assert.equal(missing?.source.sourceCommitSha, null);
  // A generated version reads nothing more: it has no snapshot or slice.
  const generated = createSequencedFakeDb([[{ source: generatedRow() }]]);
  const unsliced = await createSandboxStore(generated.db).replayContext(
    "owner",
    "sbv_1",
  );
  assert.equal(generated.calls.length, 1);
  assert.equal(unsliced?.snapshot, null);
  assert.equal(unsliced?.sliceRun, null);
  assert.equal(unsliced?.source.origin, "starter");
  assert.equal(
    await createSandboxStore(createFakeDb([]).db).replayContext(
      "owner",
      "sbv_x",
    ),
    null,
  );
});

test("publishing freezes and approves a version with a passing build, and points its sandbox at it", async () => {
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const ready = generatedRow({
    harnessSha256: "h".repeat(64),
    toolchainDigest: "d".repeat(64),
  });
  const current = { version: versionRow(), source: ready, commitSha: null };
  const fake = createSequencedFakeDb([
    [current],
    [versionRow({ frozenAt: now })],
    [{ ...ready, approvedBy: "user_1", approvedAt: now }],
    [sandboxRow({ status: "published", currentVersionId: "sbv_1" })],
    [{ sourceRepoId: null }],
  ]);
  const result = await createSandboxStore(fake.db).publishVersion(
    "owner",
    "sbv_1",
    "user_1",
    expiresAt,
    now,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(fake.calls[0]?.lock, "update");
  // What it stands on is the approval its task was taken from: the
  // bounty's approval now is not read, nor held.
  assert.equal(
    fake.calls.some(({ lock }) => lock === "share"),
    false,
  );
  assert.deepEqual(fake.calls[1]?.values, { frozenAt: now });
  assert.deepEqual(fake.calls[2]?.values, {
    approvedBy: "user_1",
    approvedAt: now,
    updatedAt: now,
  });
  // Published until the date given.
  assert.deepEqual(fake.calls[3]?.values, {
    status: "published",
    currentVersionId: "sbv_1",
    expiresAt,
    updatedAt: now,
  });
  assert.equal(result.sandbox.status, "published");
  assert.equal(result.version.version.frozenAt, now.toISOString());
  assert.equal(result.version.source.approvedBy, "user_1");

  // Published before: kept frozen with its first approval, only pointed at.
  const again = createSequencedFakeDb([
    [
      {
        version: versionRow({ frozenAt: now }),
        source: { ...ready, approvedBy: "user_0", approvedAt: now },
        commitSha: null,
      },
    ],
    [sandboxRow({ status: "published", currentVersionId: "sbv_1" })],
    [{ sourceRepoId: null }],
  ]);
  const republished = await createSandboxStore(again.db).publishVersion(
    "owner",
    "sbv_1",
    "user_1",
    expiresAt,
    now,
  );
  assert.equal(
    republished.ok && republished.version.source.approvedBy,
    "user_0",
  );
  assert.equal(again.calls.length, 3);

  // A task taken from a bounty not approved, or with no proposal at all:
  // refused before anything is frozen or published.
  for (const pricing of [{ ...approvedPricing, status: "proposed" }, null]) {
    const unapproved = createSequencedFakeDb([
      [
        {
          ...current,
          source: { ...ready, approvedTask: { ...approvedTask, pricing } },
        },
      ],
    ]);
    assert.deepEqual(
      await createSandboxStore(unapproved.db).publishVersion(
        "owner",
        "sbv_1",
        "user_1",
        expiresAt,
      ),
      { ok: false, reason: "bounty_not_approved" },
    );
    assert.equal(unapproved.calls.length, 1);
  }

  // No passing build, or not the organization's: refused, nothing written.
  for (const [rows, reason] of [
    [[{ ...current, source: generatedRow() }], "not_ready"],
    [[], "not-found"],
  ] as const) {
    const refused = createSequencedFakeDb([rows]);
    assert.deepEqual(
      await createSandboxStore(refused.db).publishVersion(
        "owner",
        "sbv_1",
        "user_1",
        expiresAt,
      ),
      { ok: false, reason },
    );
    assert.equal(refused.calls.length, 1);
  }
});

test("unpublishing takes a sandbox back to a draft with no published version", async () => {
  const fake = createSequencedFakeDb([
    [sandboxRow({ status: "draft" })],
    [{ sourceRepoId: "ghr_1" }],
  ]);
  const sandbox = await createSandboxStore(fake.db).unpublish(
    "owner",
    "sbx_1",
    now,
  );
  // Its expiry goes with the publication.
  assert.deepEqual(fake.calls[0]?.values, {
    status: "draft",
    currentVersionId: null,
    expiresAt: null,
    updatedAt: now,
  });
  assert.equal(sandbox?.status, "draft");
  assert.equal(sandbox?.sourceRepoId, "ghr_1");
  assert.equal(
    await createSandboxStore(createSequencedFakeDb([[]]).db).unpublish(
      "owner",
      "sbx_9",
    ),
    null,
  );
});
