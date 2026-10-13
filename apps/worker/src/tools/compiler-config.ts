import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript-compiler";

export interface LoadedConfig {
  readonly path: string | null;
  readonly options: ts.CompilerOptions;
  readonly rawOptions: Record<string, unknown> | undefined;
  readonly errors: readonly string[];
}

const isInside = (root: string, path: string) => {
  const rel = relative(root, resolve(path));
  return !isAbsolute(rel) && !rel.startsWith("..");
};

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The repository's own workspace packages, by name, to their directories.
 * A shared base (`@scope/tsconfig/react.json`) is usually one of them, and a
 * snapshot has no node_modules to find it in. Read from the root
 * `package.json`'s `workspaces`, as npm and Yarn write it: exact
 * directories, and directories ending in one `*` level.
 */
export function workspacePackages(root: string): Map<string, string> {
  const manifest = readJson(join(root, "package.json"));
  const declared = isRecord(manifest) ? manifest["workspaces"] : undefined;
  const patterns = Array.isArray(declared)
    ? declared
    : isRecord(declared) && Array.isArray(declared["packages"])
      ? declared["packages"]
      : [];
  const directories: string[] = [];
  for (const pattern of patterns) {
    if (typeof pattern !== "string") continue;
    if (pattern.endsWith("/*")) {
      const parent = resolve(root, pattern.slice(0, -2));
      if (!isInside(root, parent) || !existsSync(parent)) continue;
      // Sorted, so the first of two packages with one name is always the same.
      const entries = readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      for (const name of entries) directories.push(join(parent, name));
    } else if (!pattern.includes("*")) directories.push(resolve(root, pattern));
  }
  const packages = new Map<string, string>();
  for (const directory of directories) {
    if (!isInside(root, directory)) continue;
    const own = readJson(join(directory, "package.json"));
    const name = isRecord(own) ? own["name"] : undefined;
    if (typeof name === "string" && !packages.has(name))
      packages.set(name, directory);
  }
  return packages;
}

/** A bare specifier split into its package name and the path within it. */
function packageSpecifier(specifier: string): {
  readonly name: string;
  readonly subpath: string;
} {
  const parts = specifier.split("/");
  const size = specifier.startsWith("@") ? 2 : 1;
  return {
    name: parts.slice(0, size).join("/"),
    subpath: parts.slice(size).join("/"),
  };
}

/**
 * Where a path under some `node_modules` really is, when the package is one
 * of the repository's workspaces; any other path is itself.
 */
function throughWorkspaces(
  path: string,
  packages: () => ReadonlyMap<string, string>,
): string {
  const normalized = path.replaceAll("\\", "/");
  const marker = "/node_modules/";
  const at = normalized.lastIndexOf(marker);
  if (at === -1) return path;
  const { name, subpath } = packageSpecifier(
    normalized.slice(at + marker.length),
  );
  const directory = packages().get(name);
  return directory === undefined ? path : join(directory, subpath);
}

/** The file a bare `extends` names, when its package is a workspace. */
function workspaceBase(
  specifier: string,
  packages: () => ReadonlyMap<string, string>,
): string | undefined {
  const { name, subpath } = packageSpecifier(specifier);
  const directory = packages().get(name);
  if (directory === undefined) return undefined;
  if (subpath === "") {
    // A package's own `tsconfig` field names its base, as TypeScript reads it.
    const manifest = readJson(join(directory, "package.json"));
    const named = isRecord(manifest) ? manifest["tsconfig"] : undefined;
    return typeof named === "string" && named !== ""
      ? resolve(directory, named)
      : join(directory, "tsconfig.json");
  }
  const target = join(directory, subpath);
  return target.endsWith(".json") ||
    (existsSync(target) && statSync(target).isFile())
    ? target
    : `${target}.json`;
}

/** Read once, on the first bare base: most configs never need it. */
function lazyWorkspaces(root: string): () => ReadonlyMap<string, string> {
  let packages: Map<string, string> | undefined;
  return () => (packages ??= workspacePackages(root));
}

