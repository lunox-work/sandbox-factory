/**
 * What a repository's stack is, from three things a snapshot can read:
 * GitHub's language totals, the file list, and the dependency manifests in
 * it (`package.json`, `pom.xml`, `go.mod` and their kin).
 *
 * The languages come from the totals, frameworks and tools mostly from
 * files that only they leave (`next.config.ts`, `*.tf`), and databases and
 * services from the packages a manifest names, since a repository that talks
 * to Postgres or Cognito says so in its dependencies and almost nowhere
 * else. Only names are kept: what a manifest says beyond its dependencies is
 * read here and dropped.
 *
 * Fixed tables and plain regexes rather than a parser per format, so the
 * same bytes give the same stack and core stays dependency-free. A miss
 * costs a chip a person adds by hand; a false hit costs one they can see.
 *
 * Pure and deterministic, like `treeFacts`.
 */

import {
  STACK_CATALOG,
  type StackEcosystem,
  type StackSignals,
} from "../stack.js";

/** Bumped when what detection finds changes, so stored stacks are redone. */
export const STACK_DETECTION_VERSION = 1;

/** The most manifests one detection reads, and of the two kinds that sprawl. */
export const STACK_MANIFESTS_MAX = 30;
const KIND_MAX: Partial<Record<StackEcosystem, number>> = {
  docker: 10,
  terraform: 10,
};
/** A manifest larger than this is not read: it is generated, or not one. */
export const STACK_MANIFEST_BYTES_MAX = 256 * 1024;

/**
 * The share of a repository's code a language needs to count. Below it is
 * the build script or the one config file, not what the work is done in.
 * The largest language always counts.
 */
export const LANGUAGE_SHARE_MIN = 0.1;

/**
 * Directories whose contents are not the repository's own stack: vendored
 * or generated code, and fixtures and examples that name frameworks the
 * repository only tests or documents.
 */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  "bower_components",
  "vendor",
  "third_party",
  "Pods",
  ".venv",
  "venv",
  "dist",
  "build",
  "out",
  "target",
  "fixtures",
  "__fixtures__",
  "testdata",
  "examples",
  "example",
]);

export interface StackFile {
  readonly path: string;
  readonly size: number;
}

export interface StackManifest {
  readonly path: string;
  readonly text: string;
}

export interface StackDetectionInput {
  /** Bytes per language, as GitHub's language totals give them. */
  readonly languages: Readonly<Record<string, number>>;
  readonly files: readonly StackFile[];
  /** The text of the files `stackManifests` chose, or any subset of them. */
  readonly manifests: readonly StackManifest[];
}

function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

function skipped(path: string): boolean {
  return path
    .split("/")
    .slice(0, -1)
    .some((segment) => SKIPPED_DIRECTORIES.has(segment));
}

/** Which kind of manifest a file is, by its name; null for none. */
export function manifestKind(path: string): StackEcosystem | null {
  const name = baseName(path);
  const lower = name.toLowerCase();
  if (name === "package.json") return "npm";
  if (name === "composer.json") return "composer";
  if (
    /^requirements[\w.-]*\.txt$/i.test(name) ||
    ["pyproject.toml", "pipfile", "setup.py", "setup.cfg"].includes(lower)
  )
    return "pypi";
  if (
    [
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "libs.versions.toml",
    ].includes(lower)
  )
    return "maven";
  if (
    /\.(cs|fs|vb)proj$/i.test(name) ||
    [
      "directory.packages.props",
      "directory.build.props",
      "packages.config",
    ].includes(lower)
  )
    return "nuget";
  if (name === "go.mod") return "go";
  if (name === "Gemfile") return "gem";
  if (name === "Cargo.toml") return "cargo";
  if (name === "pubspec.yaml") return "pub";
  if (
    /^(docker-)?compose[\w.-]*\.ya?ml$/i.test(name) ||
    lower === "dockerfile" ||
    lower.endsWith(".dockerfile")
  )
    return "docker";
  if (lower.endsWith(".tf")) return "terraform";
  return null;
}

const depth = (path: string) => path.split("/").length;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The manifests worth reading in a file list: shallowest first, since the
 * root's describe the whole repository, at most `STACK_MANIFESTS_MAX` of
 * them and none too large to be one.
 */
