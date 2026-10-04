import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import ts from "typescript-compiler";

export interface LoadedConfig {
  readonly path: string | null;
  readonly options: ts.CompilerOptions;
  readonly rawOptions: Record<string, unknown> | undefined;
  readonly errors: readonly string[];
}

/** The nearest `tsconfig.json` above a file, read without following `extends` outside the root. */
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
  const inside = (path: string) => {
    const rel = relative(root, resolve(path));
    return !isAbsolute(rel) && !rel.startsWith("..");
  };
  const read = (path: string) =>
    inside(path) && existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const loaded = ts.readConfigFile(config, read);
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config ?? {},
    {
      fileExists: (path) => inside(path) && existsSync(path),
      readFile: read,
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
      // Snapshots have no installed package bases; never read outside the repository.
      if (!base.startsWith(".")) continue;
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
