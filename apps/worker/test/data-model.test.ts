import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { StoredAnalysisRun, StoredArtifact } from "@sandbox-factory/db";
import { DATA_MODEL_TOOL_VERSION, parseSliceGraph } from "sandbox-factory";
import type { DataModel } from "sandbox-factory";
import { dataModelSummarySchema } from "@sandbox-factory/shared";
import { AnalysisError } from "../src/errors.js";
import type { ToolInputs } from "../src/tools/adapter.js";
import {
  createDataModelAdapter,
  sourceReader,
} from "../src/tools/data-model.js";
import { findAccessors } from "../src/tools/data-model/accessors.js";
import { recognizeDrizzle } from "../src/tools/data-model/drizzle.js";
import {
  parsePrismaSchema,
  recognizePrisma,
  renderPrismaValue,
} from "../src/tools/data-model/prisma.js";
import {
  naturalCompare,
  orderMigrations,
  renderExpression,
  replaySqlMigrations,
  upSection,
} from "../src/tools/data-model/sql.js";
import { toolContext } from "./helpers.js";

const fixture = fileURLToPath(
  new URL("../../fixtures/data-model/", import.meta.url),
);
const stamp = "2026-10-06T00:00:00.000Z";
const sha = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const graphRun: StoredAnalysisRun = {
  id: "arn_graph",
  snapshotId: "rsn_1",
  repoId: "ghr_1",
  tool: "graphify",
  toolVersion: "test",
  params: { deadlineMinutes: 30 },
  status: "succeeded",
  attempt: 0,
  maxAttempts: 2,
  errorCode: null,
  errorDetail: null,
  startedAt: stamp,
  finishedAt: stamp,
  deadlineAt: stamp,
  createdAt: stamp,
};
const params = {
  deadlineMinutes: 30,
  builder: "data_model" as const,
  graphRunId: graphRun.id,
};