export function stackManifests(files: readonly StackFile[]): string[] {
  const candidates = files
    .filter(
      (file) =>
        file.size <= STACK_MANIFEST_BYTES_MAX &&
        !skipped(file.path) &&
        manifestKind(file.path) !== null,
    )
    .map((file) => file.path)
    .sort((a, b) => depth(a) - depth(b) || compare(a, b));
  const counts = new Map<StackEcosystem, number>();
  const chosen: string[] = [];
  for (const path of candidates) {
    if (chosen.length >= STACK_MANIFESTS_MAX) break;
    const kind = manifestKind(path);
    if (kind === null) continue;
    const count = counts.get(kind) ?? 0;
    if (count >= (KIND_MAX[kind] ?? Infinity)) continue;
    counts.set(kind, count + 1);
    chosen.push(path);
  }
  return chosen;
}

/** Every match of a pattern's first group, lowercased. */
function captures(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1].toLowerCase()],
  );
}

/** The keys of a JSON manifest's dependency maps; none if it does not parse. */
function jsonKeys(text: string, fields: readonly string[]): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  return fields.flatMap((field) => {
    const value = (parsed as Record<string, unknown>)[field];
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.keys(value).map((name) => name.toLowerCase())
      : [];
  });
}

/** A Python distribution's name as PyPI compares it. */
const pypiName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

function pypiNames(path: string, text: string): string[] {
  if (/\.txt$/i.test(path)) {
    return text.split(/\r?\n/).flatMap((line) => {
      const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(
        line.replace(/#.*/, ""),
      );
      return match?.[1] === undefined ? [] : [pypiName(match[1])];
    });
  }
  // A requirement in a string (`"django>=5"`), or a table's key (Poetry,
  // Pipfile): both forms, over the whole file.
  return [
    ...captures(
      text,
      /["']([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]\n"']{0,200}\])?\s*(?=[<>=!~;@ ]|["'])/g,
    ),
    ...captures(text, /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/gm),
  ].map(pypiName);
}

function mavenNames(text: string): string[] {
  const names = [
    ...captures(text, /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/g),
    ...captures(text, /<groupId>\s*([^<\s]+)\s*<\/groupId>/g),
  ];
  for (const match of text.matchAll(
    /["']([\w.-]+):([\w.-]+)(?::[^"'\s]*)?["']/g,
  )) {
    const [, group, artifact] = match;
    if (group === undefined || artifact === undefined) continue;
    names.push(
      `${group}:${artifact}`.toLowerCase(),
      group.toLowerCase(),
      artifact.toLowerCase(),
    );
  }
  return names;
}

function cargoNames(text: string): string[] {
  const names: string[] = [];
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header?.[1] !== undefined) {
      section = header[1].trim();
      const table = /(?:^|\.)(?:dev-|build-)?dependencies\.([\w-]+)$/.exec(
        section,
      );
      if (table?.[1] !== undefined) names.push(table[1].toLowerCase());
      continue;
    }
    if (!/(?:^|\.)(?:dev-|build-)?dependencies$/.test(section)) continue;
    const entry = /^\s*([\w-]+)\s*=/.exec(line);
    if (entry?.[1] !== undefined) names.push(entry[1].toLowerCase());
  }
  return names;
}

/** An image reference's name, without its registry, tag or digest. */
function imageNames(reference: string): string[] {
  const at = reference.indexOf("@");
  const untagged = at === -1 ? reference : reference.slice(0, at);
  const segments = untagged.split("/");
  const last = segments.length - 1;
  const named = segments[last] ?? "";
  const colon = named.indexOf(":");
  segments[last] = colon === -1 ? named : named.slice(0, colon);
  const first = segments[0] ?? "";
  if (
    segments.length > 1 &&
    (first.includes(".") || first.includes(":") || first === "localhost")
  )
    segments.shift();
  const name = segments.join("/").toLowerCase();
  const tail = (segments[segments.length - 1] ?? "").toLowerCase();
  return name === tail ? [name] : [name, tail];
}