/**
 * The nearest `tsconfig.json` above a file, read without following `extends`
 * outside the root. A base in an installed package resolves when the
 * package is one of the repository's own workspaces.
 */
export function loadConfig(root: string, file: string): LoadedConfig {
  let config: string | undefined;
  for (let dir = dirname(resolve(root, file)); ; dir = dirname(dir)) {
    const rel = relative(root, dir);
    if (rel.startsWith("..") || isAbsolute(rel)) break;
    const candidate = resolve(dir, "tsconfig.json");
    if (existsSync(candidate)) {
      config = candidate;
      break;
    }
    if (rel === "") break;
  }
  const defaults: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: true,
    resolveJsonModule: true,
  };
  if (config === undefined)
    return { path: null, options: defaults, rawOptions: undefined, errors: [] };
  // TypeScript looks for a package base under node_modules; the snapshot
  // has none, so those lookups are answered from the workspaces.
  const packages = lazyWorkspaces(root);
  const real = (path: string) => throughWorkspaces(path, packages);
  const exists = (path: string) =>
    isInside(root, real(path)) && existsSync(real(path));
  const read = (path: string) =>
    exists(path) ? readFileSync(real(path), "utf8") : undefined;
  const loaded = ts.readConfigFile(config, read);
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config ?? {},
    {
      fileExists: exists,
      readFile: read,
      realpath: real,
      readDirectory: () => [],
      useCaseSensitiveFileNames: true,
    },
    dirname(config),
    undefined,
    config,
  );
  const errors = [
    ...(loaded.error === undefined ? [] : [loaded.error]),
    ...parsed.errors.filter((error) => error.code !== 18003),
  ].map((error) => ts.flattenDiagnosticMessageText(error.messageText, " "));
  return {
    path: relative(root, config).replaceAll("\\", "/"),
    options: { ...defaults, ...parsed.options },
    rawOptions: rawOptionsOf(root, config),
    errors,
  };
}

/** Active recursion detects cycles; a base resolved on a sibling branch still applies. */
function rawOptionsOf(
  root: string,
  configPath: string,
): Record<string, unknown> | undefined {
  const packages = lazyWorkspaces(root);
  const active = new Set<string>();
  const cache = new Map<string, Record<string, unknown>>();
  const resolveOptions = (path: string): Record<string, unknown> => {
    const rel = relative(root, path);
    if (
      rel.startsWith("..") ||
      isAbsolute(rel) ||
      active.has(path) ||
      !existsSync(path)
    )
      return {};
    const cached = cache.get(path);
    if (cached !== undefined) return cached;
    active.add(path);
    const config = ts.readConfigFile(path, ts.sys.readFile).config as
      { extends?: unknown; compilerOptions?: unknown } | undefined;
    const bases =
      typeof config?.extends === "string"
        ? [config.extends]
        : Array.isArray(config?.extends)
          ? config.extends.filter(
              (base): base is string => typeof base === "string",
            )
          : [];
    let options: Record<string, unknown> = {};
    for (const base of bases) {
      // Snapshots have no installed packages: a bare base resolves only to
      // one of the repository's workspaces, and never outside it.
      if (!base.startsWith(".")) {
        const target = workspaceBase(base, packages);
        if (target !== undefined)
          options = { ...options, ...resolveOptions(target) };
        continue;
      }
      const target = resolve(dirname(path), base);
      options = {
        ...options,
        ...resolveOptions(
          target.endsWith(".json") || existsSync(target)
            ? target
            : `${target}.json`,
        ),
      };
    }
    const own = config?.compilerOptions;
    if (own !== null && typeof own === "object" && !Array.isArray(own))
      options = { ...options, ...own };
    active.delete(path);
    cache.set(path, options);
    return options;
  };
  const options = resolveOptions(configPath);
  return Object.keys(options).length === 0 ? undefined : options;
}

export function nearestCompilerOptions(
  root: string,
  file: string,
): Record<string, unknown> | undefined {
  return loadConfig(root, file).rawOptions;
}
