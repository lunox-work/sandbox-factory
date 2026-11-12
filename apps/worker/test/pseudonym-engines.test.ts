/**
 * The move of the platform's renaming and vocabulary scan onto carveout
 * 0.3.0's (`carveout/pseudonyms`), held to what carveout documents: the
 * frozen renaming (`applyAliasesV1`) and carveout's give the same files,
 * renames and problems for every worker fixture build and the build tests'
 * tables, but where a path rule meets its name after a `/`; a build blocks
 * on both scans; and a build's manifest names the renaming it carries
 * back under.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  ALIASES_V1,
  CURRENT_ALIASES,
  applyAliasesV1,
  tooCommonAlone,
  vocabularyLeaksV1,
} from "carveout/pseudonyms";
import {
  applyAliases,
  draftPseudonyms,
  organizationNames,
  vocabularyLeaks,
  workspaceVocabulary,
} from "sandbox-factory";
import type { AliasRule, AliasedFile } from "sandbox-factory";
import {
  BUILD_ENGINES,
  CARVEOUT_VERSION,
  aliasesOf,
} from "../src/tools/engines.js";
import { publicLeaks } from "../src/tools/vocabulary-check.js";
import { slice } from "./fixture-slice.js";

const fixtures = fileURLToPath(new URL("../../fixtures/", import.meta.url));

async function filesOf(root: string): Promise<AliasedFile[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  const files: AliasedFile[] = [];
  for (const entry of entries)
    if (entry.isFile()) {
      const absolute = join(entry.parentPath, entry.name);
      files.push({
        path: relative(root, absolute),
        text: await readFile(absolute, "utf8"),
      });
    }
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Every fixture build's inputs: each fixture repository, and the fixture slice's stubs beside its source. */
async function fixtureBuilds(): Promise<
  { name: string; files: AliasedFile[] }[]
