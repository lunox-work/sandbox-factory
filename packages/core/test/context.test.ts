import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ABSTRACTIONS_SUMMARY_LIMITS,
  ABSTRACTIONS_TOOL_VERSION,
  ABSTRACTION_LIMITS,
  DATA_MODEL_SUMMARY_LIMITS,
  DATA_MODEL_TOOL_VERSION,
  SCOPE_TOOL_VERSION,
  abstractionsSummary,
  boundedSignature,
  byImporters,
  dataModelSummary,
  foreignKeyFields,
  graphSymbols,
  importerCounts,
  isAbstractionsParams,
  isDataModelParams,
  isSliceParams,
  mergeSources,
  namesOnlyExports,
  normalizeReferentialAction,
  normalizeSqlType,
  parseSliceGraph,
  rankAccessors,
  readsGraph,
  renderAbstractionsMarkdown,
  renderErdMermaid,
  sortExports,
  surfaceIdFor,
  surfaceLanguageOf,
  surfaceSymbolId,
  toolOfParams,
  toolVersionOf,
} from "../src/index.js";
import type {
  AbstractionIndex,
  DataEntity,
  DataField,
  DataModel,
  ModuleSurface,
  RecognizedSource,
} from "../src/index.js";

test("the two builders read graphify's map and name themselves in their parameters", () => {
  const abstractions = {
    deadlineMinutes: 30,
    builder: "abstractions" as const,
    graphRunId: "g",
  };
  const dataModel = {
    deadlineMinutes: 30,
    builder: "data_model" as const,
    graphRunId: "g",
  };
  assert.equal(toolOfParams(abstractions), "abstractions");
  assert.equal(toolOfParams(dataModel), "data_model");
  assert.equal(isAbstractionsParams(abstractions), true);
  assert.equal(isAbstractionsParams(dataModel), false);
  assert.equal(isDataModelParams(dataModel), true);
  assert.equal(isDataModelParams({ deadlineMinutes: 30 }), false);
  // A builder that names a graph run is not a slice.
  assert.equal(isSliceParams(abstractions), false);
  assert.equal(readsGraph("abstractions"), true);
  assert.equal(readsGraph("data_model"), true);
  assert.equal(readsGraph("dependency_cruiser"), false);
  assert.equal(toolVersionOf("abstractions"), ABSTRACTIONS_TOOL_VERSION);
  assert.equal(toolVersionOf("data_model"), DATA_MODEL_TOOL_VERSION);
  assert.equal(toolVersionOf("scope"), SCOPE_TOOL_VERSION);
});

const graph = parseSliceGraph({
  nodes: [
    {
      id: "file:a.ts",
      label: "a.ts",
      source_file: "a.ts",
      source_location: "L1",
    },
    { id: "file:b.ts", label: "b.ts", source_file: "b.ts" },
    { id: "file:c.py", label: "c.py", source_file: "c.py" },
    {
      id: "symbol:a.ts:a_run",
      label: "run()",
      source_file: "a.ts",
      source_location: "L3",
    },
    {
      id: "symbol:a.ts:a_box",
      label: "Box",
      source_file: "a.ts",
      source_location: "L5",
    },
    {
      id: "symbol:a.ts:a_box_open",
      label: ".open()",
      source_file: "a.ts",
      source_location: "L6",
    },
    {
      id: "symbol:a.ts:a_run_again",
      label: "run()",
      source_file: "a.ts",
      source_location: "L9",
    },
    {
      id: "symbol:a.ts:a_loose",
      label: ".loose()",
      source_file: "a.ts",
      source_location: "Lx",
    },
    {
      id: "dependency:b.ts:pg",
      label: "pg",
      source_file: "b.ts",
      dependencyStatus: "external",
    },
  ],
  links: [
    { source: "file:b.ts", target: "file:a.ts", relation: "imports" },
    {
      source: "file:b.ts",
      target: "symbol:a.ts:a_run",
      relation: "imports_from",
    },
    {
      source: "file:c.py",
      target: "symbol:a.ts:a_box",
      relation: "imports_from",
    },
    { source: "file:a.ts", target: "file:a.ts", relation: "imports" },
    { source: "file:b.ts", target: "dependency:b.ts:pg", relation: "imports" },
    { source: "file:c.py", target: "file:b.ts", relation: "calls" },
    {
      source: "symbol:a.ts:a_box",
      target: "symbol:a.ts:a_box_open",
      relation: "method",
    },
  ],
});

