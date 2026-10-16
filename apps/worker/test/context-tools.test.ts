import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { buildSeamsIndex, fileSeams } from "sandbox-factory";
import {
  CONTEXT_TOOL_LIMITS,
  accessorHint,
  dataModelTool,
  moduleSeamsTool,
  moduleSurfaceTool,
} from "../src/agent/context-tools.js";
import { REPO_TOOL_LIMITS } from "../src/agent/repo-tools.js";
import { AnalysisError } from "../src/errors.js";
import type { ToolInputs } from "../src/tools/adapter.js";
import {
  loadAbstractions,
  loadDataModel,
  loadSeams,
} from "../src/tools/context-runs.js";
import {
  contextIndex,
  contextModel,
  contextRun,
  createServiceExport,
  ownersEntity,
  serviceModule,
} from "./context-fixtures.js";
import { toolContext } from "./helpers.js";

const signal = new AbortController().signal;

function servedBy(
  served: ReturnType<typeof contextRun>,
  overrides: Partial<ToolInputs> = {},
): ToolInputs {
  return {
    ...toolContext().inputs,
    getRun: async (id) => (id === served.run.id ? served.run : null),
    listArtifacts: async () => [served.artifact],
    readArtifact: async () => served.bytes,
    ...overrides,
  };
}
const unavailable = (error: unknown) =>
  error instanceof AnalysisError && error.code === "context_unavailable";

test("a context run is read back only when it is the run it should be, unaltered", async () => {
  const abstractions = contextRun("arn_abs", "abstractions", contextIndex);
  const model = contextRun("arn_model", "data_model", contextModel);
  assert.deepEqual(
    await loadAbstractions(servedBy(abstractions), "arn_abs", "rsn_1"),
    contextIndex,
  );
  assert.deepEqual(
    await loadDataModel(servedBy(model), "arn_model", "rsn_1"),
    contextModel,
  );
  for (const [inputs, id, snapshot] of [
    [servedBy(abstractions), "arn_missing", "rsn_1"],
    [servedBy(abstractions), "arn_abs", "rsn_other"],
    [
      servedBy(abstractions, {
        getRun: async () => ({ ...abstractions.run, status: "running" }),
      }),
      "arn_abs",
      "rsn_1",
    ],
    [servedBy(model), "arn_model", "rsn_1"],
    [
      servedBy(abstractions, { listArtifacts: async () => [] }),
      "arn_abs",
      "rsn_1",
    ],
    [
      servedBy(abstractions, { readArtifact: async () => undefined }),
      "arn_abs",
      "rsn_1",
    ],
    [
      servedBy(abstractions, {
        readArtifact: async () => Buffer.from("tampered"),
      }),
      "arn_abs",
      "rsn_1",
    ],
  ] as const)
    await assert.rejects(loadAbstractions(inputs, id, snapshot), unavailable);
  const garbage = contextRun("arn_abs", "abstractions", null);
  const notJson = {
    ...garbage,
    bytes: Buffer.from("{"),
    artifact: {
      ...garbage.artifact,
      sha256: createHash("sha256").update("{").digest("hex"),
    },
  };
  await assert.rejects(
    loadAbstractions(servedBy(notJson), "arn_abs", "rsn_1"),
    unavailable,
  );
  await assert.rejects(
    loadAbstractions(servedBy(garbage), "arn_abs", "rsn_1"),
    unavailable,
  );
});

