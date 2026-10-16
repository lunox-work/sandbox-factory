/**
 * What the `documents` and `brief` context builders write.
 *
 * `documents.json` keeps a repository's Markdown documents at one commit,
 * every one a sync could read (`repositoryDocuments`), so a bounty's
 * context is read from storage rather than GitHub.
 *
 * `brief.md` is one bounded document per snapshot, drawn from what the
 * other builders made: the stack, the layout and where the tests live from
 * the file list, the most imported modules with their surfaces from the
 * abstractions, the entities and the modules that touch them from the data
 * model, and the README and guides from the documents. It is what the
 * price reads of every connected repository, so it is capped, and its
 * sections run most telling first: a reader with less room keeps a prefix
 * (`cutBrief`). Pure and deterministic: two builds of one commit give one
 * brief.
 */

import type { GithubContextDocument } from "../sources.js";
import {
  dominantExtensions,
  ROOT_MODULE,
  type TreeFacts,
} from "../repo/tree.js";
import type { AbstractionIndex } from "./abstractions.js";
import type { DataModel } from "./data-model.js";

export const DOCUMENT_SET_SCHEMA_VERSION = 1;

/** `documents.json`. */
export interface DocumentSet {
  readonly schemaVersion: typeof DOCUMENT_SET_SCHEMA_VERSION;
  readonly toolVersion: string;
  readonly sourceSnapshotId: string;
  readonly sourceCommitSha: string;
  /** In the order a title naming none of them would read them. */
  readonly documents: readonly GithubContextDocument[];
  /** Documents found past `REPOSITORY_DOCUMENTS_MAX`. */
  readonly omitted: number;
}

/** The most characters a brief runs to. */
export const BRIEF_MAX_CHARS = 8_000;
/** The most characters every repository's brief runs to together. */
export const WORKSPACE_BRIEF_MAX_CHARS = 24_000;
/** The fewest characters one repository's brief is cut to among many. */
const BRIEF_MIN_CHARS = 1_500;

/** How many characters each of a workspace's repositories' briefs runs to. */
export function briefCharsEach(repositories: number): number {
  return Math.min(
    BRIEF_MAX_CHARS,
    Math.max(
      BRIEF_MIN_CHARS,
      Math.floor(WORKSPACE_BRIEF_MAX_CHARS / Math.max(1, repositories)),
    ),
  );
}

/** What each section may list before it is cut. */
export const BRIEF_LIMITS = {
  modules: 15,
  testModules: 8,
  surfaces: 12,
  exportsPerSurface: 6,
  entities: 15,
  fieldsPerEntity: 8,
  accessors: 6,
  guides: 10,
  readmeChars: 1_200,
  nameChars: 80,
} as const;

export interface BriefInput {
  readonly facts: TreeFacts;
  /** The stack's names, as `detectStack` gives them. */
  readonly stack: readonly string[];
  readonly abstractions: AbstractionIndex | null;
  readonly dataModel: DataModel | null;
  readonly documents: DocumentSet | null;
}

export function renderBrief(input: BriefInput): string {
  const sections = [
    overview(input.facts, input.stack),
    layout(input.facts),
    tests(input.facts),
    surfaces(input.abstractions),
    dataModel(input.dataModel),
    documents(input.documents),
  ].filter((section): section is string[] => section !== null);
  return cutBrief(
    sections.map((lines) => lines.join("\n")).join("\n\n"),
    BRIEF_MAX_CHARS,
  );
}

/**
 * A brief cut to `maxChars`: whole lines from the top, since its sections
 * run most telling first, with a last line saying it was cut.
 */
export function cutBrief(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = "(cut for length)";
  const kept: string[] = [];
  let used = marker.length;
  for (const line of text.split("\n")) {
    if (used + line.length + 1 > maxChars) break;
    kept.push(line);
    used += line.length + 1;
  }
  while (kept.length > 0 && kept.at(-1) === "") kept.pop();
  return [...kept, marker].join("\n");
}

function overview(facts: TreeFacts, stack: readonly string[]): string[] {
  const lines = [
    `${count(facts.fileCount, "file")}, ${count(facts.testFiles, "test file")}${
      facts.truncated ? " (the listing was cut short)" : ""
    }.`,
  ];
  if (stack.length > 0)
    lines.push(`Stack: ${stack.slice(0, 20).map(clean).join(", ")}.`);
  const extensions = dominantExtensions(facts, 5);
  if (extensions.length > 0)
    lines.push(`Mostly: ${extensions.map(clean).join(", ")}.`);
  return lines;
}

function layout(facts: TreeFacts): string[] | null {
  if (facts.modules.length === 0) return null;
  const modules = [...facts.modules].sort(
    (left, right) => right.files - left.files || compare(left.path, right.path),
  );
  const shown = modules.slice(0, BRIEF_LIMITS.modules);
  const lines = ["Layout, largest modules first:"];
  for (const module of shown) {
    const types = dominantExtensions(module, 3).map(clean).join(", ");
    lines.push(
      `- ${moduleName(module.path)}: ${count(module.files, "file")}${
        types === "" ? "" : ` (${types})`
      }`,
    );
  }
  const rest = modules.length - shown.length;
  if (rest > 0) lines.push(`- ${count(rest, "more module")}`);
  for (const [label, paths] of [
    ["Lockfiles", facts.lockfiles],
    ["Migrations", facts.migrationDirectories],
    ["Infrastructure", facts.infraDirectories],
  ] as const)
    if (paths.length > 0)
      lines.push(
        `${label}: ${paths.slice(0, 5).map(clean).join(", ")}${
          paths.length > 5 ? `, and ${paths.length - 5} more` : ""
        }`,
      );
  return lines;
}