test("the graph gives each file's importers and its symbols, matched to exports by name and line", () => {
  assert.equal(graph.nodes[0]?.line, 1);
  assert.equal(graph.nodes[1]?.line, null);
  assert.deepEqual([...importerCounts(graph)], [["a.ts", 2]]);
  const symbols = graphSymbols(graph);
  assert.deepEqual(
    symbols
      .get("a.ts")
      ?.map((s) => [s.name, s.line, s.method, s.callable, s.owner]),
    [
      ["loose", null, true, true, null],
      ["run", 3, false, true, null],
      ["Box", 5, false, false, null],
      ["open", 6, true, true, "symbol:a.ts:a_box"],
      ["run", 9, false, true, null],
    ],
  );
  const a = symbols.get("a.ts");
  assert.equal(surfaceIdFor(a, "a.ts", "run", 9), "symbol:a.ts:a_run_again");
  // Two of a name and neither at the line: the export keeps its own id.
  assert.equal(surfaceIdFor(a, "a.ts", "run", 4), "symbol:a.ts#run");
  assert.equal(surfaceIdFor(a, "a.ts", "Box", 2), "symbol:a.ts:a_box");
  assert.equal(
    surfaceIdFor(a, "a.ts", "Box.open", 6),
    "symbol:a.ts:a_box_open",
  );
  assert.equal(
    surfaceIdFor(undefined, "z.ts", "z", 1),
    surfaceSymbolId("z.ts", "z"),
  );
  assert.deepEqual(
    namesOnlyExports(a ?? []).map((e) => [e.name, e.kind, e.line]),
    [
      ["loose", "method", 1],
      ["run", "function", 3],
      ["Box", "class", 5],
      ["Box.open", "method", 6],
      ["run", "function", 9],
    ],
  );
  assert.deepEqual(
    namesOnlyExports([
      {
        id: "x",
        name: "T",
        line: 2,
        method: false,
        callable: false,
        owner: null,
      },
    ]).map((e) => e.kind),
    ["type"],
  );
});

test("languages are read off extensions, and nothing else counts as code", () => {
  assert.equal(surfaceLanguageOf("src/a.tsx"), "typescript");
  assert.equal(surfaceLanguageOf("lib/x.MJS"), "javascript");
  assert.equal(surfaceLanguageOf("app/models.py"), "python");
  assert.equal(surfaceLanguageOf("Main.kt"), "kotlin");
  assert.equal(surfaceLanguageOf("README.md"), null);
  assert.equal(surfaceLanguageOf("Makefile"), null);
  assert.equal(surfaceLanguageOf(".eslintrc"), null);
});

test("signatures and exports are bounded and ordered", () => {
  assert.deepEqual(boundedSignature("  def f()  "), {
    signature: "def f()",
    truncated: false,
  });
  const long = boundedSignature(
    "x".repeat(ABSTRACTION_LIMITS.signatureChars + 5),
  );
  assert.equal(long.truncated, true);
  assert.equal(long.signature.length, ABSTRACTION_LIMITS.signatureChars + 1);
  assert.deepEqual(
    sortExports([
      { line: 2, name: "b" },
      { line: 1, name: "z" },
      { line: 2, name: "a" },
    ]),
    [
      { line: 1, name: "z" },
      { line: 2, name: "a" },
      { line: 2, name: "b" },
    ],
  );
});

