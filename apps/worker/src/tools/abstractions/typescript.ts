/**
 * The typed tier of the abstractions builder: every TypeScript and
 * JavaScript module's exports, as the compiler's own declaration emitter
 * writes them, with the line, kind and the types each names.
 *
 * Modules are grouped by their nearest `tsconfig.json` and each group is
 * one program, built with the slice's bounded compiler host, so nothing
 * outside the source or the compiler's own library is read and nothing in
 * the repository is executed. A group whose program would parse more than
 * `PROGRAM_FILES_MAX` repository files is not compiled: its modules go to
 * the syntactic tier, and an omission says so. Packages are not installed,
 * so a type from one is a reference by specifier.
 *
 * The compiler is synchronous and a monorepo-sized program holds the event
 * loop for a long time, so the adapter runs this in a worker thread
 * (`thread.ts`); the result is plain data.
 */

import { Worker } from "node:worker_threads";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  ABSTRACTION_LIMITS,
  boundedSignature,
  surfaceLanguageOf,
} from "sandbox-factory";
import type { AbstractionOmission, SurfaceKind } from "sandbox-factory";
import ts from "typescript-compiler";
import {
  ALL,
  PROGRAM_FILES_MAX,
  TYPESCRIPT_EXTRACTOR_VERSION,
  boundedHost,
  extractionOptions,
  filterDeclaration,
  isNodeBuiltin,
  loadConfig,
} from "../slice/typescript.js";
import type { LoadedConfig } from "../compiler-config.js";

/** A type an export names: another module's export, or a package. */
export type RawReference =
  | { readonly module: string; readonly name: string }
  | { readonly package: string };

export interface RawExport {
  readonly name: string;
  readonly kind: SurfaceKind;
  readonly signature: string;
  readonly line: number;
  readonly references: readonly RawReference[];
}

export interface RawModule {
  readonly path: string;
  readonly language: string;
  readonly exports: readonly RawExport[];
}

export interface TypedInput {
  readonly root: string;
  /** Repository-relative script paths, sorted. */
  readonly files: readonly string[];
  /** Defaults to `PROGRAM_FILES_MAX`. */
  readonly maxProgramFiles?: number;
}

export interface TypedSurfaces {
  readonly extractorVersion: string;
  /** Sorted by path. */
  readonly modules: readonly RawModule[];
  /** Files whose program passed the cap; the syntactic tier reads them. */
  readonly fallback: readonly string[];
  readonly omissions: readonly AbstractionOmission[];
}

class ProgramTooLarge extends Error {}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const isDeclarationFile = (path: string) => /\.d\.[cm]?ts$/.test(path);

/** What a declaration is, read off the node the compiler bound. */
function kindOfDeclaration(node: ts.Node | undefined): SurfaceKind | null {
  if (node === undefined) return null;
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node))
    return "function";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isModuleDeclaration(node) || ts.isSourceFile(node)) return "namespace";
  if (ts.isVariableDeclaration(node)) {
    const value = node.initializer;
    if (value !== undefined && ts.isClassExpression(value)) return "class";
    return value !== undefined &&
      (ts.isArrowFunction(value) || ts.isFunctionExpression(value))
      ? "function"
      : "const";
  }
  return null;
}

/** `filterDeclaration`'s kind words, for a symbol the checker could not place. */
function kindOfWord(word: string): SurfaceKind {
  switch (word) {
    case "function":
    case "class":
    case "interface":
    case "type":
    case "enum":
    case "namespace":
      return word;
    default:
      return "const";
  }
}

/** Where a name a declaration file uses comes from. */
type Binding = { readonly specifier: string; readonly name: string };

