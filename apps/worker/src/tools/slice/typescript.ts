import { declarationPath as declarationPathFor } from "sandbox-factory";
import { loadConfig, type LoadedConfig } from "../compiler-config.js";
export {
  declarationPath as declarationPathFor,
  packageNameOf,
} from "sandbox-factory";
export { loadConfig } from "../compiler-config.js";
/**
 * Signature extraction for TypeScript and JavaScript, with the compiler API.
 *
 * For every module the slice imports from outside (a cut), the exported
 * declarations it needs are emitted as `.d.ts` text with the compiler's own
 * declaration emitter, then narrowed to the requested names and whatever
 * they reference, so the stub is a compilable declaration file with no
 * bodies. Types the stub imports from further modules are pulled in the
 * same way until the set is closed. The same emitter and filter describe
 * the public surface: what outside files import from the slice.
 *
 * Nothing here executes repository code. The compiler host is bounded to
 * the source directory and the compiler's own library files.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { BoundaryModule, CutEdge, SliceBlocker } from "sandbox-factory";
import ts from "typescript-compiler";

export const TYPESCRIPT_EXTRACTOR_VERSION = `typescript@${ts.version}`;
export const ALL = "*";
export type RequestedNames = ReadonlySet<string> | typeof ALL;
export const STUB_CLOSURE_MAX = 500;
/**
 * Repository files one extraction may parse. The compiler runs on the
 * event loop; a program the size of a monorepo would hold it past the
 * heartbeat and lose the lease, so the slice stops with a blocker instead.
 */
export const PROGRAM_FILES_MAX = 2000;
class ProgramTooLarge extends Error {}

/** Modules Node provides; never a package the sandbox must install. */
export const NODE_BUILTINS: readonly string[] = [
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
];

export function isScriptPath(path: string): boolean {
  return /\.[cm]?[jt]sx?$/.test(path);
}
/**
 * Files a script imports as data (`import data from "./data.json"`). They
 * ride along in a TypeScript slice; code in any other language does not.
 */
export function isDataPath(path: string): boolean {
  return /\.(json|jsonc|css|scss|sass|less|svg|txt|md|ya?ml|html)$/.test(path);
}
export function isNodeBuiltin(specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;
  const root = specifier.split("/")[0] ?? specifier;
  return NODE_BUILTINS.includes(root);
}
/** The stub's artifact path for a module: `stubs/<path>.d.ts`. */
export function stubPathFor(module: string): string {
  return `stubs/${declarationPathFor(module)}`;
}
export interface ImportFact {
  readonly specifier: string;
  readonly names: RequestedNames;
  readonly line: number;
}