test("module_surface shows a module's exports, and refuses what the index does not hold", async () => {
  const tool = moduleSurfaceTool(contextIndex);
  const shown = await tool.run({ path: "lib/service.ts" }, signal);
  assert.equal(shown.isError, undefined);
  assert.match(
    shown.content,
    /^lib\/service\.ts: typescript, typed, imported by 2 files, 2 exports\./,
  );
  assert.match(
    shown.content,
    /createService \(function, L18\) symbol:lib\/service\.ts:service_createservice/,
  );
  assert.match(shown.content, /names: symbol:lib\/types\.ts#Config/);
  const namesOnly = await tool.run({ path: "scripts/tool.py" }, signal);
  assert.match(namesOnly.content, /imported by 1 file, 1 exports/);
  assert.match(namesOnly.content, /\(no signature\)/);
  assert.equal((await tool.run({ path: "nowhere.ts" }, signal)).isError, true);
  assert.match(
    (await tool.run({ file: "x" }, signal)).content,
    /Invalid input/,
  );
  // A long surface is cut, and says so.
  const long = moduleSurfaceTool({
    ...contextIndex,
    modules: [
      {
        ...serviceModule,
        exports: [
          {
            ...createServiceExport,
            signature: "x".repeat(REPO_TOOL_LIMITS.readChars),
          },
        ],
      },
    ],
  });
  assert.match(
    (await long.run({ path: "lib/service.ts" }, signal)).content,
    /Cut at \d+ characters/,
  );
});

test("data_model gives an overview, or one entity with its fields, relations and accessors", async () => {
  const tool = dataModelTool(contextModel);
  const overview = (await tool.run({ entity: null }, signal)).content;
  assert.match(
    overview,
    /Sources: drizzle \(postgresql, 2 entities\); sql_migrations \(postgresql, 0 entities, 2 also defined above\)\./,
  );
  assert.match(overview, /things → app\.things \(4 fields\) lib\/schema\.ts:3/);
  assert.match(overview, /Enums: state\./);
  assert.match(overview, /lib\/service\.ts \(imported by 2\): owners, things/);
  const entity = (await tool.run({ entity: "APP.THINGS" }, signal)).content;
  assert.match(
    entity,
    /^things → table app\.things, from drizzle at lib\/schema\.ts:3\./,
  );
  assert.match(entity, /Unique together: \(ownerId, state\)\./);
  assert.match(
    entity,
    /- ownerId \(column owner_id\): string as text, nullable, unique/,
  );
  assert.match(
    entity,
    /- state: enum as state, required, default 'new', one of new \| done/,
  );
  assert.match(entity, /^- tags: string\[\] as text\[\], nullable$/m);
  assert.match(
    entity,
    /- ownerId → owners\.id \(one-to-one, on delete cascade\)/,
  );
  assert.match(entity, /- owners\.\* → this \(many-to-many\)/);
  assert.match(entity, /- id → things\.\* \(many-to-one\)/);
  assert.match(entity, /Accessors: lib\/service\.ts/);
  const bare = (await tool.run({ entity: "owners" }, signal)).content;
  assert.match(bare, /Primary key: \(none\)\.\n/);
  assert.match(bare, /- \(join table\) → things\.\* \(many-to-many\)/);
  assert.equal((await tool.run({ entity: "nobody" }, signal)).isError, true);
  assert.match((await tool.run({}, signal)).content, /Invalid input/);
  const empty = dataModelTool({
    ...contextModel,
    sources: [],
    entities: [],
    relations: [],
    enums: [],
    accessors: [],
  });
  const nothing = (await empty.run({ entity: null }, signal)).content;
  assert.match(nothing, /No schema, ORM or migration was found/);
  assert.match(nothing, /Enums: \(none\)/);
  const lonely = (
    await dataModelTool({ ...contextModel, relations: [], accessors: [] }).run(
      { entity: "owners" },
      signal,
    )
  ).content;
  assert.match(lonely, /Relations:\n\(none\)/);
  assert.match(lonely, /Accessors: \(none found\)/);
  // Past the limits, the overview says how many more there are.
  const crowded = dataModelTool({
    ...contextModel,
    entities: Array.from(
      { length: CONTEXT_TOOL_LIMITS.overviewEntities + 2 },
      (_, index) => ({
        ...ownersEntity,
        name: `e${index}`,
        table: `e${index}`,
      }),
    ),
    accessors: Array.from(
      { length: CONTEXT_TOOL_LIMITS.accessors + 1 },
      (_, index) => ({
        module: `m${index}.ts`,
        entities: ["e0"],
        importers: 0,
      }),
    ),
  });
  const crowdedText = (await crowded.run({ entity: null }, signal)).content;
  assert.match(crowdedText, /\(2 more\.\)/);
  assert.match(crowdedText, /\(1 more\.\)/);
});

test("the accessor hint points the scope agent at the modules that reach the store", () => {
  assert.match(
    accessorHint(contextModel),
    /2 entities \(postgresql, postgresql\)/,
  );
  assert.match(accessorHint(contextModel), /lib\/service\.ts: owners, things/);
  assert.match(
    accessorHint({ ...contextModel, accessors: [] }),
    /no accessor was found/,
  );
  assert.match(
    accessorHint({ ...contextModel, entities: [] }),
    /found no entities/,
  );
});

const seamsSources: Record<string, string | null> = {
  "src/db.ts": `import pg from "pg";\nexport const url = process.env.DATABASE_URL;`,
  "src/pure.ts": "export const one = 1;",
  "lib/a/x.ts": `import axios from "axios";`,
  "lib/a/big.ts": null,
};
const seamsIndex = buildSeamsIndex({
  files: Object.entries(seamsSources).map(([path, text]) =>
    fileSeams(path, text),
  ),
  snapshotId: "rsn_1",
  commitSha: "c",
  graphRunId: "arn_graph",
  graphSha256: "s",
});

test("the seams index is read back when the abstractions run wrote one, and is null when it did not", async () => {
  const abstractions = contextRun("arn_abs", "abstractions", contextIndex);
  assert.equal(
    await loadSeams(servedBy(abstractions), "arn_abs", "rsn_1"),
    null,
  );
  const bytes = Buffer.from(JSON.stringify(seamsIndex));
  const seams = servedBy(abstractions, {
    listArtifacts: async () => [
      abstractions.artifact,
      {
        ...abstractions.artifact,
        id: "art_seams",
        kind: "seams_index",
        path: "seams.json",
        objectKey: "runs/arn_abs/seams.json",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
    readArtifact: async (key) =>
      key === "runs/arn_abs/seams.json" ? bytes : abstractions.bytes,
  });
  assert.deepEqual(await loadSeams(seams, "arn_abs", "rsn_1"), seamsIndex);
  await assert.rejects(loadSeams(seams, "arn_abs", "rsn_other"), unavailable);
});

test("module_seams looks files and directories up, and says what it cannot answer", async () => {
  const tool = moduleSeamsTool(seamsIndex, Object.keys(seamsSources).sort());
  const one = await tool.run({ paths: ["src/db.ts"] }, signal);
  assert.equal(
    one.content,
    "src/db.ts: services postgres (pg); environment DATABASE_URL.",
  );
  assert.equal(
    tool.describe?.({ paths: ["src/db.ts"] }, one),
    "Looked up where the code reaches out",
  );
  const several = await tool.run(
    { paths: ["lib/a/", "src/pure.ts", "nowhere"] },
    signal,
  );
  assert.deepEqual(several.content.split("\n"), [
    "lib/a/ (2 files): services http (axios); not indexed, so only check_scope can tell: lib/a/big.ts.",
    "- lib/a/x.ts: services http (axios)",
    "src/pure.ts: no services or environment variables.",
    "nowhere names no file in the structure analysis.",
    "Together: services http (axios); not indexed, so only check_scope can tell: lib/a/big.ts.",
  ]);
  const invalid = await tool.run({ paths: [] }, signal);
  assert.match(invalid.content, /Invalid input/);
  assert.equal(tool.describe?.({ paths: [] }, invalid), null);
  // A crowded directory lists its first files and says how many more.
  const crowded = Array.from(
    { length: CONTEXT_TOOL_LIMITS.seamFiles + 2 },
    (_, n) => `many/f${String(n).padStart(2, "0")}.ts`,
  );
  const crowdedTool = moduleSeamsTool(
    buildSeamsIndex({
      files: crowded.map((path) => fileSeams(path, "process.env.X;")),
      snapshotId: "rsn_1",
      commitSha: "c",
      graphRunId: "arn_graph",
      graphSha256: "s",
    }),
    crowded,
  );
  const listed = (await crowdedTool.run({ paths: ["many"] }, signal)).content;
  assert.match(listed, /^many\/ \(32 files\): environment X\./);
  assert.match(listed, /\(2 more\.\)$/);
});