const surface = (
  path: string,
  importers: number,
  exports: number,
  coverage: ModuleSurface["coverage"] = "typed",
  language = "typescript",
): ModuleSurface => ({
  path,
  language,
  coverage,
  importers,
  exports: Array.from({ length: exports }, (_, index) => ({
    id: surfaceSymbolId(path, `e${index}`),
    name: `e${index}`,
    kind: "function" as const,
    signature:
      coverage === "names-only"
        ? null
        : `export declare function e${index}(): void;`,
    line: index + 1,
    references: [],
  })),
});
const index = (
  modules: readonly ModuleSurface[],
  omissions = 0,
): AbstractionIndex => ({
  schemaVersion: 1,
  toolVersion: ABSTRACTIONS_TOOL_VERSION,
  extractors: { typescript: "typescript@5", syntactic: null },
  sourceSnapshotId: "rsn",
  sourceCommitSha: "c".repeat(40),
  graphRunId: "g",
  graphSha256: "s",
  modules,
  externals: [],
  omissions: Array.from({ length: omissions }, (_, i) => ({
    code: "parse_failed" as const,
    file: `f${i}`,
    detail: "d",
  })),
});

test("the abstractions summary counts coverage and languages, and ranks the most imported modules", () => {
  const summary = abstractionsSummary(
    index([
      surface("b.ts", 3, 2),
      surface("a.ts", 3, 1),
      surface("c.py", 9, 4, "syntactic", "python"),
      surface("d.lua", 0, 1, "names-only", "lua"),
    ]),
  );
  assert.deepEqual(summary.counts, { modules: 4, exports: 8, omissions: 0 });
  assert.deepEqual(summary.coverage, {
    typed: 2,
    syntactic: 1,
    "names-only": 1,
  });
  assert.deepEqual(summary.languages, [
    { language: "typescript", modules: 2, exports: 3 },
    { language: "lua", modules: 1, exports: 1 },
    { language: "python", modules: 1, exports: 4 },
  ]);
  assert.deepEqual(
    summary.modules.map((m) => m.path),
    ["c.py", "a.ts", "b.ts", "d.lua"],
  );
  assert.equal(summary.truncated, false);
  const crowded = abstractionsSummary(
    index(
      Array.from({ length: ABSTRACTIONS_SUMMARY_LIMITS.modules + 1 }, (_, i) =>
        surface(`m${i}.ts`, i, 1),
      ),
      ABSTRACTIONS_SUMMARY_LIMITS.omissions + 1,
    ),
  );
  assert.equal(crowded.modules.length, ABSTRACTIONS_SUMMARY_LIMITS.modules);
  assert.equal(crowded.omissions.length, ABSTRACTIONS_SUMMARY_LIMITS.omissions);
  assert.equal(crowded.truncated, true);
  assert.deepEqual(
    byImporters([surface("x", 1, 0), surface("y", 2, 0)]).map((m) => m.path),
    ["y", "x"],
  );
});