/** Every import a file makes, with the names it takes, from the syntax. */
export function importsOf(source: ts.SourceFile): ImportFact[] {
  const facts: ImportFact[] = [];
  const line = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const literal = (node: ts.Expression | undefined) =>
    node !== undefined && ts.isStringLiteralLike(node) ? node.text : null;
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = literal(statement.moduleSpecifier);
      if (specifier === null) continue;
      const clause = statement.importClause;
      const names = new Set<string>();
      let all = false;
      if (clause === undefined) {
        /* A side-effect import needs the module to exist, nothing from it. */
      } else {
        if (clause.name !== undefined) names.add("default");
        const bindings = clause.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings))
          all = true;
        else if (bindings !== undefined)
          for (const element of bindings.elements)
            names.add((element.propertyName ?? element.name).text);
      }
      facts.push({
        specifier,
        names: all ? ALL : names,
        line: line(statement),
      });
    } else if (ts.isExportDeclaration(statement)) {
      const specifier = literal(statement.moduleSpecifier);
      if (specifier === null) continue;
      const clause = statement.exportClause;
      const names =
        clause === undefined || ts.isNamespaceExport(clause)
          ? ALL
          : new Set(
              clause.elements.map(
                (element) => (element.propertyName ?? element.name).text,
              ),
            );
      facts.push({ specifier, names, line: line(statement) });
    } else if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference)
    ) {
      const specifier = literal(statement.moduleReference.expression);
      if (specifier !== null)
        facts.push({ specifier, names: ALL, line: line(statement) });
    }
  }
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const specifier = literal(node.arguments[0]);
      if (specifier !== null)
        facts.push({ specifier, names: ALL, line: line(node) });
    } else if (ts.isImportTypeNode(node)) {
      const specifier =
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)
          ? node.argument.literal.text
          : null;
      if (specifier !== null) {
        let qualifier = node.qualifier;
        while (qualifier !== undefined && ts.isQualifiedName(qualifier))
          qualifier = qualifier.left;
        facts.push({
          specifier,
          names: qualifier === undefined ? ALL : new Set([qualifier.text]),
          line: line(node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return facts;
}

/** A compiler host that reads only the source tree and the compiler's libs. */
export function boundedHost(root: string, options: ts.CompilerOptions) {
  const libDir = dirname(ts.getDefaultLibFilePath(options));
  const inside = (base: string, path: string) => {
    const rel = relative(base, resolve(path));
    return rel === "" || (!isAbsolute(rel) && !rel.startsWith(".."));
  };
  const allowed = (path: string) => inside(root, path) || inside(libDir, path);
  const host = ts.createCompilerHost(options, true);
  const base = { ...host };
  host.fileExists = (path) => allowed(path) && base.fileExists(path);
  host.readFile = (path) => (allowed(path) ? base.readFile(path) : undefined);
  host.directoryExists = (path) =>
    allowed(path) && (base.directoryExists?.(path) ?? existsSync(path));
  host.getDirectories = (path) =>
    allowed(path) ? (base.getDirectories?.(path) ?? []) : [];
  host.realpath = (path) => path;
  host.getCurrentDirectory = () => root;
  host.writeFile = () => {};
  return host;
}

/** Options for declaration emit: the source's, with output settings forced. */
export function extractionOptions(
  base: ts.CompilerOptions,
): ts.CompilerOptions {
  return {
    ...base,
    declaration: true,
    emitDeclarationOnly: true,
    noEmit: false,
    noEmitOnError: false,
    skipLibCheck: true,
    sourceMap: false,
    declarationMap: false,
    inlineSourceMap: false,
    composite: false,
    incremental: false,
    tsBuildInfoFile: undefined,
    outDir: undefined,
    outFile: undefined,
    rootDir: undefined,
    declarationDir: undefined,
    types: [],
    typeRoots: [],
    noLib: false,
    isolatedDeclarations: false,
    stripInternal: false,
  };
}

interface Declared {
  readonly statement: ts.Statement;
  /** Names this statement makes visible to importers. */
  readonly exported: ReadonlySet<string>;
  /** Names it binds locally (the same as exported, for direct exports). */
  readonly local: ReadonlySet<string>;
  /** Identifiers it refers to, over-approximated. */
  readonly references: ReadonlySet<string>;
  readonly kind: string;
  readonly reexportAll: string | null;
  readonly importFrom: { specifier: string; names: RequestedNames } | null;
}

const kindOf = (statement: ts.Statement): string =>
  ts.isFunctionDeclaration(statement)
    ? "function"
    : ts.isClassDeclaration(statement)
      ? "class"
      : ts.isInterfaceDeclaration(statement)
        ? "interface"
        : ts.isTypeAliasDeclaration(statement)
          ? "type"
          : ts.isEnumDeclaration(statement)
            ? "enum"
            : ts.isVariableStatement(statement)
              ? "variable"
              : ts.isModuleDeclaration(statement)
                ? "namespace"
                : ts.isExportAssignment(statement)
                  ? "default"
                  : "unknown";

function bindingNames(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) into.add(name.text);
  else
    for (const element of name.elements)
      if (ts.isBindingElement(element)) bindingNames(element.name, into);
}

function describe(statement: ts.Statement): Declared {
  const exported = new Set<string>();
  const local = new Set<string>();
  const references = new Set<string>();
  let reexportAll: string | null = null;
  let importFrom: Declared["importFrom"] = null;
  const modifiers = ts.canHaveModifiers(statement)
    ? (ts.getModifiers(statement) ?? [])
    : [];
  const isExport = modifiers.some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword,
  );
  const isDefault = modifiers.some(
    (m) => m.kind === ts.SyntaxKind.DefaultKeyword,
  );
  const declare = (name: string | undefined) => {
    if (name === undefined) return;
    local.add(name);
    if (isExport) exported.add(name);
  };
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement)
  ) {
    declare(
      statement.name !== undefined && ts.isIdentifier(statement.name)
        ? statement.name.text
        : undefined,
    );
    if (isExport && isDefault) exported.add("default");
  } else if (ts.isVariableStatement(statement)) {
    const names = new Set<string>();
    for (const declaration of statement.declarationList.declarations)
      bindingNames(declaration.name, names);
    for (const name of names) declare(name);
  } else if (ts.isExportAssignment(statement)) {
    exported.add(statement.isExportEquals ? "export=" : "default");
  } else if (ts.isExportDeclaration(statement)) {
    const clause = statement.exportClause;
    const specifier =
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : null;
    if (clause === undefined) reexportAll = specifier;
    else if (ts.isNamespaceExport(clause)) {
      exported.add(clause.name.text);
      if (specifier !== null) importFrom = { specifier, names: ALL };
    } else {
      const taken = new Set<string>();
      for (const element of clause.elements) {
        exported.add(element.name.text);
        const origin = (element.propertyName ?? element.name).text;
        if (specifier === null) references.add(origin);
        else taken.add(origin);
      }
      if (specifier !== null) importFrom = { specifier, names: taken };
    }
  } else if (ts.isImportDeclaration(statement)) {
    const specifier = ts.isStringLiteralLike(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : null;
    const clause = statement.importClause;
    const taken = new Set<string>();
    let all = false;
    if (clause?.name !== undefined) {
      local.add(clause.name.text);
      taken.add("default");
    }
    if (clause?.namedBindings !== undefined) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        local.add(clause.namedBindings.name.text);
        all = true;
      } else
        for (const element of clause.namedBindings.elements) {
          local.add(element.name.text);
          taken.add((element.propertyName ?? element.name).text);
        }
    }
    if (specifier !== null)
      importFrom = { specifier, names: all ? ALL : taken };
  } else if (ts.isImportEqualsDeclaration(statement)) {
    local.add(statement.name.text);
    if (isExport) exported.add(statement.name.text);
    if (ts.isExternalModuleReference(statement.moduleReference)) {
      const expression = statement.moduleReference.expression;
      if (ts.isStringLiteralLike(expression))
        importFrom = { specifier: expression.text, names: ALL };
    } else references.add(leftmost(statement.moduleReference));
  }
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && !local.has(node.text))
      references.add(node.text);
    ts.forEachChild(node, visit);
  };
  if (!ts.isImportDeclaration(statement)) visit(statement);
  return {
    statement,
    exported,
    local,
    references,
    kind: kindOf(statement),
    reexportAll,
    importFrom,
  };
}