function tests(facts: TreeFacts): string[] | null {
  const tested = facts.modules
    .filter((module) => module.testFiles > 0)
    .sort(
      (left, right) =>
        right.testFiles - left.testFiles || compare(left.path, right.path),
    );
  if (tested.length === 0)
    return facts.fileCount === 0 ? null : ["Tests: none found by name."];
  const lines = ["Tests, by module:"];
  for (const module of tested.slice(0, BRIEF_LIMITS.testModules))
    lines.push(
      `- ${moduleName(module.path)}: ${count(module.testFiles, "test file")}`,
    );
  const untested = facts.modules.filter(
    (module) => module.testFiles === 0 && module.path !== ROOT_MODULE,
  ).length;
  if (untested > 0)
    lines.push(`- ${count(untested, "module")} with no test files`);
  return lines;
}

function surfaces(index: AbstractionIndex | null): string[] | null {
  if (index === null) return null;
  const imported = index.modules
    .filter((module) => module.importers > 0 && module.exports.length > 0)
    .sort(
      (left, right) =>
        right.importers - left.importers || compare(left.path, right.path),
    )
    .slice(0, BRIEF_LIMITS.surfaces);
  if (imported.length === 0) return null;
  const lines = ["Most imported modules, with what they export:"];
  for (const module of imported) {
    const names = module.exports
      .slice(0, BRIEF_LIMITS.exportsPerSurface)
      .map((entry) => `${clean(entry.name)} (${entry.kind})`);
    const more = module.exports.length - names.length;
    lines.push(
      `- ${clean(module.path)}, ${count(module.importers, "importer")}: ${names.join(", ")}${
        more > 0 ? `, and ${more} more` : ""
      }`,
    );
  }
  return lines;
}

function dataModel(model: DataModel | null): string[] | null {
  if (model === null || model.entities.length === 0) return null;
  const storage = [
    ...new Set(model.sources.map((source) => clean(source.storage))),
  ].sort(compare);
  const lines = [
    `Data model: ${count(model.entities.length, "entity", "entities")}${
      storage.length === 0 ? "" : ` in ${storage.join(", ")}`
    }, ${count(model.relations.length, "relation")}.`,
  ];
  for (const entity of model.entities.slice(0, BRIEF_LIMITS.entities)) {
    const fields = entity.fields
      .slice(0, BRIEF_LIMITS.fieldsPerEntity)
      .map((field) => clean(field.name));
    const more = entity.fields.length - fields.length;
    lines.push(
      `- ${clean(entity.name)}: ${fields.join(", ")}${more > 0 ? `, and ${more} more` : ""}`,
    );
  }
  const rest = model.entities.length - BRIEF_LIMITS.entities;
  if (rest > 0) lines.push(`- ${count(rest, "more entity", "more entities")}`);
  const accessors = model.accessors.slice(0, BRIEF_LIMITS.accessors);
  if (accessors.length > 0) {
    lines.push("Modules that read or write them:");
    for (const accessor of accessors)
      lines.push(
        `- ${clean(accessor.module)}: ${accessor.entities
          .slice(0, 5)
          .map(clean)
          .join(", ")}${accessor.entities.length > 5 ? ", …" : ""}`,
      );
  }
  return lines;
}

function documents(set: DocumentSet | null): string[] | null {
  if (set === null || set.documents.length === 0) return null;
  const lines: string[] = [];
  const readme = set.documents.find((document) =>
    /^readme\.(?:md|mdx|markdown)$/i.test(document.path),
  );
  if (readme !== undefined) {
    const excerpt = readmeExcerpt(readme.text);
    if (excerpt !== "") lines.push("README, opening:", excerpt);
  }
  const guides = set.documents
    .filter((document) => document !== readme)
    .slice(0, BRIEF_LIMITS.guides)
    .map((document) => clean(document.path));
  if (guides.length > 0) {
    const more =
      set.documents.length - (readme === undefined ? 0 : 1) - guides.length;
    lines.push(
      `Documents: ${guides.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`,
    );
  }
  return lines.length === 0 ? null : lines;
}

/**
 * The README's opening prose: badges, images, HTML and blank runs dropped,
 * cut at a line under `BRIEF_LIMITS.readmeChars`.
 */
function readmeExcerpt(text: string): string {
  const kept: string[] = [];
  let used = 0;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, "")
      .trimEnd();
    if (/^\s*(?:!\[|\[!\[|<)/.test(line)) continue;
    if (line.trim() === "" && (kept.length === 0 || kept.at(-1) === ""))
      continue;
    if (used + line.length + 1 > BRIEF_LIMITS.readmeChars) break;
    kept.push(line.trim() === "" ? "" : line);
    used += line.length + 1;
  }
  while (kept.at(-1) === "") kept.pop();
  return kept.join("\n");
}

function moduleName(path: string): string {
  return path === ROOT_MODULE ? "(files at the root)" : clean(path);
}

/** One line of a name from the repository: no control characters, capped. */
function clean(name: string): string {
  const line = name.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return line.length > BRIEF_LIMITS.nameChars
    ? `${line.slice(0, BRIEF_LIMITS.nameChars - 1)}…`
    : line;
}

function count(value: number, noun: string, plural = `${noun}s`): string {
  return `${value.toLocaleString("en-US")} ${value === 1 ? noun : plural}`;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