test("the readable view lists modules most imported first, fenced by language, within its bounds", () => {
  const text = renderAbstractionsMarkdown(
    index([
      surface("a.ts", 1, 1),
      surface("b.py", 2, 1, "syntactic", "python"),
      surface("c.lua", 3, 1, "names-only", "lua"),
      surface("d.ts", 5, 0),
      {
        ...surface("e.rb", 0, 0, "syntactic", "ruby"),
        exports: [
          {
            id: "symbol:e.rb#e0",
            name: "e0",
            kind: "function",
            signature: null,
            line: 1,
            references: [],
          },
        ],
      },
    ]),
  );
  assert.ok(text.indexOf("## c.lua") < text.indexOf("## b.py"));
  assert.ok(text.indexOf("## b.py") < text.indexOf("## a.ts"));
  assert.match(
    text,
    /lua · names-only · imported by 3 files\n\n- `e0` \(function, L1\)/,
  );
  assert.match(text, /python · syntactic · imported by 2 files\n\n```python\n/);
  assert.match(text, /imported by 1 file\n/);
  assert.match(text, /```ruby\ne0\n```/);
  // A module with nothing exported has nothing to show.
  assert.doesNotMatch(text, /## d\.ts/);
  assert.doesNotMatch(text, /more module/);
  const wide = renderAbstractionsMarkdown(
    index(
      Array.from(
        { length: ABSTRACTIONS_SUMMARY_LIMITS.markdownModules + 2 },
        (_, i) => surface(`m${i}.ts`, 0, 1),
      ),
    ),
  );
  assert.match(wide, /2 more modules are in abstractions\.json\./);
  const huge = renderAbstractionsMarkdown(
    index([surface("big.ts", 1, 8000), surface("small.ts", 0, 1)]),
  );
  assert.match(huge, /2 more modules are in abstractions\.json\./);
  const one = renderAbstractionsMarkdown(
    index(
      Array.from(
        { length: ABSTRACTIONS_SUMMARY_LIMITS.markdownModules + 1 },
        (_, i) => surface(`m${i}.ts`, 0, 1),
      ),
    ),
  );
  assert.match(one, /1 more module is in abstractions\.json\./);
});

test("the readable view shows a barrel's statements once each, not once per name", () => {
  const entry = (name: string, signature: string, line: number) => ({
    id: `symbol:schema.ts#${name}`,
    name,
    kind: "const" as const,
    signature,
    line,
    references: [],
  });
  const text = renderAbstractionsMarkdown(
    index([
      {
        ...surface("schema.ts", 44, 0),
        exports: [
          // Wrapped as a formatter writes it: a name to a line.
          entry("account", 'export { account } from "./auth.js";', 2),
          entry("user", 'export { user } from "./auth.js";', 3),
          entry(
            "AccountRow",
            'export type { AccountRow } from "./auth.js";',
            6,
          ),
          entry("UserRow", 'export type { UserRow } from "./auth.js";', 7),
          entry("bounty", 'export { bounty as b } from "./bounty.js";', 9),
          entry("KINDS", "export declare const KINDS: string[];", 10),
          entry("member", 'export { member } from "./orgs.js";', 11),
        ],
      },
    ]),
  );
  assert.match(
    text,
    /```ts\nexport \{ account, user \} from "\.\/auth\.js";\nexport type \{ AccountRow, UserRow \} from "\.\/auth\.js";\nexport \{ bounty as b \} from "\.\/bounty\.js";\nexport declare const KINDS: string\[\];\nexport \{ member \} from "\.\/orgs\.js";\n```/,
  );
});

test("SQL types normalize from any dialect's spelling", () => {
  const cases: [string, string][] = [
    ["character varying(200)", "string"],
    ["TEXT[]", "string"],
    ["int4", "integer"],
    ["serial", "integer"],
    ["bigserial", "bigint"],
    ["numeric(10, 2)", "decimal"],
    ["double precision", "float"],
    ["bool", "boolean"],
    ["date", "date"],
    ["timestamp with time zone", "datetime"],
    ["datetime", "datetime"],
    ["time without time zone", "time"],
    ["interval", "interval"],
    ["jsonb", "json"],
    ["uuid", "uuid"],
    ["bytea", "bytes"],
    ["pg_catalog.int8", "bigint"],
    ["tsvector", "unknown"],
  ];
  for (const [native, expected] of cases)
    assert.equal(normalizeSqlType(native), expected, native);
  assert.equal(normalizeReferentialAction("SetNull"), "set null");
  assert.equal(normalizeReferentialAction("no_action"), "no action");
  assert.equal(normalizeReferentialAction("CASCADE"), "cascade");
});