function leftmost(name: ts.EntityName): string {
  return ts.isQualifiedName(name) ? leftmost(name.left) : name.text;
}

export interface FilteredDeclaration {
  readonly text: string;
  /** Requested names that no kept statement exports and no `export *` could. */
  readonly missing: readonly string[];
  /** Names forwarded to `export *` targets because nothing local declared them. */
  readonly forwarded: readonly { specifier: string; names: RequestedNames }[];
  /** Modules the kept declarations import from, with the names taken. */
  readonly imports: readonly { specifier: string; names: RequestedNames }[];
  readonly symbols: readonly {
    name: string;
    kind: string;
    declaration: string;
  }[];
}

/**
 * Narrows an emitted declaration file to the requested exports and what
 * they need. `ALL` keeps the file whole.
 */
export function filterDeclaration(
  text: string,
  requested: RequestedNames,
): FilteredDeclaration {
  const source = ts.createSourceFile(
    "m.d.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const described = source.statements.map(describe);
  const kept = new Set<Declared>();
  const needed = new Set<string>();
  const exportedBy = (name: string) =>
    described.filter((d) => d.exported.has(name) && d.reexportAll === null);
  if (requested === ALL) {
    for (const d of described) kept.add(d);
  } else {
    for (const name of requested)
      for (const d of exportedBy(name)) {
        kept.add(d);
        for (const reference of d.references) needed.add(reference);
      }
    let grew = true;
    while (grew) {
      grew = false;
      for (const d of described) {
        if (kept.has(d)) continue;
        const binds = [...d.local].some((name) => needed.has(name));
        if (!binds) continue;
        kept.add(d);
        grew = true;
        for (const reference of d.references) needed.add(reference);
      }
    }
  }
  const imports: { specifier: string; names: RequestedNames }[] = [];
  for (const d of kept) if (d.importFrom !== null) imports.push(d.importFrom);
  const visitImportTypes = (node: ts.Node) => {
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      let qualifier = node.qualifier;
      while (qualifier !== undefined && ts.isQualifiedName(qualifier))
        qualifier = qualifier.left;
      imports.push({
        specifier: node.argument.literal.text,
        names: qualifier === undefined ? ALL : new Set([qualifier.text]),
      });
    }
    ts.forEachChild(node, visitImportTypes);
  };
  for (const d of kept) visitImportTypes(d.statement);
  const missing: string[] = [];
  const forwarded: { specifier: string; names: RequestedNames }[] = [];
  const stars = described.filter((d) => d.reexportAll !== null);
  if (requested === ALL) {
    for (const star of stars) {
      kept.add(star);
      forwarded.push({ specifier: star.reexportAll ?? "", names: ALL });
    }
  } else {
    const unfound = [...requested].filter(
      (name) => exportedBy(name).length === 0,
    );
    if (unfound.length > 0 && stars.length > 0)
      for (const star of stars) {
        kept.add(star);
        forwarded.push({
          specifier: star.reexportAll ?? "",
          names: new Set(unfound),
        });
      }
    else missing.push(...unfound);
  }
  const ordered = described.filter((d) => kept.has(d));
  const symbols: { name: string; kind: string; declaration: string }[] = [];
  const wanted = (name: string) => requested === ALL || requested.has(name);
  /** `export { a as X }`: the local name `X` is bound to, here `a`. */
  const localOf = (statement: ts.Statement, exported: string) => {
    if (!ts.isExportDeclaration(statement)) return undefined;
    const clause = statement.exportClause;
    if (clause === undefined || !ts.isNamedExports(clause)) return undefined;
    const element = clause.elements.find((e) => e.name.text === exported);
    return element === undefined
      ? undefined
      : (element.propertyName ?? element.name).text;
  };
  for (const d of ordered)
    for (const name of [...d.exported].sort())
      if (wanted(name)) {
        const local =
          d.kind === "unknown" ? localOf(d.statement, name) : undefined;
        const origin =
          local === undefined
            ? undefined
            : described.find((other) => other !== d && other.local.has(local));
        symbols.push({
          name,
          kind: origin?.kind ?? d.kind,
          declaration: (origin ?? d).statement.getText(source).trim(),
        });
      }
  let body = ordered.map((d) => d.statement.getText(source).trim()).join("\n");
  if (!ordered.some((d) => d.exported.size > 0 || d.reexportAll !== null))
    body = `${body}${body === "" ? "" : "\n"}export {};`;
  return { text: `${body}\n`, missing, forwarded, imports, symbols };
}