/** The names a declaration file's imports bind, and from where. */
function importBindings(source: ts.SourceFile): Map<string, Binding> {
  const bindings = new Map<string, Binding>();
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (clause?.name !== undefined)
        bindings.set(clause.name.text, { specifier, name: "default" });
      const named = clause?.namedBindings;
      if (named !== undefined && ts.isNamespaceImport(named))
        bindings.set(named.name.text, { specifier, name: ALL });
      else if (named !== undefined)
        for (const element of named.elements)
          bindings.set(element.name.text, {
            specifier,
            name: (element.propertyName ?? element.name).text,
          });
    } else if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      ts.isStringLiteralLike(statement.moduleReference.expression)
    )
      bindings.set(statement.name.text, {
        specifier: statement.moduleReference.expression.text,
        name: ALL,
      });
  }
  return bindings;
}

const leftmost = (name: ts.EntityName | ts.Expression): string | null =>
  ts.isIdentifier(name)
    ? name.text
    : ts.isQualifiedName(name)
      ? leftmost(name.left)
      : ts.isPropertyAccessExpression(name)
        ? leftmost(name.expression)
        : null;

/**
 * The type names a declaration's text mentions, and the modules it names
 * directly (`import("x").T`, `export { a } from "x"`).
 */
function mentions(text: string): {
  names: Set<string>;
  direct: Binding[];
} {
  const source = ts.createSourceFile(
    "s.d.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set<string>();
  const direct: Binding[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isTypeReferenceNode(node)) {
      const name = leftmost(node.typeName);
      if (name !== null) names.add(name);
    } else if (ts.isExpressionWithTypeArguments(node)) {
      const name = leftmost(node.expression);
      if (name !== null) names.add(name);
    } else if (ts.isTypeQueryNode(node)) {
      const name = leftmost(node.exprName);
      if (name !== null) names.add(name);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      const qualifier =
        node.qualifier === undefined ? null : leftmost(node.qualifier);
      direct.push({
        specifier: node.argument.literal.text,
        name: qualifier ?? ALL,
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      const clause = node.exportClause;
      if (clause !== undefined && ts.isNamedExports(clause))
        for (const element of clause.elements)
          direct.push({
            specifier,
            name: (element.propertyName ?? element.name).text,
          });
      else direct.push({ specifier, name: ALL });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { names, direct };
}

/** The names a top-level statement of a declaration file binds. */
function declaredNames(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement))
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
    );
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)) &&
    statement.name !== undefined &&
    ts.isIdentifier(statement.name)
  )
    return [statement.name.text];
  return [];
}

/**
 * One name's part of an `export { a, b, c }` statement, which the emitted
 * declaration gives every name it lists: `export { b } from "./x.js";`, so
 * a barrel does not repeat each line once per name. Any other signature is
 * returned as it is.
 */
function ownSpecifier(signature: string, name: string): string {
  const parsed = ts.createSourceFile(
    "s.d.ts",
    signature,
    ts.ScriptTarget.Latest,
    true,
  );
  const [statement, ...rest] = parsed.statements;
  if (
    statement === undefined ||
    rest.length > 0 ||
    !ts.isExportDeclaration(statement) ||
    statement.exportClause === undefined ||
    !ts.isNamedExports(statement.exportClause) ||
    statement.exportClause.elements.length < 2
  )
    return signature;
  const element = statement.exportClause.elements.find(
    (each) => each.name.text === name,
  );
  if (element === undefined) return signature;
  const from =
    statement.moduleSpecifier === undefined
      ? ""
      : ` from ${statement.moduleSpecifier.getText(parsed)}`;
  return `export ${statement.isTypeOnly ? "type " : ""}{ ${element.getText(parsed)} }${from};`;
}

/** A specifier from one repository module to another, as an import would read. */
function specifierBetween(from: string, to: string): string {
  const path = relative(dirname(from), to)
    .replaceAll("\\", "/")
    .replace(/(\.d)?\.[cm]?[jt]sx?$/, "");
  return path.startsWith(".") ? path : `./${path}`;
}