const field = (
  name: string,
  overrides: Partial<DataField> = {},
): DataField => ({
  name,
  column: name,
  type: "string",
  nativeType: "text",
  list: false,
  nullable: false,
  default: null,
  unique: false,
  primaryKey: false,
  enum: null,
  ...overrides,
});
const entity = (
  name: string,
  table: string,
  source: DataEntity["source"],
  fields: DataField[] = [field("id", { primaryKey: true })],
): DataEntity => ({
  name,
  table,
  kind: "table",
  source,
  file: `${source}.file`,
  line: 1,
  fields,
  primaryKey: ["id"],
  uniques: [],
});
const recognized = (
  kind: RecognizedSource["kind"],
  parts: Partial<RecognizedSource>,
): RecognizedSource => ({
  kind,
  storage: "postgresql",
  files: [`${kind}.file`],
  evidence: [],
  entities: [],
  enums: [],
  relations: [],
  omissions: [],
  ...parts,
});

test("sources merge by authority: a table and an enum come from the most authoritative source", () => {
  const merged = mergeSources([
    recognized("sql_migrations", {
      evidence: ["migrations:db", "migrations:db"],
      entities: [
        entity("users", "users", "sql_migrations"),
        entity("audit", "audit", "sql_migrations"),
      ],
      enums: [
        {
          name: "role",
          values: ["a"],
          source: "sql_migrations",
          file: "m.sql",
          line: 1,
        },
      ],
      relations: [
        {
          name: null,
          from: { entity: "audit", fields: ["actor"] },
          to: { entity: "users", fields: ["id"] },
          cardinality: "many-to-one",
          onDelete: null,
          onUpdate: null,
          source: "sql_migrations",
        },
        {
          name: null,
          from: { entity: "users", fields: ["x"] },
          to: { entity: "audit", fields: ["id"] },
          cardinality: "many-to-one",
          onDelete: null,
          onUpdate: null,
          source: "sql_migrations",
        },
        {
          name: null,
          from: { entity: "audit", fields: ["y"] },
          to: { entity: "ghost", fields: ["id"] },
          cardinality: "many-to-one",
          onDelete: null,
          onUpdate: null,
          source: "sql_migrations",
        },
      ],
      omissions: [
        { code: "statement_skipped", file: "b.sql", detail: "x" },
        { code: "parse_failed", file: null, detail: "y" },
      ],
    }),
    recognized("prisma", {
      entities: [entity("User", "USERS", "prisma")],
      enums: [
        {
          name: "Role",
          values: ["A"],
          source: "prisma",
          file: "s.prisma",
          line: 1,
        },
      ],
      omissions: [{ code: "parse_failed", file: "a.prisma", detail: "z" }],
    }),
  ]);
  assert.deepEqual(
    merged.sources.map((s) => [s.kind, s.entities, s.shadowed, s.evidence]),
    [
      ["prisma", 1, 0, []],
      ["sql_migrations", 1, 1, ["migrations:db"]],
    ],
  );
  assert.deepEqual(
    merged.entities.map((e) => e.name),
    ["User", "audit"],
  );
  assert.deepEqual(
    merged.enums.map((e) => e.name),
    ["Role"],
  );
  // The shadowed table's relations go; one into it points at the winner.
  assert.deepEqual(
    merged.relations.map((r) => [r.from.entity, r.to.entity]),
    [
      ["audit", "User"],
      ["audit", "ghost"],
    ],
  );
  assert.deepEqual(
    merged.omissions.map((o) => o.file),
    [null, "a.prisma", "b.sql"],
  );
  const tie = mergeSources([
    recognized("drizzle", {
      files: ["b.ts"],
      entities: [entity("t", "t", "drizzle")],
    }),
    recognized("drizzle", {
      files: ["a.ts"],
      entities: [entity("t2", "t", "drizzle")],
    }),
  ]);
  assert.deepEqual(
    tie.entities.map((e) => e.name),
    ["t2"],
  );
});