export interface TypeScriptBoundary {
  readonly extractorVersion: string;
  readonly outbound: readonly BoundaryModule[];
  readonly inbound: readonly BoundaryModule[];
  /** Declaration files standing in for cut modules, by artifact path. */
  readonly stubs: readonly { path: string; module: string; text: string }[];
  readonly blockers: readonly SliceBlocker[];
  /** Configuration files the included files are read with, sorted. */
  readonly configs: readonly string[];
  /** Package specifiers imported by included files or kept stubs, with the files. */
  readonly packages: ReadonlyMap<string, ReadonlySet<string>>;
  /** The options the fixture compiles with. */
  readonly compilerOptions: ts.CompilerOptions;
}

export interface TypeScriptBoundaryInput {
  readonly root: string;
  readonly included: readonly string[];
  readonly outbound: readonly CutEdge[];
  readonly inbound: readonly CutEdge[];
  readonly texts: ReadonlyMap<string, string>;
  /** Defaults to `PROGRAM_FILES_MAX`. */
  readonly maxProgramFiles?: number;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function extractTypeScriptBoundary(
  input: TypeScriptBoundaryInput,
): TypeScriptBoundary {
  const root = resolve(input.root);
  const rel = (path: string) => relative(root, path).replaceAll("\\", "/");
  const abs = (path: string) => resolve(root, path);
  const blockers: SliceBlocker[] = [];
  const configs = new Set<string>();
  const packages = new Map<string, Set<string>>();
  const scripts = input.included.filter(isScriptPath);
  const first = scripts[0] ?? input.included[0] ?? "";
  // Files in one directory share their nearest tsconfig; read each once.
  const loaded = new Map<string, LoadedConfig>();
  const configOf = (file: string) => {
    const key = dirname(file);
    const hit = loaded.get(key);
    if (hit !== undefined) return hit;
    const config = loadConfig(root, file);
    loaded.set(key, config);
    return config;
  };
  // The program compiles with the first script's options. A slice across
  // several tsconfigs records them all; if their options disagree, the
  // fixture compile reports it as a compile error.
  const config = configOf(first);
  const reported = new Set<string | null>();
  for (const file of input.included) {
    const own = configOf(file);
    if (own.path !== null) configs.add(own.path);
    if (reported.has(own.path)) continue;
    reported.add(own.path);
    for (const error of own.errors)
      blockers.push({
        code: "missing_build_input",
        file: own.path,
        location: null,
        detail: error,
      });
  }
  const options = extractionOptions(config.options);
  const host = boundedHost(root, options);
  const maxFiles = input.maxProgramFiles ?? PROGRAM_FILES_MAX;
  let parsed = 0;
  const parse = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, ...rest) => {
    const path = rel(resolve(fileName));
    if (!path.startsWith("..") && !isAbsolute(path) && ++parsed > maxFiles)
      throw new ProgramTooLarge();
    return parse(fileName, ...rest);
  };
  const outside = new Set<string>();
  for (const edge of input.outbound) outside.add(edge.to);
  for (const edge of input.inbound) outside.add(edge.from);
  const rootNames = [...new Set([...scripts, ...outside])]
    .filter(isScriptPath)
    .map(abs);
  let program: ts.Program;
  try {
    program = ts.createProgram(rootNames, options, host);
  } catch (error) {
    if (!(error instanceof ProgramTooLarge)) throw error;
    return {
      extractorVersion: TYPESCRIPT_EXTRACTOR_VERSION,
      outbound: [],
      inbound: [],
      stubs: [],
      blockers: [
        ...blockers,
        {
          code: "declaration_incomplete",
          file: null,
          location: null,
          detail: `The slice's imports reach more than ${maxFiles} repository files; choose narrower entry points.`,
        },
      ],
      configs: [...configs].sort(compare),
      packages: new Map(),
      compilerOptions: config.options,
    };
  }
  const resolveSpecifier = (specifier: string, from: string) => {
    const resolved = ts.resolveModuleName(
      specifier,
      abs(from),
      options,
      host,
    ).resolvedModule;
    if (resolved === undefined || resolved.isExternalLibraryImport === true)
      return null;
    const path = rel(resolved.resolvedFileName);
    return path.startsWith("..") || isAbsolute(path) ? null : path;
  };
  const recordPackage = (specifier: string, file: string) => {
    if (isNodeBuiltin(specifier)) return;
    const list = packages.get(specifier) ?? new Set<string>();
    list.add(file);
    packages.set(specifier, list);
  };
  const isRelativeSpecifier = (specifier: string) =>
    specifier.startsWith(".") || specifier.startsWith("/");
  type Target =
    | { readonly module: string }
    | { readonly unresolved: true }
    | { readonly package: true };
  const classify = (specifier: string, from: string): Target => {
    const module = resolveSpecifier(specifier, from);
    if (module !== null) return { module };
    if (isRelativeSpecifier(specifier)) return { unresolved: true };
    // A bare specifier the root tree does not resolve is a package, which
    // the sandbox installs; a path alias that misses is a config problem.
    return { package: true };
  };
  const merge = (
    into: Map<
      string,
      { names: Set<string> | typeof ALL; importedBy: Set<string> }
    >,
    module: string,
    names: RequestedNames,
    by: string,
  ) => {
    const entry = into.get(module) ?? {
      names: new Set<string>(),
      importedBy: new Set<string>(),
    };
    if (names === ALL) entry.names = ALL;
    else if (entry.names !== ALL)
      for (const name of names) entry.names.add(name);
    entry.importedBy.add(by);
    into.set(module, entry);
  };
  const included = new Set(input.included);
  const requests = new Map<
    string,
    { names: Set<string> | typeof ALL; importedBy: Set<string> }
  >();
  const surface = new Map<
    string,
    { names: Set<string> | typeof ALL; importedBy: Set<string> }
  >();
  // Imports of included files decide what the stubs must declare.
  for (const file of scripts) {
    const source = program.getSourceFile(abs(file));
    if (source === undefined) continue;
    for (const fact of importsOf(source)) {
      const target = classify(fact.specifier, file);
      if ("module" in target) {
        if (!included.has(target.module))
          merge(requests, target.module, fact.names, file);
      } else if ("package" in target) recordPackage(fact.specifier, file);
      else
        blockers.push({
          code: "unresolved_import",
          file,
          location: `L${fact.line}`,
          detail: `${fact.specifier} does not resolve to a repository file.`,
        });
    }
  }
  // A graph edge without a matching import (a call the graph inferred) still
  // names a module the slice touches; its symbols are listed by name.
  for (const edge of input.outbound)
    if (!requests.has(edge.to) && isScriptPath(edge.to))
      merge(
        requests,
        edge.to,
        edge.targetSymbol === null
          ? ALL
          : new Set([edge.targetSymbol.replace(/\(\)$/, "")]),
        edge.from,
      );
  // Imports from outside files decide the public surface.
  for (const by of new Set(input.inbound.map((edge) => edge.from))) {
    if (!isScriptPath(by)) continue;
    const source = program.getSourceFile(abs(by));
    if (source === undefined) continue;
    for (const fact of importsOf(source)) {
      const target = classify(fact.specifier, by);
      if ("module" in target && included.has(target.module))
        merge(surface, target.module, fact.names, by);
    }
  }
  for (const edge of input.inbound)
    if (!surface.has(edge.to) && isScriptPath(edge.to))
      merge(
        surface,
        edge.to,
        edge.targetSymbol === null
          ? ALL
          : new Set([edge.targetSymbol.replace(/\(\)$/, "")]),
        edge.from,
      );
  const emitted = new Map<string, string | null>();
  const emit = (module: string): string | null => {
    const cached = emitted.get(module);
    if (cached !== undefined) return cached;
    const source = program.getSourceFile(abs(module));
    let text: string | null = null;
    if (source !== undefined) {
      const diagnostics = program.getDeclarationDiagnostics(source);
      for (const diagnostic of diagnostics.slice(0, 20))
        blockers.push({
          code: "declaration_incomplete",
          file: module,
          location:
            diagnostic.start === undefined
              ? null
              : `L${source.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`,
          detail: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        });
      program.emit(
        source,
        (fileName, content) => {
          if (/\.d\.[cm]?ts$/.test(fileName)) text = content;
        },
        undefined,
        true,
      );
    }
    emitted.set(module, text);
    return text;
  };
  const stubs = new Map<string, { module: string; text: string }>();
  const outbound: BoundaryModule[] = [];
  const queue = [...requests.keys()].sort(compare);
  const done = new Set<string>();
  while (queue.length > 0) {
    const module = queue.shift();
    if (module === undefined) break;
    if (done.has(module)) continue;
    done.add(module);
    if (done.size > STUB_CLOSURE_MAX) {
      blockers.push({
        code: "declaration_incomplete",
        file: null,
        location: null,
        detail: `More than ${STUB_CLOSURE_MAX} modules would need stubs.`,
      });
      break;
    }
    const request = requests.get(module);
    if (request === undefined) continue;
    const text = emit(module);
    if (text === null) {
      blockers.push({
        code: "declaration_incomplete",
        file: module,
        location: null,
        detail: "No declaration could be emitted for this module.",
      });
      outbound.push({
        module,
        symbols:
          request.names === ALL
            ? []
            : [...request.names]
                .sort()
                .map((name) => ({ name, kind: "unknown", declaration: null })),
        importedBy: [...request.importedBy].sort(compare),
        stubPath: null,
      });
      continue;
    }
    const filtered = filterDeclaration(text, request.names);
    for (const name of filtered.missing)
      blockers.push({
        code: "declaration_incomplete",
        file: module,
        location: null,
        detail: `${name} is not exported by this module.`,
      });
    const follow = [...filtered.imports, ...filtered.forwarded];
    for (const next of follow) {
      const target = classify(next.specifier, module);
      if ("module" in target) {
        if (included.has(target.module)) continue;
        merge(requests, target.module, next.names, module);
        if (!done.has(target.module)) queue.push(target.module);
      } else if ("package" in target) recordPackage(next.specifier, module);
      else
        blockers.push({
          code: "unresolved_import",
          file: module,
          location: null,
          detail: `${next.specifier} does not resolve to a repository file.`,
        });
    }
    queue.sort(compare);
    const path = stubPathFor(module);
    stubs.set(path, { module, text: filtered.text });
    outbound.push({
      module,
      symbols: filtered.symbols.map((symbol) => ({ ...symbol })),
      importedBy: [...request.importedBy].sort(compare),
      stubPath: path,
    });
  }
  const inbound: BoundaryModule[] = [];
  for (const [module, request] of [...surface.entries()].sort(([a], [b]) =>
    compare(a, b),
  )) {
    const text = emit(module);
    if (text === null) {
      blockers.push({
        code: "declaration_incomplete",
        file: module,
        location: null,
        detail: "No declaration could be emitted for this module.",
      });
      inbound.push({
        module,
        symbols:
          request.names === ALL
            ? []
            : [...request.names]
                .sort()
                .map((name) => ({ name, kind: "unknown", declaration: null })),
        importedBy: [...request.importedBy].sort(compare),
        stubPath: null,
      });
      continue;
    }
    const filtered = filterDeclaration(text, request.names);
    for (const name of filtered.missing)
      blockers.push({
        code: "declaration_incomplete",
        file: module,
        location: null,
        detail: `${name} is imported from outside but not exported.`,
      });
    inbound.push({
      module,
      symbols: filtered.symbols.map((symbol) => ({ ...symbol })),
      importedBy: [...request.importedBy].sort(compare),
      stubPath: null,
    });
  }
  const dedupe = (list: SliceBlocker[]) => {
    const seen = new Set<string>();
    return list.filter((blocker) => {
      const key = JSON.stringify(blocker);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  return {
    extractorVersion: TYPESCRIPT_EXTRACTOR_VERSION,
    outbound: outbound.sort((a, b) => compare(a.module, b.module)),
    inbound,
    stubs: [...stubs.entries()]
      .sort(([a], [b]) => compare(a, b))
      .map(([path, stub]) => ({ path, ...stub })),
    blockers: dedupe(blockers),
    configs: [...configs].sort(compare),
    packages,
    compilerOptions: config.options,
  };
}
