/**
 * The isolated compile that tells whether a slice closes.
 *
 * The included files and the generated stubs are type-checked together in
 * memory, at the paths they hold in the repository, with the source's own
 * compiler settings. Nothing else of the repository is visible, so an
 * import the stubs do not cover is an error here rather than a surprise in
 * the sandbox. Packages are declared untyped for this check, since the
 * worker installs nothing; the sandbox phase installs the pinned versions.
 */

import { dirname, isAbsolute, relative, resolve } from "node:path";
import ts from "typescript-compiler";
import type { CompilationResult } from "sandbox-factory";
import { isScriptPath, NODE_BUILTINS } from "./typescript.js";

export const DIAGNOSTICS_MAX = 100;
export const SHIM_PATH = "__slice__/packages.d.ts";

export interface FixtureInput {
  readonly root: string;
  /** Repository-relative path to text: included files, stubs and shims. */
  readonly files: ReadonlyMap<string, string>;
  readonly compilerOptions: ts.CompilerOptions;
  readonly shimmedPackages: readonly string[];
}

/**
 * Ambient declarations that make the listed packages resolve as `any`, with
 * Node's own modules and globals, which the sandbox gets from `@types/node`.
 */
export function packageShim(packages: readonly string[]): string {
  const lines = [
    'declare module "node:*";',
    "declare var process: any;",
    "declare var Buffer: any;",
    "declare var global: any;",
    "declare var require: any;",
    "declare var module: any;",
    "declare var exports: any;",
    "declare var __dirname: string;",
    "declare var __filename: string;",
  ];
  // Node's modules by their bare names too: `import fs from "fs"`.
  for (const name of [...new Set([...NODE_BUILTINS, ...packages])].sort())
    lines.push(`declare module "${name}";`, `declare module "${name}/*";`);
  return `${lines.join("\n")}\n`;
}

export function compileFixture(input: FixtureInput): CompilationResult {
  const root = resolve(input.root);
  const files = new Map<string, string>();
  for (const [path, text] of input.files) files.set(resolve(root, path), text);
  const options: ts.CompilerOptions = {
    ...input.compilerOptions,
    noEmit: true,
    declaration: false,
    emitDeclarationOnly: false,
    composite: false,
    incremental: false,
    tsBuildInfoFile: undefined,
    skipLibCheck: true,
    types: [],
    typeRoots: [],
    allowJs: true,
    noLib: false,
  };
  const libDir = dirname(ts.getDefaultLibFilePath(options));
  const inLib = (path: string) => {
    const rel = relative(libDir, resolve(path));
    return !isAbsolute(rel) && !rel.startsWith("..");
  };
  const directories = new Set<string>([root]);
  for (const path of files.keys())
    for (let dir = dirname(path); dir.startsWith(root); dir = dirname(dir)) {
      if (directories.has(dir)) break;
      directories.add(dir);
    }
  const host: ts.CompilerHost = {
    fileExists: (path) =>
      files.has(resolve(path)) || (inLib(path) && ts.sys.fileExists(path)),
    readFile: (path) =>
      files.get(resolve(path)) ??
      (inLib(path) ? ts.sys.readFile(path) : undefined),
    directoryExists: (path) =>
      directories.has(resolve(path)) ||
      (inLib(path) && ts.sys.directoryExists(path)),
    getDirectories: (path) =>
      [...directories]
        .filter(
          (dir) => dirname(dir) === resolve(path) && dir !== resolve(path),
        )
        .map((dir) => relative(resolve(path), dir)),
    getSourceFile: (fileName, languageVersion) => {
      const text = host.readFile(fileName);
      return text === undefined
        ? undefined
        : ts.createSourceFile(fileName, text, languageVersion, true);
    },
    getDefaultLibFileName: (compilerOptions) =>
      ts.getDefaultLibFilePath(compilerOptions),
    getDefaultLibLocation: () => libDir,
    writeFile: () => {},
    getCurrentDirectory: () => root,
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    realpath: (path) => path,
  };
  const rootNames = [...files.keys()].filter(isScriptPath).sort();
  const program = ts.createProgram(rootNames, options, host);
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => ({
      file:
        diagnostic.file === undefined
          ? null
          : relative(root, diagnostic.file.fileName).replaceAll("\\", "/"),
      line:
        diagnostic.file === undefined || diagnostic.start === undefined
          ? null
          : diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
              .line + 1,
      code: `TS${diagnostic.code}`,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
    }))
    .sort((a, b) =>
      `${a.file ?? ""}:${a.line ?? 0}:${a.code}`.localeCompare(
        `${b.file ?? ""}:${b.line ?? 0}:${b.code}`,
      ),
    );
  return {
    attempted: true,
    ok: diagnostics.length === 0,
    diagnostics: diagnostics.slice(0, DIAGNOSTICS_MAX),
    shimmedPackages: [...new Set(input.shimmedPackages)].sort(),
  };
}