/** The fixture's graph: its code files, their imports and the ORM packages. */
function graphJson() {
  const files = [
    "src/db/schema.ts",
    "src/db/index.ts",
    "src/db/prisma.ts",
    "src/services/members.ts",
    "src/services/users.ts",
    "src/services/reports.ts",
    "src/app.ts",
  ];
  const dependency = (file: string, label: string) => ({
    id: `dependency:${file}:${label}`,
    label,
    source_file: file,
    dependencyStatus: "external",
  });
  const imports = (from: string, to: string, specifier: string) => ({
    source: `file:${from}`,
    target: to.startsWith("dependency:") ? to : `file:${to}`,
    relation: "imports",
    specifier,
  });
  return {
    nodes: [
      ...files.map((file) => ({
        id: `file:${file}`,
        label: file,
        source_file: file,
      })),
      dependency("src/db/schema.ts", "drizzle-orm/pg-core"),
      dependency("src/db/prisma.ts", "@prisma/client"),
      dependency("src/services/users.ts", "@prisma/client"),
    ],
    links: [
      imports("src/db/index.ts", "src/db/schema.ts", "./schema.js"),
      imports("src/services/members.ts", "src/db/index.ts", "../db/index.js"),
      imports("src/services/users.ts", "src/db/prisma.ts", "../db/prisma.js"),
      imports("src/app.ts", "src/services/users.ts", "./services/users.js"),
      imports("src/app.ts", "src/services/members.ts", "./services/members.js"),
      imports("src/services/reports.ts", "src/services/users.ts", "./users.js"),
      imports(
        "src/db/schema.ts",
        "dependency:src/db/schema.ts:drizzle-orm/pg-core",
        "drizzle-orm/pg-core",
      ),
      imports(
        "src/db/prisma.ts",
        "dependency:src/db/prisma.ts:@prisma/client",
        "@prisma/client",
      ),
      imports(
        "src/services/users.ts",
        "dependency:src/services/users.ts:@prisma/client",
        "@prisma/client",
      ),
    ],
  };
}
function inputsFor(graph: unknown): ToolInputs {
  const bytes = Buffer.from(JSON.stringify(graph));
  const artifact: StoredArtifact = {
    id: "art_graph",
    runId: graphRun.id,
    kind: "graph_json",
    path: "graph.json",
    objectKey: "runs/arn_graph/graph.json",
    contentType: "application/json",
    sizeBytes: bytes.byteLength,
    sha256: sha(bytes),
    meta: null,
    createdAt: stamp,
  };
  return {
    ...toolContext().inputs,
    getRun: async (id) => (id === graphRun.id ? graphRun : null),
    listArtifacts: async () => [artifact],
    readArtifact: async () => bytes,
  };
}
async function runAdapter(
  sourceDir: string,
  graph: unknown = graphJson(),
  runParams: unknown = params,
) {
  const out = await mkdtemp(join(tmpdir(), "data-model-"));
  const lines: string[] = [];
  try {
    const files = await createDataModelAdapter().run({
      ...toolContext(),
      sourceDir,
      outDir: out,
      params: runParams as never,
      inputs: inputsFor(graph),
      signal: new AbortController().signal,
      log: (line) => lines.push(line),
    });
    const texts = new Map<string, string>();
    for (const file of files)
      texts.set(file.path, await readFile(file.absolutePath, "utf8"));
    return { files, texts, lines };
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

test("a repository with Prisma, Drizzle and SQL migrations yields its entities, relations and accessors", async () => {
  const { files, texts, lines } = await runAdapter(fixture);
  assert.deepEqual(
    files.map((file) => [file.path, file.kind]),
    [
      ["data-model.json", "data_model"],
      ["erd.mmd", "erd_mermaid"],
      ["manifest.json", "manifest"],
    ],
  );
  const model = JSON.parse(texts.get("data-model.json") ?? "") as DataModel;
  assert.equal(model.toolVersion, DATA_MODEL_TOOL_VERSION);
  assert.deepEqual(
    model.sources.map((source) => [
      source.kind,
      source.storage,
      source.entities,
      source.shadowed,
    ]),
    [
      ["prisma", "postgresql", 5, 0],
      ["drizzle", "postgresql", 3, 0],
      ["sql_migrations", "postgresql", 1, 1],
    ],
  );
  assert.deepEqual(model.sources[0]?.evidence, [
    "dependency:@prisma/client",
    "file:prisma/schema.prisma",
  ]);
  assert.deepEqual(
    model.entities.map((entity) => [
      entity.name,
      entity.table,
      entity.kind,
      entity.source,
    ]),
    [
      ["ActiveUser", "ActiveUser", "view", "prisma"],
      ["Category", "Category", "table", "prisma"],
      ["Post", "Post", "table", "prisma"],
      ["Profile", "Profile", "table", "prisma"],
      ["User", "users", "table", "prisma"],
      ["audit_log", "audit_log", "table", "sql_migrations"],
      ["invoices", "billing.invoices", "table", "drizzle"],
      ["memberships", "memberships", "table", "drizzle"],
      ["organizations", "organizations", "table", "drizzle"],
    ],
  );
  const entity = (name: string) => model.entities.find((e) => e.name === name);
  const field = (name: string, fieldName: string) =>
    entity(name)?.fields.find((f) => f.name === fieldName);
  assert.deepEqual(field("User", "email"), {
    name: "email",
    column: "email",
    type: "string",
    nativeType: "VarChar(200)",
    list: false,
    nullable: false,
    default: null,
    unique: true,
    primaryKey: false,
    enum: null,
  });
  assert.equal(field("User", "createdAt")?.column, "created_at");
  assert.equal(field("User", "role")?.enum, "Role");
  assert.equal(field("User", "id")?.default, "autoincrement()");
  assert.deepEqual(entity("Post")?.uniques, [["title", "authorId"]]);
  assert.deepEqual(entity("Profile")?.primaryKey, ["userId"]);
  assert.equal(field("audit_log", "payload")?.default, "'{}'::jsonb");
  assert.deepEqual(entity("audit_log")?.uniques, [["kind", "actor"]]);
  assert.deepEqual(entity("memberships")?.primaryKey, [
    "organizationId",
    "userId",
  ]);
  assert.deepEqual(field("organizations", "tags")?.list, true);
  assert.equal(
    field("organizations", "createdAt")?.nativeType,
    "timestamp with time zone",
  );
  assert.deepEqual(
    model.relations.map((relation) => [
      relation.from.entity,
      relation.from.fields.join(","),
      relation.to.entity,
      relation.cardinality,
      relation.onDelete,
    ]),
    [
      ["Category", "", "Post", "many-to-many", null],
      ["Post", "authorId", "User", "many-to-one", "cascade"],
      ["Profile", "userId", "User", "one-to-one", "set null"],
      // The migrations' `users` is Prisma's `User`, which shadows it.
      ["audit_log", "actor", "User", "many-to-one", "set null"],
      ["invoices", "organizationId", "organizations", "many-to-one", null],
      [
        "memberships",
        "organizationId",
        "organizations",
        "many-to-one",
        "cascade",
      ],
    ],
  );
  assert.deepEqual(
    model.enums.map((value) => [value.name, value.values]),
    [
      ["Role", ["ADMIN", "MEMBER"]],
      ["plan", ["free", "team"]],
      ["severity", ["low", "medium", "high"]],
    ],
  );
  assert.deepEqual(model.accessors, [
    {
      module: "src/services/users.ts",
      entities: ["Post", "User"],
      importers: 2,
    },
    {
      module: "src/services/members.ts",
      entities: ["memberships", "organizations"],
      importers: 1,
    },
    {
      module: "src/services/reports.ts",
      entities: ["User", "audit_log"],
      importers: 0,
    },
  ]);
  assert.deepEqual(
    model.omissions.map((omission) => [omission.code, omission.file]),
    [
      ["statement_skipped", "migrations/V1__init.sql"],
      ["statement_skipped", "migrations/V2__more.sql"],
      ["unresolved_relation", "src/db/schema.ts"],
    ],
  );
  const summary = dataModelSummarySchema.parse(files[2]?.meta);
  assert.deepEqual(summary.counts, {
    entities: 9,
    fields: 32,
    enums: 3,
    relations: 6,
    accessors: 3,
    omissions: 3,
  });
  assert.deepEqual(summary.storage, ["postgresql"]);
  assert.equal(
    summary.entities.find((e) => e.name === "memberships")?.fields[0]
      ?.foreignKey,
    true,
  );
  assert.deepEqual(files[0]?.meta, files[2]?.meta);
  const erd = texts.get("erd.mmd") ?? "";
  assert.match(erd, /^erDiagram\n/);
  assert.match(erd, /string\[\] tags "text\[\], nullable"/);
  assert.match(erd, /Profile \|o--\|\| User : "userId"/);
  assert.match(erd, /Category }o--o{ Post : "relates"/);
  assert.match(erd, /audit_log }o--o\| User : "actor"/);
  assert.ok(lines.includes("SQL migrations: replayed 2 files."));
  // The same snapshot gives the same bytes.
  const again = await runAdapter(fixture);
  assert.equal(
    again.texts.get("data-model.json"),
    texts.get("data-model.json"),
  );
});

test("a repository with no schema evidence is a success with an empty model", async () => {
  const empty = await mkdtemp(join(tmpdir(), "data-model-empty-"));
  try {
    await writeFile(join(empty, "index.ts"), "export const a = 1;\n");
    const { texts } = await runAdapter(empty, {
      nodes: [
        { id: "file:index.ts", label: "index.ts", source_file: "index.ts" },
      ],
      links: [],
    });
    const model = JSON.parse(texts.get("data-model.json") ?? "") as DataModel;
    assert.deepEqual(
      [
        model.sources,
        model.entities,
        model.relations,
        model.accessors,
        model.omissions,
      ],
      [[], [], [], [], []],
    );
    assert.equal(texts.get("erd.mmd"), "erDiagram\n");
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test("migrations follow a Drizzle Kit journal, skip unreadable files, and a bad journal falls back to names", async () => {
  const root = await mkdtemp(join(tmpdir(), "data-model-journal-"));
  try {
    await mkdir(join(root, "drizzle/meta"), { recursive: true });
    await mkdir(join(root, "db/migrations"), { recursive: true });
    await writeFile(
      join(root, "drizzle/meta/_journal.json"),
      JSON.stringify({
        entries: [
          { idx: 1, tag: "0001_b" },
          { idx: 0, tag: "0000_a" },
          { idx: "x" },
        ],
      }),
    );
    await writeFile(
      join(root, "drizzle/0000_a.sql"),
      'CREATE TABLE "t" ("id" integer PRIMARY KEY);',
    );
    await writeFile(
      join(root, "drizzle/0001_b.sql"),
      'ALTER TABLE "t" ADD COLUMN "name" text NOT NULL;',
    );
    await writeFile(
      join(root, "db/migrations/001.sql"),
      "CREATE TABLE x (id int);",
    );
    // A link is never indexed; a file past the size cap is an omission.
    await symlink("/etc/hosts", join(root, "db/migrations/000.sql"));
    await writeFile(
      join(root, "db/migrations/002.sql"),
      Buffer.alloc(2 * 1024 * 1024 + 1),
    );
    const { texts } = await runAdapter(root, { nodes: [], links: [] });
    const model = JSON.parse(texts.get("data-model.json") ?? "") as DataModel;
    assert.deepEqual(
      model.entities.map((entity) => [
        entity.name,
        entity.fields.map((f) => f.name),
      ]),
      [
        ["t", ["id", "name"]],
        ["x", ["id"]],
      ],
    );
    assert.deepEqual(
      model.omissions.map((omission) => [omission.code, omission.file]),
      [["read_failed", "db/migrations/002.sql"]],
    );
    await writeFile(join(root, "drizzle/meta/_journal.json"), "{ not json");
    const fallback = JSON.parse(
      (await runAdapter(root, { nodes: [], links: [] })).texts.get(
        "data-model.json",
      ) ?? "",
    ) as DataModel;
    assert.ok(
      fallback.omissions.some(
        (omission) =>
          omission.code === "parse_failed" &&
          omission.file === "drizzle/meta/_journal.json",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the adapter refuses other parameters and a missing graph", async () => {
  await assert.rejects(
    runAdapter(fixture, graphJson(), { deadlineMinutes: 30 }),
    (error: unknown) =>
      error instanceof AnalysisError && error.code === "tool_failed",
  );
  const out = await mkdtemp(join(tmpdir(), "data-model-"));
  try {
    await assert.rejects(
      createDataModelAdapter().run({
        ...toolContext(),
        sourceDir: fixture,
        outDir: out,
        params,
        inputs: { ...inputsFor(graphJson()), getRun: async () => null },
        signal: new AbortController().signal,
        log: () => {},
      }),
      (error: unknown) =>
        error instanceof AnalysisError && error.code === "graph_unavailable",
    );
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("the source reader refuses paths outside the root, links and oversized files", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-"));
  try {
    await writeFile(join(root, "a.txt"), "hello");
    await writeFile(join(root, "big.txt"), Buffer.alloc(2 * 1024 * 1024 + 1));
    await symlink(join(root, "a.txt"), join(root, "link.txt"));
    const read = sourceReader(root);
    assert.equal(await read("a.txt"), "hello");
    assert.equal(await read("a.txt"), "hello");
    assert.equal(await read("../etc/passwd"), null);
    assert.equal(await read(""), null);
    assert.equal(await read("link.txt"), null);
    assert.equal(await read("big.txt"), null);
    assert.equal(await read("missing.txt"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the Prisma parser reads blocks, fields, attributes and values, and reports where it stops", () => {
  const blocks = parsePrismaSchema(
    [
      "// comment",
      "generator client {",
      '  provider = "prisma-client-js"',
      '  previewFeatures = ["views", "multiSchema"]',
      "}",
      "model A {",
      '  id    String  @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid',
      "  n     Decimal @db.Decimal(10, 2) @default(1.5)",
      '  blob  Unsupported("tsvector")?',
      '  esc   String  @default("a\\"b\\n\\tc")',
      "  @@index([n(sort: Desc)])",
      '  @@schema("audit")',
      "}",
    ].join("\n"),
  );
  assert.deepEqual(
    blocks.map((block) => [block.keyword, block.name, block.line]),
    [
      ["generator", "client", 2],
      ["model", "A", 6],
    ],
  );
  const model = blocks[1];
  assert.equal(model?.fields[2]?.type, 'Unsupported("tsvector")');
  assert.equal(model?.fields[2]?.optional, true);
  assert.equal(
    renderPrismaValue(
      model?.fields[0]?.attributes[1]?.args[0]?.value ?? {
        kind: "name",
        value: "",
      },
    ),
    'dbgenerated("gen_random_uuid()")',
  );
  assert.equal(model?.fields[1]?.attributes[0]?.name, "db.Decimal");
  assert.equal(
    renderPrismaValue(
      model?.attributes[0]?.args[0]?.value ?? { kind: "name", value: "" },
    ),
    "[n(sort: Desc)]",
  );
  assert.equal(
    renderPrismaValue(
      model?.fields[3]?.attributes[0]?.args[0]?.value ?? {
        kind: "name",
        value: "",
      },
    ),
    JSON.stringify('a"b\n\tc'),
  );
  for (const [text, message] of [
    [
      'model A {\n  name String @default("open\n}',
      /Line 2: unterminated string/,
    ],
    ["model A {\n  id Int\n", /Line 1: model A is not closed/],
    ["model A {\n  id Int Int\n}", /unexpected text after id/],
    ["model A {\n  id Int @default(\n}", /expected a value|expected a name/],
    ["model A {\n  id ~Int\n}", /unexpected character/],
    ["model {\n}", /expected a name/],
    ["model A [\n]", /expected \{/],
  ] as const)
    assert.throws(() => parsePrismaSchema(text), message);
});

test("the Prisma recognizer records a schema it cannot read, a composite type and a relation to nothing", () => {
  const source = recognizePrisma(
    [
      {
        path: "a.prisma",
        text: "model A {\n  id Int @id\n  b B @relation(fields: [bId], references: [id])\n  bId Int\n  addr Address\n  ghosts Ghost[]\n}\ntype Address {\n  street String\n}\nmodel Ghost {\n  id Int @id\n  a A[]\n}",
      },
      { path: "b.prisma", text: "model {" },
    ],
    [],
  );
  assert.equal(source.storage, "unknown");
  assert.deepEqual(
    source.omissions.map((omission) => omission.code),
    ["parse_failed"],
  );
  // `B` is no model, so `b` is not a relation field and `bId` a plain Int.
  const a = source.entities.find((entity) => entity.name === "A");
  assert.deepEqual(
    a?.fields.map((field) => [field.name, field.type]),
    [
      ["id", "integer"],
      ["b", "unknown"],
      ["bId", "integer"],
      ["addr", "json"],
    ],
  );
  // A list on one side only, with no foreign key, is not a relation.
  assert.deepEqual(
    source.relations.map((r) => r.cardinality),
    ["many-to-many"],
  );
  const dangling = recognizePrisma(
    [
      {
        path: "c.prisma",
        text: "model C {\n  id Int @id\n  d D @relation(fields: [dId], references: [id], onUpdate: Restrict)\n  dId Int\n}\nmodel D {\n  id Int @id\n  @@ignore\n}",
      },
    ],
    [],
  );
  assert.deepEqual(
    dangling.entities.map((e) => e.name),
    ["C"],
  );
});

test("SQL migrations replay renames, drops, enums and indexes in order, and skip what they cannot", async () => {
  const source = await replaySqlMigrations(
    [
      {
        path: "1.sql",
        text: [
          "CREATE SCHEMA app;",
          "BEGIN;",
          "CREATE TYPE mood AS ENUM ('sad', 'ok');",
          "CREATE TABLE app.people (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NULL, mood mood, n numeric(10, 2) DEFAULT -1, created date DEFAULT CURRENT_DATE, flags boolean[] DEFAULT ARRAY[true, false], code text GENERATED ALWAYS AS ('x') STORED, seq integer GENERATED ALWAYS AS IDENTITY, f real DEFAULT 1.5, nothing text DEFAULT NULL, other text DEFAULT lower('A'), off boolean DEFAULT false);",
          "CREATE TABLE pets (id int, owner uuid, CONSTRAINT pets_pk PRIMARY KEY (id), CONSTRAINT pets_owner_fk FOREIGN KEY (owner) REFERENCES app.people);",
          "CREATE TABLE IF NOT EXISTS pets (id int);",
          "CREATE TABLE gone (id int);",
          "CREATE VIEW v AS SELECT 1;",
          "CREATE UNIQUE INDEX pets_owner_idx ON pets (owner);",
          "CREATE UNIQUE INDEX pets_lower ON pets (lower(owner::text));",
          "COMMIT;",
        ].join("\n"),
      },
      {
        path: "2.sql",
        text: [
          "ALTER TYPE mood ADD VALUE 'glad' AFTER 'ok';",
          "ALTER TYPE mood ADD VALUE 'meh';",
          "ALTER TYPE mood ADD VALUE IF NOT EXISTS 'meh';",
          "ALTER TYPE mood RENAME VALUE 'sad' TO 'blue';",
          "ALTER TYPE missing ADD VALUE 'x';",
          "ALTER TABLE pets RENAME TO animals;",
          "ALTER TABLE animals RENAME COLUMN owner TO keeper;",
          "ALTER TABLE animals RENAME CONSTRAINT pets_owner_fk TO animals_keeper_fk;",
          "ALTER TABLE app.people RENAME COLUMN id TO person_id;",
          "ALTER TABLE animals ALTER COLUMN id TYPE bigint, ALTER COLUMN keeper SET NOT NULL, ALTER COLUMN keeper DROP NOT NULL, ALTER COLUMN id SET DEFAULT 7, ALTER COLUMN id DROP DEFAULT;",
          "ALTER TABLE animals ADD COLUMN IF NOT EXISTS id int;",
          "ALTER TABLE animals ADD COLUMN legs smallint NOT NULL DEFAULT 4;",
          "ALTER TABLE animals DROP CONSTRAINT animals_keeper_fk;",
          "ALTER TABLE animals ADD CONSTRAINT keeper_fk FOREIGN KEY (keeper) REFERENCES app.people (person_id) ON DELETE RESTRICT ON UPDATE CASCADE;",
          "ALTER TABLE animals DROP CONSTRAINT pets_pk;",
          "ALTER TABLE animals ADD PRIMARY KEY (id);",
          "ALTER TABLE animals ADD CONSTRAINT animals_legs UNIQUE (legs);",
          "ALTER TABLE animals DROP COLUMN legs;",
          "ALTER TABLE IF EXISTS nowhere ADD COLUMN x int;",
          "ALTER TABLE nowhere ADD COLUMN x int;",
          "ALTER TABLE animals ENABLE ROW LEVEL SECURITY;",
          "ALTER INDEX pets_owner_idx RENAME TO keeper_idx;",
          "DROP INDEX pets_owner_idx;",
          "DROP TABLE gone;",
          "DROP TYPE IF EXISTS unused;",
          "CREATE TABLE refs (id int REFERENCES nowhere (id), animal int REFERENCES animals);",
          "CREATE TABLE copy AS SELECT * FROM animals;",
          "DO $$ BEGIN RAISE NOTICE 'hi'; END $$;",
          "DO $$ BEGIN\n ALTER TABLE animals ADD CONSTRAINT x CHECK (id > 0);\nEXCEPTION WHEN duplicate_object THEN null;\nEND $$;",
          "DO $$ BEGIN\n not sql at all;\nEXCEPTION WHEN duplicate_object THEN null;\nEND $$;",
          "UPDATE animals SET id = 1;",
          "LISTEN channel;",
        ].join("\n"),
      },
      { path: "3.sql", text: "CREATE TABLE `mysql` (id int);" },
    ],
    ["migrations:db"],
  );
  const entity = (name: string) => source.entities.find((e) => e.name === name);
  assert.deepEqual(
    source.entities.map((e) => e.name),
    // A rename re-files the table under its new name.
    ["app.people", "v", "animals", "refs", "copy"],
  );
  const people = entity("app.people");
  assert.deepEqual(
    people?.fields.map((field) => [
      field.name,
      field.type,
      field.nativeType,
      field.nullable,
      field.default,
    ]),
    [
      ["person_id", "uuid", "uuid", false, "gen_random_uuid()"],
      ["name", "string", "text", true, null],
      ["mood", "enum", "mood", true, null],
      ["n", "decimal", "numeric(10, 2)", true, "-1"],
      ["created", "date", "date", true, "CURRENT_DATE"],
      ["flags", "boolean", "boolean[]", true, "ARRAY[true, false]"],
      ["code", "string", "text", true, "generated"],
      ["seq", "integer", "integer", false, "identity"],
      ["f", "float", "real", true, "1.5"],
      ["nothing", "string", "text", true, "NULL"],
      ["other", "string", "text", true, "lower('A')"],
      ["off", "boolean", "boolean", true, "false"],
    ],
  );
  assert.deepEqual(people?.primaryKey, ["person_id"]);
  const animals = entity("animals");
  assert.deepEqual(
    animals?.fields.map((field) => [
      field.name,
      field.nativeType,
      field.nullable,
      field.default,
      field.unique,
      field.primaryKey,
    ]),
    [
      ["id", "bigint", false, null, false, true],
      ["keeper", "uuid", true, null, false, false],
    ],
  );
  assert.equal(animals?.line, 5);
  assert.equal(entity("v")?.kind, "view");
  assert.deepEqual(
    source.relations.map((r) => [
      r.name,
      r.from.entity,
      r.from.fields,
      r.to.entity,
      r.to.fields,
      r.cardinality,
      r.onDelete,
      r.onUpdate,
    ]),
    [
      [
        "keeper_fk",
        "animals",
        ["keeper"],
        "app.people",
        ["person_id"],
        "many-to-one",
        "restrict",
        "cascade",
      ],
      [
        null,
        "refs",
        ["animal"],
        "animals",
        ["id"],
        "many-to-one",
        "no action",
        "no action",
      ],
    ],
  );
  assert.deepEqual(
    source.enums.map((e) => [e.name, e.values]),
    [["mood", ["blue", "ok", "glad", "meh"]]],
  );
  assert.deepEqual(
    source.omissions.map((omission) => [
      omission.code,
      omission.file,
      omission.detail,
    ]),
    [
      [
        "expression_skipped",
        "1.sql",
        "v's columns come from a query, which is not evaluated.",
      ],
      [
        "unknown_table",
        "2.sql",
        "AlterTableStmt names nowhere, which no earlier migration created.",
      ],
      [
        "expression_skipped",
        "2.sql",
        "copy's columns come from a query, which is not evaluated.",
      ],
      ["statement_skipped", "2.sql", "2 DO statements were not replayed."],
      ["statement_skipped", "2.sql", "1 Listen statement was not replayed."],
      ["statement_skipped", "2.sql", "1 UPDATE statement was not replayed."],
      ["parse_failed", "3.sql", source.omissions[6]?.detail ?? ""],
      [
        "unresolved_relation",
        "2.sql",
        "refs references nowhere, which the migrations do not create.",
      ],
    ],
  );
  assert.match(
    source.omissions[6]?.detail ?? "",
    /^Not Postgres SQL the parser accepts/,
  );
});

test("expressions render as SQL, and anything else reads as an expression", () => {
  assert.equal(renderExpression({ A_Const: { ival: {} } }), "0");
  assert.equal(renderExpression({ A_Const: { boolval: {} } }), "false");
  assert.equal(renderExpression({ A_Const: { fval: {} } }), "0");
  assert.equal(renderExpression({ A_Const: {} }), "(expression)");
  assert.equal(
    renderExpression({ A_Const: { sval: { sval: "it's" } } }),
    "'it''s'",
  );
  assert.equal(
    renderExpression({
      FuncCall: { funcname: [{ String: { sval: "count" } }], agg_star: true },
    }),
    "count(*)",
  );
  assert.equal(
    renderExpression({
      ColumnRef: {
        fields: [{ String: { sval: "a" } }, { String: { sval: "b" } }],
      },
    }),
    "a.b",
  );
  assert.equal(
    renderExpression({ SQLValueFunction: { op: "SVFOP_NOPE" } }),
    "(expression)",
  );
  assert.equal(
    renderExpression({ A_Expr: { kind: "AEXPR_IN" } }),
    "(expression)",
  );
  assert.equal(
    renderExpression({
      A_Expr: {
        kind: "AEXPR_OP",
        name: [{ String: { sval: "+" } }],
        lexpr: { A_Const: { ival: { ival: 1 } } },
        rexpr: { A_Const: { ival: { ival: 2 } } },
      },
    }),
    "1 + 2",
  );
  assert.equal(renderExpression({ SubLink: {} }), "(expression)");
  assert.equal(renderExpression(null), "(expression)");
});

test("migrations are ordered by the tool's journal, else naturally, without rollbacks", () => {
  assert.deepEqual(
    orderMigrations([
      {
        directory: "z",
        files: [
          "z/V10__c.sql",
          "z/V2__b.sql",
          "z/V1__a.sql",
          "z/U1__a.sql",
          "z/V1__a.down.sql",
        ],
        journal: null,
      },
      {
        directory: "a",
        files: ["a/0001_y.sql", "a/0000_x.sql", "a/extra.sql", "a/down.sql"],
        journal: ["0001_y", "0000_x", "0002_missing"],
      },
    ]),
    [
      "a/0001_y.sql",
      "a/0000_x.sql",
      "a/extra.sql",
      "z/V1__a.sql",
      "z/V2__b.sql",
      "z/V10__c.sql",
    ],
  );
  assert.equal(naturalCompare("a2", "a10") < 0, true);
  assert.equal(naturalCompare("a10", "a2") > 0, true);
  assert.equal(naturalCompare("same", "same"), 0);
  assert.equal(naturalCompare("01", "1") < 0, true);
});

test("the Drizzle recognizer reads MySQL and SQLite tables, callback columns and every extra-config form", () => {
  const source = recognizeDrizzle(
    [
      {
        path: "my.ts",
        text: [
          'import { mysqlTable, int, varchar, mysqlEnum, datetime, foreignKey, uniqueIndex, decimal } from "drizzle-orm/mysql-core";',
          'export const kind = mysqlEnum("kind", ["a", "b"]);',
          'export const shelves = mysqlTable("shelves", { id: int("id").primaryKey().autoincrement() });',
          "export const books = mysqlTable(",
          '  "books",',
          "  (t) => ({",
          '    id: t.int("id").generatedAlwaysAsIdentity(),',
          '    shelf: int("shelf_id"),',
          '    title: varchar("title", { length: 120 }).$defaultFn(() => "x"),',
          '    price: decimal("price", { precision: 8, scale: 2 }),',
          '    at: datetime("at"),',
          '    kind: kind("kind"),',
          "    weird: someCustomThing(),",
          "    ...elsewhere,",
          "    computed: 1 + 1,",
          '    owner: int("owner").references(lookup),',
          "  }),",
          "  (t) => {",
          "    return {",
          "      pk: primaryKey(t.id),",
          '      shelfRef: foreignKey({ columns: [t.shelf], foreignColumns: [shelves.id], name: "book_shelf" }).onDelete("set null").onUpdate("cascade"),',
          '      byTitle: uniqueIndex("by_title").on(t.title),',
          "      broken: foreignKey({ columns: [t.shelf], foreignColumns: [] }),",
          "      plain: index().on(t.at),",
          "      odd: 42,",
          "    };",
          "  },",
          ");",
          "const name = 'dynamic';",
          "export const dynamic = mysqlTable(name, {});",
          'export const notObject = mysqlTable("no_object", columnsFromSomewhere);',
          'const hidden = mysqlTable("hidden", { id: int("id").$default(() => 1) });',
          'const other = notASchema.table("other", {});',
          "export let unrelated;",
        ].join("\n"),
      },
      {
        path: "lite.js",
        text: 'import { sqliteTable, integer, blob } from "drizzle-orm/sqlite-core";\nexport const files = sqliteTable("files", { id: integer("id").primaryKey(), data: blob("data"), ts: helper() });\nconst helper = () => { return integer("x"); };\nexport const view = sqliteView("v").as((qb) => qb.select().from(files));',
      },
    ],
    ["dependency:drizzle-orm/mysql-core"],
  );
  assert.equal(source.storage, "mysql");
  const books = source.entities.find((entity) => entity.name === "books");
  assert.deepEqual(
    books?.fields.map((field) => [
      field.name,
      field.column,
      field.nativeType,
      field.type,
      field.nullable,
      field.default,
      field.unique,
      field.primaryKey,
    ]),
    [
      ["id", "id", "integer", "integer", false, "identity", false, true],
      ["shelf", "shelf_id", "integer", "integer", true, null, false, false],
      [
        "title",
        "title",
        "varchar(120)",
        "string",
        true,
        "(function)",
        true,
        false,
      ],
      ["price", "price", "decimal(8, 2)", "decimal", true, null, false, false],
      ["at", "at", "datetime", "datetime", true, null, false, false],
      ["kind", "kind", "kind", "enum", true, null, false, false],
      ["owner", "owner", "integer", "integer", true, null, false, false],
    ],
  );
  assert.equal(
    source.entities.find((entity) => entity.name === "shelves")?.fields[0]
      ?.default,
    "autoincrement",
  );
  assert.deepEqual(
    source.relations.map((r) => [
      r.name,
      r.from.entity,
      r.from.fields,
      r.to.entity,
      r.onDelete,
      r.onUpdate,
    ]),
    [["book_shelf", "books", ["shelf"], "shelves", "set null", "cascade"]],
  );
  assert.deepEqual(source.entities.map((entity) => entity.name).sort(), [
    "books",
    "files",
    "hidden",
    "notObject",
    "shelves",
    "view",
  ]);
  assert.equal(
    source.entities.find((entity) => entity.name === "files")?.fields.length,
    2,
  );
  assert.deepEqual(
    source.omissions.map((omission) => omission.detail),
    [
      "dynamic's table name is not a string literal.",
      "books spreads columns this recognizer cannot follow.",
      "books.weird is not a column builder this recognizer knows.",
      "books.computed is not a column builder this recognizer knows.",
      "books.owner references a column this recognizer cannot read.",
      "notObject's columns are not an object literal.",
      "files.ts is not a column builder this recognizer knows.",
    ],
  );
  // Only exported tables are definitions others can import.
  assert.deepEqual(
    [...(source.definitions.get("my.ts")?.keys() ?? [])],
    ["shelves", "books", "notObject"],
  );
});

test("accessors follow barrels to their depth, and ignore names a file does not take", async () => {
  const texts = new Map([
    ["db/schema.ts", "export const a = pgTable(); export const b = pgTable();"],
    [
      "db/index.ts",
      'export { a as alpha } from "./schema.js"; export * from "./schema.js";',
    ],
    ["svc/one.ts", 'import { alpha } from "../db/index.js";'],
    [
      "svc/two.ts",
      'import * as db from "../db/schema.js"; import "./side.js";',
    ],
    ["svc/three.ts", 'import { unrelated } from "../db/schema.js";'],
    ["svc/four.ts", "import def from '../db/schema.js';"],
    ["svc/js.js", 'import { b } from "../db/schema.js";'],
  ]);
  const graph = parseSliceGraph({
    nodes: [
      ...[...texts.keys(), "svc/gone.ts", "test/a.test.ts"].map((file) => ({
        id: `file:${file}`,
        label: file,
        source_file: file,
      })),
      { id: "symbol:db/schema.ts:a", label: "a", source_file: "db/schema.ts" },
    ],
    links: [
      {
        source: "file:db/index.ts",
        target: "file:db/schema.ts",
        relation: "imports",
        specifier: "./schema.js",
      },
      {
        source: "file:svc/one.ts",
        target: "file:db/index.ts",
        relation: "imports",
        specifier: "../db/index.js",
      },
      {
        source: "file:svc/two.ts",
        target: "file:db/schema.ts",
        relation: "imports",
        specifier: "../db/schema.js",
      },
      {
        source: "file:svc/three.ts",
        target: "file:db/schema.ts",
        relation: "imports",
        specifier: "../db/schema.js",
      },
      {
        source: "file:svc/four.ts",
        target: "file:db/schema.ts",
        relation: "imports",
        specifier: "../db/schema.js",
      },
      {
        source: "file:svc/js.js",
        target: "file:db/schema.ts",
        relation: "imports",
        specifier: "../db/schema.js",
      },
      {
        source: "file:svc/gone.ts",
        target: "file:db/schema.ts",
        relation: "imports",
        specifier: "../db/schema.js",
      },
      {
        source: "file:svc/two.ts",
        target: "symbol:db/schema.ts:a",
        relation: "imports",
        specifier: null,
      },
      {
        source: "file:svc/two.ts",
        target: "file:svc/two.ts",
        relation: "imports",
        specifier: "./two.js",
      },
      {
        source: "file:svc/two.ts",
        target: "file:svc/one.ts",
        relation: "calls",
        specifier: null,
      },
      {
        source: "file:test/a.test.ts",
        target: "file:db/schema.ts",
        relation: "imports",
        specifier: "../db/schema.js",
      },
    ],
  });
  const entity = (name: string) => ({
    name,
    table: name,
    kind: "table" as const,
    source: "drizzle" as const,
    file: "db/schema.ts",
    line: 1,
    fields: [],
    primaryKey: [],
    uniques: [],
  });
  const accessors = await findAccessors({
    graph,
    read: async (path) => texts.get(path) ?? null,
    modules: [...texts.keys()],
    entities: [entity("a"), entity("b")],
    drizzle: new Map([
      [
        "db/schema.ts",
        new Map([
          ["a", "a"],
          ["b", "b"],
          ["c", "c"],
        ]),
      ],
    ]),
    importers: new Map([["svc/two.ts", 4]]),
  });
  assert.deepEqual(accessors, [
    { module: "svc/two.ts", entities: ["a", "b"], importers: 4 },
    { module: "svc/js.js", entities: ["b"], importers: 0 },
    { module: "svc/one.ts", entities: ["a"], importers: 0 },
  ]);
});

test("a DO block of mostly whitespace is read in time, not backtracked", async () => {
  // The idiom was one pattern whose lazy body sat between two runs of
  // whitespace; a few thousand spaces took seconds, twenty thousand far
  // longer, all on the worker's one thread.
  const started = Date.now();
  const source = await replaySqlMigrations(
    [
      {
        path: "1.sql",
        text: `CREATE TABLE t (id int);\nDO $$BEGIN ${" ".repeat(20_000)}x$$;`,
      },
    ],
    ["migrations:db"],
  );
  assert.ok(Date.now() - started < 2_000);
  assert.deepEqual(
    source.entities.map((entity) => entity.name),
    ["t"],
  );
});

test("a goose or dbmate rollback in the same file is not replayed", async () => {
  // Replayed, the down section's DROP undid the CREATE above it, and the
  // table vanished from the model.
  const source = await replaySqlMigrations(
    [
      {
        path: "001_people.sql",
        text: "-- +goose Up\nCREATE TABLE people (id int);\n-- +goose Down\nDROP TABLE people;\n",
      },
      {
        path: "002_pets.sql",
        text: "-- migrate:up\nCREATE TABLE pets (id int);\n\n-- migrate:down\nDROP TABLE pets;\n",
      },
    ],
    ["migrations:db"],
  );
  assert.deepEqual(
    source.entities.map((entity) => entity.name),
    ["people", "pets"],
  );
  assert.equal(
    upSection("CREATE TABLE t (id int);"),
    "CREATE TABLE t (id int);",
  );
});