> {
  const builds: { name: string; files: AliasedFile[] }[] = [];
  for (const entry of await readdir(fixtures, { withFileTypes: true }))
    if (entry.isDirectory())
      builds.push({
        name: entry.name,
        files: await filesOf(join(fixtures, entry.name)),
      });
  const sliced = await slice();
  const stubs = sliced.artifacts
    .filter((artifact) => artifact.kind === "stub")
    .map((artifact) => ({
      path: artifact.path.replace(/^stubs\//, ""),
      text:
        sliced.objects.get(artifact.objectKey)?.toString("utf8") ??
        assert.fail(artifact.path),
    }));
  const included = new Set(sliced.manifest.included.map((file) => file.path));
  builds.push({
    name: "slice build",
    files: [
      ...(builds.find((build) => build.name === "slice")?.files ?? []).filter(
        (file) => included.has(file.path),
      ),
      ...stubs,
    ],
  });
  return builds;
}

/** The sandbox-build tests' tables, each a table a fixture build was renamed by. */
const BUILD_TEST_TABLES: readonly (readonly AliasRule[])[] = [
  [{ before: "retries", after: "attempts", kind: "identifier", paths: [] }],
  [
    {
      before: "createService",
      after: "makeService",
      kind: "identifier",
      paths: [],
    },
  ],
  [
    { before: "name", after: "aliasedName", kind: "identifier", paths: [] },
    { before: "kind", after: "aliasedKind", kind: "identifier", paths: [] },
  ],
  [{ before: "run", after: "client", kind: "identifier", paths: [] }],
  [
    { before: "pg", after: "store", kind: "identifier", paths: [] },
    {
      before: "DATABASE_URL",
      after: "STORE_URL",
      kind: "identifier",
      paths: [],
    },
  ],
  [
    { before: "pg", after: "Store", kind: "identifier", paths: [] },
    { before: "DATABASE_URL", after: "store url", kind: "text", paths: [] },
  ],
];

/** Tables made from a build's own files: its exports renamed, and its top folders. */
function ownTables(files: readonly AliasedFile[]): AliasRule[][] {
  const exported = [
    ...new Set(
      files.flatMap((file) =>
        [
          ...file.text.matchAll(
            /export (?:declare )?(?:const|function|class|interface|type) ([A-Za-z_]\w*)/g,
          ),
        ].map((match) => match[1] ?? ""),
      ),
    ),
  ]
    .filter((name) => name.length > 2)
    .slice(0, 6);
  const folders = [
    ...new Set(
      files
        .map((file) => file.path.split("/"))
        .filter((parts) => parts.length > 1)
        .map((parts) => parts[0] ?? ""),
    ),
  ];
  return [
    exported.map((name) => ({
      before: name,
      after: `${name}Renamed`,
      kind: "identifier" as const,
      paths: [],
    })),
    folders.map((folder) => ({
      before: folder,
      after: `${folder}-renamed`,
      kind: "path" as const,
      paths: [],
    })),
    draftPseudonyms({
      files,
      vocabulary: workspaceVocabulary(exported.slice(0, 2)),
      imports: [],
    }),
  ].filter((table) => table.length > 0);
}

/**
 * carveout's one documented difference these tables can meet: a path
 * rule's name after a `/` (`../lib/service.js`) is renamed too.
 */
function pathRuleAfterSlash(text: string, rules: readonly AliasRule[]) {
  let out = text;
  for (const rule of rules)
    if (rule.kind === "path")
      out = out.replace(
        new RegExp(
          `(?<=/)${rule.before.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_\\-@])`,
          "g",
        ),
        rule.after,
      );
  return out;
}

test("the frozen renaming and carveout's give every fixture build the same files, renames and problems, but for a path rule after a `/`", async () => {
  let compared = 0;
  let differing = 0;
  let sharedTargets = 0;
  for (const { name, files } of await fixtureBuilds())
    for (const rules of [...BUILD_TEST_TABLES, ...ownTables(files)]) {
      const legacy = applyAliasesV1(files, rules);
      const current = applyAliases(files, rules);
      const at = `${name}: ${JSON.stringify(rules)}`;
      compared += 1;
      // carveout's draft gives a term one placeholder as a path and as an
      // identifier: a target an earlier rule put there, which the frozen
      // renaming refused and carveout's lets through on the round trip.
      if (
        current.problems.length === 0 &&
        legacy.problems.length > 0 &&
        legacy.problems.every(
          (problem) =>
            problem.code === "target_collision" &&
            problem.rule !== null &&
            rules
              .slice(0, problem.rule)
              .some((earlier) =>
                earlier.after.includes(rules[problem.rule ?? 0]?.after ?? "-"),
              ),
        )
      ) {
        sharedTargets += 1;
        continue;
      }
      assert.deepEqual(current.problems, legacy.problems, at);
      const same =
        current.files.every(
          (file, index) =>
            file.path === legacy.files[index]?.path &&
            file.text === legacy.files[index]?.text,
        ) && JSON.stringify(current.renames) === JSON.stringify(legacy.renames);
      if (same) {
        assert.deepEqual(current.applied, legacy.applied, at);
        continue;
      }
      differing += 1;
      // Each file carveout renamed differently, path or text, is the frozen
      // renaming's with the path rules' names after a `/` renamed too.
      assert.ok(
        rules.some((rule) => rule.kind === "path"),
        at,
      );
      const expected = legacy.files.map((file) => ({
        path: pathRuleAfterSlash(file.path, rules),
        text: pathRuleAfterSlash(file.text, rules),
      }));
      assert.deepEqual(
        current.files.map(({ path, text }) => ({ path, text })),
        expected,
        at,
      );
      assert.deepEqual(
        current.renames,
        files
          .map((file, index) => ({
            from: file.path,
            to: expected[index]?.path ?? "",
          }))
          .filter((rename) => rename.from !== rename.to),
        at,
      );
    }
  assert.ok(compared >= 30, `${compared} builds and tables compared`);
  // The slice fixture imports `../lib/…`: its folder table meets the
  // difference; carveout's drafts share targets on some fixtures.
  assert.ok(differing > 0);
  assert.ok(sharedTargets > 0);
});

test("carveout's other documented renaming differences, each on its own", () => {
  // A path may hold a space or brackets now; the frozen renaming refused it.
  const spaced: AliasRule[] = [
    {
      before: "Lunox Logo.png",
      after: "Brand Logo.png",
      kind: "path",
      paths: [],
    },
  ];
  const files = [{ path: "assets/Lunox Logo.png", text: "png" }];
  assert.ok(applyAliasesV1(files, spaced).problems.length > 0);
  assert.deepEqual(applyAliases(files, spaced).problems, []);
  // A rule's target may occur where an earlier rule put it: a path and an
  // identifier that give one term the same placeholder.
  const shared: AliasRule[] = [
    { before: "lunox", after: "zorvex", kind: "path", paths: [] },
    { before: "lunox", after: "zorvex", kind: "identifier", paths: [] },
  ];
  const both = [
    {
      path: "src/a.ts",
      text: 'import { lunox } from "lunox/a.js";\nexport const b = lunox;\n',
    },
  ];
  assert.deepEqual(
    applyAliasesV1(both, shared).problems.map((problem) => problem.code),
    ["target_collision"],
  );
  const renamed = applyAliases(both, shared);
  assert.deepEqual(renamed.problems, []);
  assert.equal(
    renamed.files[0]?.text,
    'import { zorvex } from "zorvex/a.js";\nexport const b = zorvex;\n',
  );
});

test("a build blocks on both scans: a one-word workspace name and a name split by a folder are still found", () => {
  const files = [
    {
      path: "src/search.ts",
      text: "export function search(q) { return q; }\n",
    },
    { path: "src/sandbox/factory.ts", text: "export const f = 1;\n" },
  ];
  // A workspace called `search`: too common for carveout's own scan of a
  // repository's names, but the platform's vocabulary keeps it.
  assert.equal(tooCommonAlone("search"), true);
  const search = workspaceVocabulary(organizationNames(["search"]));
  assert.deepEqual(search, ["search"]);
  assert.deepEqual(
    publicLeaks(files, search).map((leak) => leak.term),
    ["search"],
  );
  // `sandbox-factory` across a `/`: the frozen scan joins its words there,
  // carveout's does not; the build blocks on it all the same.
  const vocabulary = workspaceVocabulary(["sandbox-factory"]);
  assert.deepEqual(vocabularyLeaks(files, vocabulary), []);
  assert.equal(vocabularyLeaksV1(files, vocabulary).length, 1);
  assert.deepEqual(
    publicLeaks(files, vocabulary).map((leak) => [leak.term, leak.files]),
    [["sandbox-factory", ["src/sandbox/factory.ts"]]],
  );
});

test("a build records the carveout release, and carries back under the renaming its manifest names", () => {
  const { version } = createRequire(import.meta.url)(
    "carveout/package.json",
  ) as { version: string };
  assert.equal(CARVEOUT_VERSION, version);
  assert.deepEqual(BUILD_ENGINES, { carveout: version });
  assert.equal(aliasesOf({}), ALIASES_V1);
  assert.equal(aliasesOf({ engines: { carveout: version } }), CURRENT_ALIASES);
});