test("accessors rank by entities touched, then importers, then path", () => {
  assert.deepEqual(
    rankAccessors([
      { module: "c.ts", entities: ["a"], importers: 9 },
      { module: "b.ts", entities: ["b", "a", "a"], importers: 1 },
      { module: "a.ts", entities: ["a"], importers: 9 },
      { module: "none.ts", entities: [], importers: 50 },
    ]),
    [
      { module: "b.ts", entities: ["a", "b"], importers: 1 },
      { module: "a.ts", entities: ["a"], importers: 9 },
      { module: "c.ts", entities: ["a"], importers: 9 },
    ],
  );
});

const model = (parts: Partial<DataModel>): DataModel => ({
  schemaVersion: 1,
  toolVersion: DATA_MODEL_TOOL_VERSION,
  sourceSnapshotId: "rsn",
  sourceCommitSha: "c",
  graphRunId: "g",
  graphSha256: "s",
  sources: [],
  entities: [],
  enums: [],
  relations: [],
  accessors: [],
  omissions: [],
  ...parts,
});

test("the ERD draws every entity and relation, in Mermaid's own spelling", () => {
  const erd = renderErdMermaid(
    model({
      entities: [
        entity("auth.users", "auth.users", "sql_migrations", [
          field("id", { primaryKey: true, unique: true }),
          field("email", { unique: true, nativeType: 'varchar "200"' }),
          field("role", {
            type: "enum",
            enum: "user role",
            nativeType: "role",
          }),
          field("tags", { list: true, nullable: true, nativeType: "text[]" }),
          field("", { nativeType: "text" }),
        ]),
        entity("auth_users", "auth_users", "sql_migrations"),
        entity("..", "dots", "sql_migrations"),
        entity("profiles", "profiles", "sql_migrations", [
          field("user_id", { unique: true }),
          field("maybe", { nullable: true }),
        ]),
      ],
      relations: [
        {
          name: null,
          from: { entity: "profiles", fields: ["user_id"] },
          to: { entity: "auth.users", fields: ["id"] },
          cardinality: "one-to-one",
          onDelete: null,
          onUpdate: null,
          source: "sql_migrations",
        },
        {
          name: "maybe_owner",
          from: { entity: "profiles", fields: ["maybe"] },
          to: { entity: "auth.users", fields: ["id"] },
          cardinality: "one-to-one",
          onDelete: null,
          onUpdate: null,
          source: "sql_migrations",
        },
        {
          name: null,
          from: { entity: "profiles", fields: ["maybe"] },
          to: { entity: "auth_users", fields: ["id"] },
          cardinality: "many-to-one",
          onDelete: null,
          onUpdate: null,
          source: "sql_migrations",
        },
        {
          name: null,
          from: { entity: "profiles", fields: ["user_id"] },
          to: { entity: "auth_users", fields: ["id"] },
          cardinality: "many-to-one",
          onDelete: null,
          onUpdate: null,
          source: "sql_migrations",
        },
        {
          name: null,
          from: { entity: "auth_users", fields: [] },
          to: { entity: "..", fields: [] },
          cardinality: "many-to-many",
          onDelete: null,
          onUpdate: null,
          source: "sql_migrations",
        },
        {
          name: null,
          from: { entity: "profiles", fields: ["x"] },
          to: { entity: "nowhere", fields: ["id"] },
          cardinality: "many-to-one",
          onDelete: null,
          onUpdate: null,
          source: "sql_migrations",
        },
      ],
    }),
  );
  assert.match(erd, /^erDiagram\n {2}auth_users \{\n/);
  assert.match(erd, /\n {2}auth_users_2 \{\n/);
  assert.match(erd, /\n {2}__ \{\n/);
  assert.match(erd, /string id PK "text"/);
  assert.match(erd, /string email UK "varchar '200'"/);
  assert.match(erd, /user_role role "role"/);
  assert.match(erd, /string\[\] tags "text\[\], nullable"/);
  assert.match(erd, /string field "text"/);
  assert.match(erd, /string user_id FK,UK "text"/);
  assert.match(erd, /profiles \|o--\|\| auth_users : "user_id"/);
  assert.match(erd, /profiles \|o--o\| auth_users : "maybe_owner"/);
  assert.match(erd, /profiles }o--o\| auth_users_2 : "maybe"/);
  assert.match(erd, /profiles }o--\|\| auth_users_2 : "user_id"/);
  assert.match(erd, /auth_users_2 }o--o{ __ : "relates"/);
  assert.doesNotMatch(erd, /nowhere/);
  assert.deepEqual([...foreignKeyFields(model({ relations: [] }), "x")], []);
});

test("the data model summary counts everything and bounds every list", () => {
  const many = <T>(count: number, make: (index: number) => T) =>
    Array.from({ length: count }, (_, i) => make(i));
  const limits = DATA_MODEL_SUMMARY_LIMITS;
  const big = model({
    sources: [
      {
        kind: "sql_migrations",
        storage: "postgresql",
        files: many(limits.sourceFiles + 1, (i) => `${i}.sql`),
        evidence: [],
        entities: 1,
        shadowed: 0,
      },
    ],
    entities: many(limits.entities + 1, (i) =>
      entity(
        `e${i}`,
        `e${i}`,
        "sql_migrations",
        many(limits.fields + 1, (j) => field(`f${j}`)),
      ),
    ),
    enums: many(limits.enums + 1, (i) => ({
      name: `n${i}`,
      values: many(limits.enumValues + 1, (j) => `v${j}`),
      source: "sql_migrations" as const,
      file: "f",
      line: 1,
    })),
    relations: many(limits.relations + 1, (i) => ({
      name: null,
      from: { entity: "e0", fields: [`f${i % 3}`] },
      to: { entity: "e1", fields: ["f0"] },
      cardinality: "many-to-one" as const,
      onDelete: "cascade",
      onUpdate: null,
      source: "sql_migrations" as const,
    })),
    accessors: many(limits.accessors + 1, (i) => ({
      module: `m${i}.ts`,
      entities: many(limits.accessorEntities + 1, (j) => `e${j}`),
      importers: i,
    })),
    omissions: many(limits.omissions + 1, (i) => ({
      code: "statement_skipped" as const,
      file: `${i}`,
      detail: "d",
    })),
  });
  const summary = dataModelSummary(big);
  assert.deepEqual(summary.counts, {
    entities: limits.entities + 1,
    fields: (limits.entities + 1) * (limits.fields + 1),
    enums: limits.enums + 1,
    relations: limits.relations + 1,
    accessors: limits.accessors + 1,
    omissions: limits.omissions + 1,
  });
  assert.equal(summary.entities.length, limits.entities);
  assert.equal(summary.entities[0]?.fields.length, limits.fields);
  assert.equal(summary.entities[0]?.fieldCount, limits.fields + 1);
  assert.equal(summary.entities[0]?.fields[1]?.foreignKey, true);
  assert.equal(summary.entities[1]?.fields[1]?.foreignKey, false);
  assert.equal(summary.enums[0]?.values.length, limits.enumValues);
  assert.equal(summary.relations.length, limits.relations);
  assert.equal(summary.accessors[0]?.entities.length, limits.accessorEntities);
  assert.equal(summary.sources[0]?.files.length, limits.sourceFiles);
  assert.equal(summary.omissions.length, limits.omissions);
  assert.equal(summary.truncated, true);
  const small = dataModelSummary(
    model({
      sources: [
        {
          kind: "prisma",
          storage: "sqlite",
          files: ["s.prisma"],
          evidence: [],
          entities: 0,
          shadowed: 0,
        },
        {
          kind: "drizzle",
          storage: "postgresql",
          files: [],
          evidence: [],
          entities: 0,
          shadowed: 0,
        },
      ],
    }),
  );
  assert.deepEqual(small.storage, ["postgresql", "sqlite"]);
  assert.equal(small.truncated, false);
});