function dockerNames(text: string): string[] {
  return [
    ...captures(text, /^\s*image:\s*["']?([^\s"'#]+)/gm),
    ...captures(text, /^\s*FROM\s+(?:--platform=\S+\s+)?([^\s]+)/gim),
  ].flatMap(imageNames);
}

/** The dependency names one manifest declares, lowercased. */
export function manifestNames(manifest: StackManifest): string[] {
  const { path, text } = manifest;
  switch (manifestKind(path)) {
    case "npm":
      return jsonKeys(text, [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]);
    case "composer":
      return jsonKeys(text, ["require", "require-dev"]);
    case "pypi":
      return pypiNames(path, text);
    case "maven":
      return mavenNames(text);
    case "nuget":
      return [
        ...captures(
          text,
          /<Package(?:Reference|Version)\s[^<>]{0,1000}?Include\s*=\s*"([^"]+)"/gi,
        ),
        ...captures(text, /<package\s[^<>]{0,1000}?id\s*=\s*"([^"]+)"/gi),
        ...captures(text, /<Project\s[^<>]{0,1000}?Sdk\s*=\s*"([^"]+)"/gi),
      ];
    case "go":
      return captures(
        text,
        /^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/\S+)\s+v\d/gim,
      );
    case "gem":
      return captures(text, /^\s*gem\s+["']([^"']+)["']/gm);
    case "cargo":
      return cargoNames(text);
    case "pub":
      return captures(text, /^ {2}([a-z0-9_]+):/gm);
    case "docker":
      return dockerNames(text);
    case "terraform":
      return captures(text, /^\s*(?:resource|data)\s+"([a-z0-9_]+)"/gm);
    case null:
      return [];
  }
}

/** Whether a name matches a pattern: exactly, or by prefix when it ends in `*`. */
function matchesName(name: string, pattern: string): boolean {
  const lower = pattern.toLowerCase();
  return lower.endsWith("*")
    ? name.startsWith(lower.slice(0, -1))
    : name === lower;
}

/** A `files` pattern as a regex over a path. */
function fileRegExp(pattern: string): RegExp {
  const body = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`(?:^|/)${body}$`, "i");
}

const FILE_PATTERNS: ReadonlyMap<string, RegExp> = new Map(
  STACK_CATALOG.flatMap(({ detect }) => detect?.files ?? []).map((pattern) => [
    pattern,
    fileRegExp(pattern),
  ]),
);

const ECOSYSTEMS: readonly StackEcosystem[] = [
  "npm",
  "pypi",
  "maven",
  "nuget",
  "go",
  "gem",
  "composer",
  "cargo",
  "pub",
  "docker",
  "terraform",
];

/** The languages that count, by GitHub's names. */
function countedLanguages(
  languages: Readonly<Record<string, number>>,
): Set<string> {
  const entries = Object.entries(languages).filter(([, bytes]) => bytes > 0);
  const total = entries.reduce((sum, [, bytes]) => sum + bytes, 0);
  const largest = Math.max(0, ...entries.map(([, bytes]) => bytes));
  return new Set(
    entries
      .filter(
        ([, bytes]) => bytes === largest || bytes / total >= LANGUAGE_SHARE_MIN,
      )
      .map(([language]) => language),
  );
}

/**
 * The repository's stack: the catalog's names for what it found, in
 * catalog order, each once.
 */
export function detectStack(input: StackDetectionInput): string[] {
  const languages = countedLanguages(input.languages);
  // One pass over the files, which may number in the tens of thousands,
  // stopping once every pattern has a match.
  const filesFound = new Set<string>();
  for (const { path } of input.files) {
    if (filesFound.size === FILE_PATTERNS.size) break;
    if (skipped(path)) continue;
    for (const [pattern, regex] of FILE_PATTERNS)
      if (!filesFound.has(pattern) && regex.test(path)) filesFound.add(pattern);
  }
  const names = new Map<StackEcosystem, Set<string>>();
  for (const manifest of input.manifests) {
    if (skipped(manifest.path)) continue;
    const kind = manifestKind(manifest.path);
    if (kind === null) continue;
    const found = names.get(kind) ?? new Set<string>();
    for (const name of manifestNames(manifest)) found.add(name);
    names.set(kind, found);
  }

  const shows = (signals: StackSignals): boolean =>
    (signals.linguist ?? []).some((language) => languages.has(language)) ||
    (signals.files ?? []).some((pattern) => filesFound.has(pattern)) ||
    ECOSYSTEMS.some((ecosystem) => {
      const declared = names.get(ecosystem);
      const patterns = signals[ecosystem] ?? [];
      if (declared === undefined || patterns.length === 0) return false;
      for (const name of declared)
        if (patterns.some((pattern) => matchesName(name, pattern))) return true;
      return false;
    });

  return STACK_CATALOG.filter(
    ({ detect }) => detect !== undefined && shows(detect),
  ).map(({ name }) => name);
}