export function extractTypedSurfaces(input: TypedInput): TypedSurfaces {
  const root = resolve(input.root);
  const rel = (path: string) => relative(root, path).replaceAll("\\", "/");
  const abs = (path: string) => resolve(root, path);
  const maxFiles = input.maxProgramFiles ?? PROGRAM_FILES_MAX;
  const omissions: AbstractionOmission[] = [];
  const modules: RawModule[] = [];
  const fallback: string[] = [];
  // Files in one directory share their nearest tsconfig; read each once.
  const configs = new Map<string, LoadedConfig>();
  const groups = new Map<string, { config: LoadedConfig; files: string[] }>();
  for (const file of [...input.files].sort(compare)) {
    const directory = dirname(file);
    let config = configs.get(directory);
    if (config === undefined) {
      config = loadConfig(root, file);
      configs.set(directory, config);
    }
    const key = config.path ?? "";
    const group = groups.get(key) ?? { config, files: [] };
    group.files.push(file);
    groups.set(key, group);
  }
  for (const [key, { config, files }] of [...groups].sort(([a], [b]) =>
    compare(a, b),
  )) {
    for (const error of config.errors)
      omissions.push({
        code: "compiler_config",
        file: config.path,
        detail: error,
      });
    const options: ts.CompilerOptions = {
      ...extractionOptions(config.options),
      allowJs: true,
      checkJs: false,
    };
    const host = boundedHost(root, options);
    let parsed = 0;
    const parse = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, ...rest) => {
      const path = rel(resolve(fileName));
      if (!path.startsWith("..") && !isAbsolute(path) && ++parsed > maxFiles)
        throw new ProgramTooLarge();
      return parse(fileName, ...rest);
    };
    let program: ts.Program;
    try {
      program = ts.createProgram(files.map(abs), options, host);
    } catch (error) {
      if (!(error instanceof ProgramTooLarge)) throw error;
      fallback.push(...files);
      omissions.push({
        code: "program_too_large",
        file: key === "" ? null : key,
        detail: `This project reaches more than ${maxFiles} repository files; its ${files.length} modules are read syntactically.`,
      });
      continue;
    }
    const checker = program.getTypeChecker();
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
    const reference = (binding: Binding, from: string): RawReference | null => {
      const module = resolveSpecifier(binding.specifier, from);
      if (module !== null)
        return binding.name === ALL ? null : { module, name: binding.name };
      if (/^[./]/.test(binding.specifier) || isNodeBuiltin(binding.specifier))
        return null;
      return { package: binding.specifier };
    };
    for (const file of files) {
      const source = program.getSourceFile(abs(file));
      if (source === undefined) {
        omissions.push({
          code: "declaration_failed",
          file,
          detail: "The compiler did not read this module.",
        });
        continue;
      }
      let text: string | null = isDeclarationFile(file) ? source.text : null;
      if (text === null)
        program.emit(
          source,
          (fileName, content) => {
            if (isDeclarationFile(fileName)) text = content;
          },
          undefined,
          true,
        );
      if (text === null) {
        omissions.push({
          code: "declaration_failed",
          file,
          detail: "No declaration could be emitted for this module.",
        });
        continue;
      }
      const declarationText: string = text;
      const filtered = filterDeclaration(declarationText, ALL);
      const declaration = ts.createSourceFile(
        "m.d.ts",
        declarationText,
        ts.ScriptTarget.Latest,
        true,
      );
      const bindings = importBindings(declaration);
      // Statements by the local names they declare, for `export default x`.
      const locals = new Map<string, string>();
      for (const statement of declaration.statements)
        for (const name of declaredNames(statement))
          locals.set(name, statement.getText(declaration));
      const exportedNames = new Set(filtered.symbols.map((s) => s.name));
      const signatures = new Map(
        filtered.symbols.map((symbol) => [symbol.name, symbol] as const),
      );
      const moduleSymbol = checker.getSymbolAtLocation(source);
      const symbols =
        moduleSymbol === undefined
          ? []
          : checker.getExportsOfModule(moduleSymbol);
      const starLine =
        source.statements
          .filter(
            (statement) =>
              ts.isExportDeclaration(statement) &&
              statement.exportClause === undefined,
          )
          .map(
            (statement) =>
              source.getLineAndCharacterOfPosition(statement.getStart(source))
                .line + 1,
          )[0] ?? 1;
      const exports: RawExport[] = [];
      for (const symbol of symbols) {
        const name = ts.symbolName(symbol);
        const own = symbol.declarations?.find(
          (node) => node.getSourceFile() === source,
        );
        const line =
          own === undefined
            ? starLine
            : source.getLineAndCharacterOfPosition(own.getStart(source)).line +
              1;
        const target =
          (symbol.flags & ts.SymbolFlags.Alias) !== 0
            ? checker.getAliasedSymbol(symbol)
            : symbol;
        const targetNode = target.declarations?.[0];
        const emitted = signatures.get(name);
        let signature: string;
        const references: RawReference[] = [];
        if (emitted !== undefined) {
          signature = ownSpecifier(emitted.declaration, name);
          const assigned = /^export default ([A-Za-z_$][\w$]*);$/.exec(
            signature,
          );
          const local =
            assigned?.[1] === undefined ? undefined : locals.get(assigned[1]);
          if (local !== undefined) signature = `${local}\n${signature}`;
          const { names, direct } = mentions(signature);
          for (const mentioned of names) {
            const binding = bindings.get(mentioned);
            const found =
              binding !== undefined
                ? reference(binding, file)
                : exportedNames.has(mentioned) && mentioned !== name
                  ? { module: file, name: mentioned }
                  : null;
            if (found !== null) references.push(found);
          }
          for (const binding of direct) {
            const found = reference(binding, file);
            if (found !== null) references.push(found);
          }
        } else {
          // Forwarded by `export *`: the emitted file names the module, not
          // the symbol, so the export reads as the re-export it is.
          const origin = targetNode?.getSourceFile();
          const originPath = origin === undefined ? null : rel(origin.fileName);
          if (
            originPath === null ||
            originPath.startsWith("..") ||
            isAbsolute(originPath)
          )
            signature = `export { ${name} };`;
          else {
            signature = `export { ${name} } from "${specifierBetween(file, originPath)}";`;
            references.push({
              module: originPath,
              name: ts.symbolName(target),
            });
          }
        }
        const bounded = boundedSignature(signature);
        if (bounded.truncated)
          omissions.push({
            code: "signature_truncated",
            file,
            detail: `${name} is longer than ${ABSTRACTION_LIMITS.signatureChars} characters.`,
          });
        exports.push({
          name,
          kind:
            kindOfDeclaration(targetNode) ??
            kindOfWord(emitted?.kind ?? "variable"),
          signature: bounded.signature,
          line,
          references,
        });
      }
      exports.sort((a, b) => a.line - b.line || compare(a.name, b.name));
      if (exports.length > ABSTRACTION_LIMITS.exportsPerModule)
        omissions.push({
          code: "exports_capped",
          file,
          detail: `${exports.length} exports; the first ${ABSTRACTION_LIMITS.exportsPerModule} are listed.`,
        });
      modules.push({
        path: file,
        language: surfaceLanguageOf(file) ?? "typescript",
        exports: exports.slice(0, ABSTRACTION_LIMITS.exportsPerModule),
      });
    }
  }
  return {
    extractorVersion: TYPESCRIPT_EXTRACTOR_VERSION,
    modules: modules.sort((a, b) => compare(a.path, b.path)),
    fallback: fallback.sort(compare),
    omissions,
  };
}

/**
 * `extractTypedSurfaces` in a worker thread, so a long compile does not hold
 * the event loop past the lease heartbeat. Aborting terminates the thread.
 */
export function extractTypedSurfacesInThread(
  input: TypedInput,
  signal: AbortSignal,
): Promise<TypedSurfaces> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(new URL("./thread.js", import.meta.url), {
      workerData: input,
    });
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      void worker.terminate();
      finish();
    };
    const abort = () => settle(() => reject(signal.reason));
    signal.addEventListener("abort", abort, { once: true });
    worker.once("message", (result: TypedSurfaces) =>
      settle(() => resolvePromise(result)),
    );
    worker.once("error", (error) => settle(() => reject(error)));
    worker.once("exit", (code) =>
      settle(() =>
        reject(new Error(`The compiler thread exited with ${code}.`)),
      ),
    );
  });
}
