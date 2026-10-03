/**
 * The standalone project a sandbox version becomes, as a pure function of
 * the slice, the aliased source and the approved task.
 *
 * Copied source keeps its repository structure. Everything generated lives
 * apart from it and is classified: declaration stubs beside runtime mocks
 * for the modules the slice imports from outside, mock packages for the
 * service SDKs it imports, a harness directory with the recording mock
 * runtime and the ambient declarations the slice already compiled against,
 * public tests under `tests/public`, hidden tests under `tests/private`,
 * and the configuration that makes `npm ci`, `npm run dev`, `npm run build`
 * and `npm test` work on a clean machine with no platform credentials.
 *
 * An import the source makes through a compiler alias is rewritten to a
 * relative path and recorded; a bare specifier that neither a package nor
 * a cut module explains is a blocker, never a guess. Bodies of editable
 * source are never rewritten beyond those specifiers.
 */

import type { SpecDraft } from "../pricing/spec.js";
import type {
  BoundaryContract,
  BoundaryModule,
  BoundarySymbol,
  SliceManifest,
} from "../slice/manifest.js";
import {
  SANDBOX_COMMANDS,
  SANDBOX_TOOLCHAIN,
  type Toolchain,
} from "./build.js";
import {
  TASK_DESCRIPTOR_PATH,
  TASK_DESCRIPTOR_SCHEMA_VERSION,
  type TaskDescriptor,
} from "./descriptor.js";
import {
  fixtureMockPath,
  fixtureProblems,
  type SandboxFixture,
} from "./fixtures.js";
import {
  packageNameOf,
  type AcceptanceTest,
  type PathClass,
  type ResolvedDependency,
} from "./provenance.js";

export const HARNESS_DIR = "sandbox";
export const MOCKS_DIR = "mocks";
export const PUBLIC_TESTS_DIR = "tests/public";
export const PRIVATE_TESTS_DIR = "tests/private";
export const MOCK_RUNTIME_PATH = `${HARNESS_DIR}/mock.js`;
export const AMBIENT_PATH = `${HARNESS_DIR}/ambient.d.ts`;
export const RUN_PATH = `${HARNESS_DIR}/run.ts`;
export const ENV_FILE = "sandbox.env";

export interface ProjectVersion {
  readonly sandboxId: string;
  readonly versionId: string;
  readonly version: number;
  readonly title: string;
  readonly specSummary: string;
  readonly complexity: string;
  readonly tags: readonly string[];
}

export interface ProjectSource {
  /** The repository path, before aliasing. */
  readonly originalPath: string;
  /** The path in the project, after aliasing. */
  readonly path: string;
  readonly text: string;
}

export interface ProjectStub {
  /** The cut module's repository path, before aliasing. */
  readonly module: string;
  /** The module's path after aliasing, with its source extension. */
  readonly path: string;
  /** The declaration stub's text, after aliasing. */
  readonly text: string;
}

export interface ProjectInput {
  readonly version: ProjectVersion;
  readonly manifest: SliceManifest;
  readonly contract: BoundaryContract;
  readonly sources: readonly ProjectSource[];
  readonly stubs: readonly ProjectStub[];
  readonly spec: SpecDraft | null;
  readonly dependencies: readonly ResolvedDependency[];
  readonly acceptanceTests: readonly AcceptanceTest[];
  /** Bare specifiers that need no rewrite: Node's modules and packages. */
  readonly knownSpecifiers: readonly string[];
  /** A safe subset of the source's compiler options, if the worker read them. */
  readonly compilerOptions?: Readonly<Record<string, unknown>>;
  readonly toolchain?: Toolchain;
  /** Default behaviour for mocked calls, aliased with the version. */
  readonly fixtures?: readonly SandboxFixture[];
  /** The walkthrough `npm run dev` runs, in place of the generated one. */
  readonly scenario?: string | null;
}

export interface GeneratedFile {
  readonly path: string;
  readonly text: string;
  readonly class: PathClass;
  readonly public: boolean;
}

export interface ImportRewrite {
  readonly file: string;
  readonly from: string;
  readonly to: string;
}

export interface ProjectBlocker {
  readonly code:
    | "import_unrewritable"
    | "language_unsupported"
    | "mock_unsupported"
    | "path_conflict"
    | "test_path_invalid"
    | "alias_failed"
    | "scope_blocked"
    | "fixture_invalid"
    | "baseline_failed";
  readonly file: string | null;
  readonly detail: string;
}

export interface GeneratedProject {
  readonly files: readonly GeneratedFile[];
  readonly importRewrites: readonly ImportRewrite[];
  readonly descriptor: TaskDescriptor;
  readonly publicTests: readonly string[];
  readonly blockers: readonly ProjectBlocker[];
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const VALUE_KINDS: readonly string[] = [
  "function",
  "class",
  "variable",
  "module",
];
const TYPE_KINDS: readonly string[] = ["interface", "type"];

/**
 * The runtime shape of a symbol. The extractor names most kinds; a
 * re-export it could only follow by name arrives as `unknown`, and its
 * declaration text says whether it is a type (`export type { X }`,
 * `interface`, `type`) or a value. A symbol with neither a kind nor a
 * declaration cannot be mocked.
 */
export function runtimeKindOf(
  symbol: BoundarySymbol,
): "value" | "type" | "enum" | "unknown" {
  if (symbol.kind === "enum") return "enum";
  if (VALUE_KINDS.includes(symbol.kind)) return "value";
  if (TYPE_KINDS.includes(symbol.kind)) return "type";
  const declaration = symbol.declaration?.trim() ?? "";
  if (declaration === "") return "unknown";
  if (/^export\s+type\s*\{/.test(declaration)) return "type";
  if (/^(export\s+)?(declare\s+)?(interface|type)\s/.test(declaration))
    return "type";
  if (/^(export\s+)?(declare\s+)?(const\s+)?enum\s/.test(declaration))
    return "enum";
  if (
    /^(export\s+)?(declare\s+)?(abstract\s+)?(function|class|const|let|var|namespace|module)\s/.test(
      declaration,
    )
  )
    return "value";
  if (/^export\s+(default\s+|\{)/.test(declaration)) return "value";
  return "unknown";
}
const IMPORT_LITERAL =
  /((?:\bimport|\bexport)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?|\brequire\(\s*|\bimport\(\s*)(['"])([^'"\n]+)\2/g;
const NAMED_IMPORT =
  /\bimport\s+(type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"\n]+)['"]/g;

/**
 * Whether the text before `offset` on its line opens a comment: a
 * commented-out import, or one quoted in a doc comment, is not an import.
 */
function onCommentLine(text: string, offset: number): boolean {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  return /^\s*(\/\/|\/\*|\*)/.test(text.slice(start, offset));
}

export function dirnameOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

/** `../lib/service.js` from `src/app.ts` to `lib/service.ts`. */
export function relativeSpecifier(fromFile: string, toFile: string): string {
  const from = dirnameOf(fromFile).split("/").filter(Boolean);
  const to = toFile.split("/").filter(Boolean);
  let common = 0;
  while (
    common < from.length &&
    common < to.length - 1 &&
    from[common] === to[common]
  )
    common += 1;
  const up = from.length - common;
  const rest = to.slice(common).join("/");
  const prefix = up === 0 ? "./" : "../".repeat(up);
  return `${prefix}${runtimePath(rest)}`;
}

/** The emitted JavaScript path of a TypeScript source path. */
export function runtimePath(path: string): string {
  if (path.endsWith(".d.ts")) return `${path.slice(0, -5)}.js`;
  if (path.endsWith(".mts")) return `${path.slice(0, -4)}.mjs`;
  if (path.endsWith(".cts")) return `${path.slice(0, -4)}.cjs`;
  if (path.endsWith(".tsx") || path.endsWith(".ts"))
    return `${path.replace(/\.tsx?$/, "")}.js`;
  return path;
}

/** `x.ts`, `x.tsx` and `x.js` → `x.d.ts`; `x.mts` → `x.d.mts`; `x.cts` → `x.d.cts`. */
export function declarationPath(path: string): string {
  if (/\.d\.[cm]?ts$/.test(path)) return path;
  const match = /\.([cm]?)[jt]sx?$/.exec(path);
  return match === null
    ? `${path}.d.ts`
    : `${path.slice(0, -match[0].length)}.d.${match[1] ?? ""}ts`;
}

/** `../lib/x.js` from `sandbox` is `lib/x.js`; null when it leaves the root. */
function joinRelative(dir: string, specifier: string): string | null {
  const parts = dir.split("/").filter(Boolean);
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

/** The sources a `.js`-style specifier names under NodeNext resolution. */
function sourceCandidates(path: string): string[] {
  if (path.endsWith(".mjs")) return [`${path.slice(0, -4)}.mts`];
  if (path.endsWith(".cjs")) return [`${path.slice(0, -4)}.cts`];
  if (path.endsWith(".js")) {
    const stem = path.slice(0, -3);
    return [`${stem}.ts`, `${stem}.tsx`, `${stem}.d.ts`];
  }
  return [];
}

function isScript(path: string): boolean {
  return /\.(m|c)?tsx?$/.test(path) && !path.endsWith(".d.ts");
}

/** Members of a `declare enum` declaration, as `[name, value]` pairs. */
export function enumMembers(
  declaration: string,
): { name: string; value: string | number }[] | null {
  const match = /enum\s+[\w$]+\s*\{([\s\S]*?)\}/.exec(declaration);
  if (match === null) return null;
  const members: { name: string; value: string | number }[] = [];
  let next = 0;
  for (const raw of (match[1] ?? "").split(",")) {
    const entry = raw.trim();
    if (entry === "") continue;
    const parts = /^([\w$]+|"[^"]*"|'[^']*')\s*(?:=\s*([\s\S]+))?$/.exec(entry);
    if (parts === null) return null;
    const name = (parts[1] ?? "").replace(/^['"]|['"]$/g, "");
    const initializer = parts[2]?.trim();
    if (initializer === undefined) {
      members.push({ name, value: next });
      next += 1;
    } else if (/^-?\d+(\.\d+)?$/.test(initializer)) {
      const value = Number(initializer);
      members.push({ name, value });
      next = value + 1;
    } else if (/^(['"]).*\1$/.test(initializer))
      members.push({ name, value: initializer.slice(1, -1) });
    else return null;
  }
  return members;
}

const RESERVED_WORDS = new Set(
  "await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield".split(
    " ",
  ),
);
/**
 * `export const name = value;`, or for a name that is not an identifier
 * (`"weird-name"`, a reserved word) a local binding exported under the
 * string name, which ES2022 modules allow.
 */
function exportValue(name: string, value: string, index: number): string {
  if (/^[A-Za-z_$][\w$]*$/.test(name) && !RESERVED_WORDS.has(name))
    return `export const ${name} = ${value};`;
  const local = `__export${index}`;
  return `const ${local} = ${value};\nexport { ${local} as ${JSON.stringify(name)} };`;
}

function mockRuntimeFor(
  modulePath: string,
  originalModule: string,
  symbols: readonly BoundarySymbol[],
  fixtures: readonly SandboxFixture[],
  blockers: ProjectBlocker[],
): string {
  const lines = [
    `// Generated runtime for the declarations in ${declarationPath(modulePath).split("/").pop() ?? ""}.`,
    "// Every value is a recording mock; see sandbox/mock.js and the README.",
    `import { ${fixtures.length === 0 ? "createMock" : "createMock, fixture"} } from "${relativeSpecifier(modulePath, MOCK_RUNTIME_PATH)}";`,
    `const mock = createMock(${JSON.stringify(`module:${originalModule}`)});`,
  ];
  // Default behaviour the task gives some calls; tests can still override it.
  for (const item of [...fixtures].sort((a, b) =>
    compare(fixtureMockPath(a), fixtureMockPath(b)),
  ))
    lines.push(
      `fixture(${JSON.stringify(fixtureMockPath(item))}, ${item.implementation.trim()});`,
    );
  let exported = 0;
  for (const symbol of [...symbols].sort((a, b) => compare(a.name, b.name))) {
    const shape = runtimeKindOf(symbol);
    if (shape === "type") continue;
    if (shape === "enum") {
      const members = enumMembers(symbol.declaration ?? "");
      if (members === null) {
        blockers.push({
          code: "mock_unsupported",
          file: originalModule,
          detail: `The enum ${symbol.name} has members the generator cannot evaluate.`,
        });
        continue;
      }
      const entries = members.flatMap((member) => [
        `${JSON.stringify(member.name)}: ${JSON.stringify(member.value)}`,
        ...(typeof member.value === "number"
          ? [
              `${JSON.stringify(String(member.value))}: ${JSON.stringify(member.name)}`,
            ]
          : []),
      ]);
      lines.push(
        exportValue(
          symbol.name,
          `Object.freeze({ ${entries.join(", ")} })`,
          exported,
        ),
      );
      exported += 1;
      continue;
    }
    if (shape === "unknown") {
      blockers.push({
        code: "mock_unsupported",
        file: originalModule,
        detail: `${symbol.name} has kind ${symbol.kind} and no declaration that says its runtime shape.`,
      });
      continue;
    }
    lines.push(
      symbol.name === "default"
        ? "export default mock.default;"
        : exportValue(
            symbol.name,
            `mock[${JSON.stringify(symbol.name)}]`,
            exported,
          ),
    );
    exported += 1;
  }
  if (exported === 0) lines.push("export {};");
  return `${lines.join("\n")}\n`;
}

const MOCK_RUNTIME = `// The recording mock every generated module and package shares.
//
// A mock answers any property with another mock, any call with a mock and
// records the call. It is not thenable, so awaiting one gives the mock
// back, and it prints as [mock <name>]. Tests can install an implementation
// for a path with mockImplementation() and read what was called with
// recordedCalls(). Nothing here reaches a network or a credential.
const calls = [];
const implementations = new Map();
const fixtures = new Map();
export function recordedCalls() {
  return calls.slice();
}
/** Clears recorded calls and installed implementations; fixtures stay. */
export function resetMocks() {
  calls.length = 0;
  implementations.clear();
}
/** @param {string} path such as "module:lib/service.ts.createService" */
export function mockImplementation(path, implementation) {
  implementations.set(path, implementation);
}
/** The task's default behaviour for a path; mockImplementation() overrides it. */
export function fixture(path, implementation) {
  fixtures.set(path, implementation);
}
export function createMock(origin, name = origin) {
  const target = function mock() {};
  return new Proxy(target, {
    get(_target, property) {
      if (property === "then") return undefined;
      if (property === Symbol.toPrimitive) return () => \`[mock \${name}]\`;
      if (property === Symbol.iterator) return function* iterate() {};
      if (property === "toJSON") return () => ({ mock: name });
      if (typeof property === "symbol") return undefined;
      return createMock(origin, \`\${name}.\${property}\`);
    },
    apply(_target, _self, args) {
      calls.push({ name, args });
      const implementation = implementations.get(name) ?? fixtures.get(name);
      return implementation === undefined
        ? createMock(origin, \`\${name}()\`)
        : implementation(...args);
    },
    construct(_target, args) {
      calls.push({ name: \`new \${name}\`, args });
      const implementation =
        implementations.get(\`new \${name}\`) ?? fixtures.get(\`new \${name}\`);
      return implementation === undefined
        ? createMock(origin, \`\${name}#\`)
        : implementation(...args);
    },
    has() {
      return true;
    },
  });
}
`;

export const MOCK_RUNTIME_TYPES = `export interface RecordedCall {
  readonly name: string;
  readonly args: readonly unknown[];
}
export function recordedCalls(): RecordedCall[];
export function resetMocks(): void;
export function mockImplementation(
  path: string,
  implementation: (...args: unknown[]) => unknown,
): void;
export function fixture(
  path: string,
  implementation: (...args: any[]) => unknown,
): void;
export function createMock(origin: string, name?: string): any;
`;

export function ambientDeclarations(packages: readonly string[]): string {
  const lines = [
    "// The same declarations the slice was type-checked against: Node's",
    "// modules and globals untyped, and every package untyped. The project",
    "// installs its approved packages for real; their own types are not",
    "// consulted, so a contribution is checked against the slice's contract.",
    'declare module "node:*";',
    "declare var process: any;",
    "declare var Buffer: any;",
    "declare var global: any;",
    "declare var globalThis: any;",
    "declare var require: any;",
    "declare var module: any;",
    "declare var exports: any;",
    "declare var __dirname: string;",
    "declare var __filename: string;",
    "declare var console: any;",
    "declare function setTimeout(handler: (...args: any[]) => void, ms?: number, ...args: any[]): any;",
    "declare function clearTimeout(handle: any): void;",
    "declare function setInterval(handler: (...args: any[]) => void, ms?: number, ...args: any[]): any;",
    "declare function clearInterval(handle: any): void;",
    "declare function queueMicrotask(callback: () => void): void;",
    "declare function structuredClone<T>(value: T): T;",
  ];
  for (const name of [...new Set(packages)].sort(compare))
    lines.push(`declare module "${name}";`, `declare module "${name}/*";`);
  return `${lines.join("\n")}\n`;
}

const SAFE_COMPILER_KEYS: readonly string[] = [
  "strict",
  "target",
  "lib",
  "jsx",
  "esModuleInterop",
  "allowSyntheticDefaultImports",
  "exactOptionalPropertyTypes",
  "noUncheckedIndexedAccess",
  "noImplicitAny",
  "strictNullChecks",
  "useDefineForClassFields",
  "verbatimModuleSyntax",
  "isolatedModules",
  "resolveJsonModule",
  "experimentalDecorators",
  "emitDecoratorMetadata",
  "noImplicitOverride",
  "noPropertyAccessFromIndexSignature",
  "useUnknownInCatchVariables",
];

/**
 * The compiler options a generated project builds with: the source's safe
 * options carried over, Node's ESM resolution, no emitted declarations.
 */
export function projectCompilerOptions(
  options: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const carried: Record<string, unknown> = {};
  for (const key of SAFE_COMPILER_KEYS)
    if (options !== undefined && options[key] !== undefined)
      carried[key] = options[key];
  return {
    strict: true,
    target: "ES2022",
    ...carried,
    module: "NodeNext",
    moduleResolution: "NodeNext",
    rootDir: ".",
    declaration: false,
    sourceMap: false,
    noEmitOnError: true,
    skipLibCheck: true,
    types: [],
    allowJs: false,
  };
}

function tsconfigFor(options: Readonly<Record<string, unknown>> | undefined) {
  return `${JSON.stringify(
    {
      compilerOptions: projectCompilerOptions(options),
      include: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
      exclude: ["node_modules", MOCKS_DIR],
    },
    null,
    2,
  )}\n`;
}

function scanNamedImports(
  sources: readonly ProjectSource[],
): Map<string, Set<string>> {
  const names = new Map<string, Set<string>>();
  for (const source of sources)
    for (const match of source.text.matchAll(NAMED_IMPORT)) {
      // Type-only imports need no runtime export.
      if (match[1] !== undefined) continue;
      const specifier = match[3] ?? "";
      const list = names.get(packageNameOf(specifier)) ?? new Set();
      for (const part of (match[2] ?? "").split(",")) {
        const trimmed = part.trim();
        if (trimmed === "" || /^type\s/.test(trimmed)) continue;
        const name = trimmed.split(/\s+as\s+/)[0]?.trim();
        if (name !== undefined && name !== "" && name !== "default")
          list.add(name);
      }
      names.set(packageNameOf(specifier), list);
    }
  return names;
}

function escapeJs(text: string): string {
  return JSON.stringify(text);
}

function specTests(spec: SpecDraft | null): string {
  const lines = [
    "// Scenario skeletons from the approved spec. Each one names what a",
    "// contribution must make true; fill in the body as you go. They are",
    "// marked todo so the public run reports them without failing.",
    'import { test } from "node:test";',
    "",
  ];
  if (spec === null || spec.scenarios.length === 0) {
    lines.push(
      'test("the spec names no scenarios yet", { todo: true }, () => {});',
    );
    return `${lines.join("\n")}\n`;
  }
  for (const line of spec.background) lines.push(`// Background: ${line}`);
  if (spec.background.length > 0) lines.push("");
  for (const scenario of spec.scenarios) {
    lines.push(
      `test(${escapeJs(`${scenario.id}: ${scenario.title}`)}, { todo: true }, () => {`,
    );
    for (const step of scenario.steps)
      lines.push(`  // ${step.keyword} ${step.text}`);
    lines.push("});", "");
  }
  return `${lines.join("\n")}\n`;
}

function interfaceTests(
  inbound: readonly BoundaryModule[],
  aliasedOf: (original: string) => string | null,
  entries: readonly string[],
): string {
  const lines = [
    "// The public surface: what code outside the slice imports from it.",
    "// A contribution must keep every one of these exports in place; the",
    "// platform checks their contracts too, so keeping a name alone is not",
    "// compatibility.",
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    "",
  ];
  const testFile = `${PUBLIC_TESTS_DIR}/interface.test.ts`;
  let count = 0;
  for (const module of inbound) {
    const path = aliasedOf(module.module);
    if (path === null) continue;
    const values = module.symbols
      .filter((symbol) => runtimeKindOf(symbol) !== "type")
      .map((symbol) => symbol.name);
    if (values.length === 0) continue;
    count += 1;
    lines.push(
      `test(${escapeJs(`${path} keeps its public surface`)}, async () => {`,
      `  const module = (await import(${escapeJs(relativeSpecifier(testFile, path))})) as Record<string, unknown>;`,
    );
    for (const name of values)
      lines.push(
        `  assert.notEqual(module[${escapeJs(name)}], undefined, ${escapeJs(`${name} must stay exported`)});`,
      );
    lines.push("});", "");
  }
  if (count === 0)
    for (const entry of entries) {
      lines.push(
        `test(${escapeJs(`${entry} loads`)}, async () => {`,
        `  assert.ok(await import(${escapeJs(relativeSpecifier(testFile, entry))}));`,
        "});",
        "",
      );
    }
  return `${lines.join("\n")}\n`;
}

function runScript(entries: readonly string[]): string {
  const lines = [
    "// `npm run dev`: load every entry point with the mocks in place and",
    "// report what it exports. Replace or extend this to exercise the task.",
    "",
  ];
  if (entries.length === 0) lines.push('console.log("No entry points.");');
  for (const entry of entries)
    lines.push(
      `console.log(${escapeJs(entry)}, Object.keys(await import(${escapeJs(relativeSpecifier(RUN_PATH, entry))})));`,
    );
  return `${lines.join("\n")}\n`;
}

function readme(input: {
  version: ProjectVersion;
  toolchain: Toolchain;
  editable: readonly string[];
  mockedModules: readonly string[];
  mockedPackages: readonly string[];
  approvedPackages: readonly { name: string; version: string }[];
  environment: readonly string[];
  rewrites: readonly ImportRewrite[];
  publicTests: readonly string[];
  fixtures: number;
  walkthrough: boolean;
}): string {
  const list = (items: readonly string[], empty: string) =>
    items.length === 0 ? [empty] : items.map((item) => `- \`${item}\``);
  return `${[
    `# ${input.version.title}`,
    "",
    input.version.specSummary,
    "",
    `Task \`${input.version.versionId}\` (version ${input.version.version}, size ${input.version.complexity}).`,
    "",
    "## Run it",
    "",
    `Node ${input.toolchain.nodeRange} and npm ${input.toolchain.npm} (\`.nvmrc\` says \`${input.toolchain.node}\`). Supported on ${input.toolchain.supportedPlatforms.join(", ")}. No account, container or remote session is needed; nothing runs until you run it.`,
    "",
    "```sh",
    SANDBOX_COMMANDS.install,
    SANDBOX_COMMANDS.dev,
    SANDBOX_COMMANDS.build,
    SANDBOX_COMMANDS.test,
    "```",
    "",
    "## What you may change",
    "",
    "Only these files are part of the task. Everything else is harness and is rejected on submission.",
    "",
    ...list(input.editable, "No editable files."),
    "",
    "## Mocks",
    "",
    `Modules outside the task are declared by \`.d.ts\` stubs beside generated \`.js\` runtimes whose values are recording mocks (\`${MOCK_RUNTIME_PATH}\`). Service packages are replaced by mock packages under \`${MOCKS_DIR}/\`. A mock answers any property or call with another mock and records the call; \`mockImplementation(path, fn)\` installs behaviour and \`recordedCalls()\` reads it back. Fixture environment values live in \`${ENV_FILE}\`.`,
    "",
    ...(input.fixtures === 0
      ? []
      : [
          `${input.fixtures} mocked ${input.fixtures === 1 ? "call has" : "calls have"} default behaviour, set with \`fixture(path, fn)\` in their module's runtime; \`mockImplementation\` still overrides it.`,
          "",
        ]),
    ...(input.walkthrough
      ? [
          `\`${SANDBOX_COMMANDS.dev}\` runs \`${RUN_PATH}\`, a walkthrough of the task's main scenario.`,
          "",
        ]
      : []),
    "Mocked modules:",
    "",
    ...list(input.mockedModules, "None."),
    "",
    "Mocked packages:",
    "",
    ...list(input.mockedPackages, "None."),
    "",
    "Installed packages:",
    "",
    ...list(
      input.approvedPackages.map((item) => `${item.name}@${item.version}`),
      "None.",
    ),
    "",
    "Fixture environment:",
    "",
    ...list(input.environment, "None."),
    "",
    "## Import rewrites",
    "",
    ...(input.rewrites.length === 0
      ? ["None."]
      : input.rewrites.map(
          (item) => `- \`${item.file}\`: \`${item.from}\` → \`${item.to}\``,
        )),
    "",
    "## Tests",
    "",
    ...list(input.publicTests, "None."),
    "",
    "Local results help you iterate. Acceptance is decided by the platform's own run of your pushed commit, including tests that are not in this repository.",
  ].join("\n")}\n`;
}

/**
 * Generates the project. Deterministic: the same inputs give the same
 * files in the same order.
 */
export function generateProject(input: ProjectInput): GeneratedProject {
  const toolchain = input.toolchain ?? SANDBOX_TOOLCHAIN;
  const blockers: ProjectBlocker[] = [];
  const rewrites: ImportRewrite[] = [];
  const files = new Map<string, GeneratedFile>();
  const add = (file: GeneratedFile) => {
    if (files.has(file.path))
      blockers.push({
        code: "path_conflict",
        file: file.path,
        detail: `${file.path} is produced twice.`,
      });
    else files.set(file.path, file);
  };
  const aliasedPaths = new Map<string, string>();
  for (const source of input.sources)
    aliasedPaths.set(source.originalPath, source.path);
  for (const stub of input.stubs) aliasedPaths.set(stub.module, stub.path);
  const aliasedOf = (original: string) => aliasedPaths.get(original) ?? null;
  const known = new Set(input.knownSpecifiers.map(packageNameOf));
  for (const dependency of input.dependencies)
    if (dependency.kind === "package") known.add(dependency.name);
  // Every import the slice resolved, inside it or across a cut, by
  // importer and the specifier as written.
  const targetOf = new Map<string, string>();
  for (const edge of [
    ...input.manifest.cuts.outbound,
    ...input.manifest.internalImports,
  ])
    if (edge.specifier !== null)
      targetOf.set(`${edge.from}\n${edge.specifier}`, edge.to);

  // Copied source. Path aliases become relative imports, and relative
  // imports follow a file that aliasing moved, at either end.
  for (const source of input.sources) {
    let text = source.text;
    if (isScript(source.path))
      text = source.text.replace(
        IMPORT_LITERAL,
        (
          whole,
          prefix: string,
          quote: string,
          specifier: string,
          offset: number,
          all: string,
        ) => {
          if (onCommentLine(all, offset)) return whole;
          const relative =
            specifier.startsWith(".") || specifier.startsWith("/");
          if (
            specifier.startsWith("node:") ||
            (!relative && known.has(packageNameOf(specifier)))
          )
            return whole;
          const target = targetOf.get(`${source.originalPath}\n${specifier}`);
          const aliasedTarget = target === undefined ? null : aliasedOf(target);
          if (aliasedTarget === null) {
            // A relative import the graph did not record is left as written
            // for the compiler to judge; a cut module without a stub is
            // already a `mock_unsupported` blocker.
            if (!relative)
              blockers.push({
                code: "import_unrewritable",
                file: source.originalPath,
                detail: `${specifier} is neither a package nor a module the slice resolved.`,
              });
            return whole;
          }
          if (
            relative &&
            source.path === source.originalPath &&
            aliasedTarget === target
          )
            return whole;
          const to = relativeSpecifier(source.path, aliasedTarget);
          if (to === specifier) return whole;
          rewrites.push({ file: source.path, from: specifier, to });
          return `${prefix}${quote}${to}${quote}`;
        },
      );
    else if (/\.[cm]?jsx?$/.test(source.originalPath))
      blockers.push({
        code: "language_unsupported",
        file: source.originalPath,
        detail:
          "The generated project compiles TypeScript in place; a JavaScript source would be overwritten by its own output.",
      });
    add({ path: source.path, text, class: "source", public: true });
  }

  // Fixtures name values the slice mocks, or the project does not build.
  const fixtures = input.fixtures ?? [];
  for (const problem of fixtureProblems(fixtures, input.contract.outbound)) {
    const item =
      problem.fixture === null ? undefined : fixtures[problem.fixture];
    blockers.push({
      code: "fixture_invalid",
      file: item === undefined ? null : item.module,
      detail: problem.detail,
    });
  }

  // Cut modules: declaration stubs beside generated runtimes.
  const mockedModules: string[] = [];
  const stubByModule = new Map(input.stubs.map((stub) => [stub.module, stub]));
  for (const module of input.contract.outbound) {
    const stub = stubByModule.get(module.module);
    if (stub === undefined) {
      blockers.push({
        code: "mock_unsupported",
        file: module.module,
        detail: "The slice produced no declaration stub for this module.",
      });
      continue;
    }
    mockedModules.push(stub.path);
    add({
      path: declarationPath(stub.path),
      text: stub.text,
      class: "stub",
      public: true,
    });
    add({
      path: runtimePath(stub.path),
      text: mockRuntimeFor(
        stub.path,
        module.module,
        module.symbols,
        fixtures.filter((item) => item.module === module.module),
        blockers,
      ),
      class: "mock",
      public: true,
    });
  }
  // Stubs the contract does not list as modules (types a stub imports).
  for (const stub of input.stubs)
    if (!input.contract.outbound.some((m) => m.module === stub.module)) {
      add({
        path: declarationPath(stub.path),
        text: stub.text,
        class: "stub",
        public: true,
      });
      add({
        path: runtimePath(stub.path),
        text: "export {};\n",
        class: "mock",
        public: true,
      });
    }

  // Packages: approved ones install; mocked ones are local packages.
  const namedImports = scanNamedImports(input.sources);
  const mockedPackages: string[] = [];
  const approvedPackages: { name: string; version: string }[] = [];
  const dependencies: Record<string, string> = {};
  for (const dependency of [...input.dependencies].sort((a, b) =>
    compare(a.name, b.name),
  )) {
    if (dependency.kind !== "package") continue;
    if (
      dependency.resolution === "approved-package" &&
      dependency.version !== null
    ) {
      approvedPackages.push({
        name: dependency.name,
        version: dependency.version,
      });
      dependencies[dependency.name] = dependency.version;
    } else if (dependency.resolution === "runtime-mock") {
      mockedPackages.push(dependency.name);
      const dir = `${MOCKS_DIR}/${dependency.name}`;
      dependencies[dependency.name] = `file:${dir}`;
      const names = [...(namedImports.get(dependency.name) ?? [])].sort(
        compare,
      );
      add({
        path: `${dir}/package.json`,
        text: `${JSON.stringify(
          {
            name: dependency.name,
            version: "0.0.0-sandbox",
            private: true,
            type: "module",
            main: "index.js",
            types: "index.d.ts",
          },
          null,
          2,
        )}\n`,
        class: "mock",
        public: true,
      });
      add({
        path: `${dir}/index.js`,
        text: `${[
          `// Mock of the ${dependency.name} package. Values are recording mocks.`,
          `import { createMock } from "${relativeSpecifier(`${dir}/index.js`, MOCK_RUNTIME_PATH)}";`,
          `const mock = createMock(${JSON.stringify(`package:${dependency.name}`)});`,
          "export default mock;",
          ...names.map(
            (name) => `export const ${name} = mock[${JSON.stringify(name)}];`,
          ),
        ].join("\n")}\n`,
        class: "mock",
        public: true,
      });
      add({
        path: `${dir}/index.d.ts`,
        text: `${[
          "declare const mock: any;",
          "export default mock;",
          ...names.map((name) => `export const ${name}: any;`),
        ].join("\n")}\n`,
        class: "mock",
        public: true,
      });
    }
  }

  // Harness.
  add({
    path: MOCK_RUNTIME_PATH,
    text: MOCK_RUNTIME,
    class: "harness",
    public: true,
  });
  add({
    path: `${HARNESS_DIR}/mock.d.ts`,
    text: MOCK_RUNTIME_TYPES,
    class: "harness",
    public: true,
  });
  add({
    path: AMBIENT_PATH,
    text: ambientDeclarations([
      ...approvedPackages.map((p) => p.name),
      ...mockedPackages,
      // Node's modules by their bare names too (`fs`, `fs/promises`).
      ...input.knownSpecifiers
        .filter((specifier) => !specifier.startsWith("node:"))
        .map(packageNameOf),
    ]),
    class: "harness",
    public: true,
  });
  const entries = input.manifest.entryPoints
    .flatMap((entry) =>
      input.sources
        .filter(
          (source) =>
            source.originalPath === entry ||
            source.originalPath.startsWith(`${entry}/`),
        )
        .map((source) => source.path),
    )
    .filter((path, index, all) => isScript(path) && all.indexOf(path) === index)
    .sort(compare);
  const scenario = input.scenario ?? null;
  add({
    path: RUN_PATH,
    text: scenario ?? runScript(entries),
    class: "harness",
    public: true,
  });

  // Tests.
  const publicTests = [
    `${PUBLIC_TESTS_DIR}/interface.test.ts`,
    `${PUBLIC_TESTS_DIR}/spec.test.ts`,
  ];
  add({
    path: publicTests[0] ?? "",
    text: interfaceTests(input.contract.inbound, aliasedOf, entries),
    class: "test-public",
    public: true,
  });
  add({
    path: publicTests[1] ?? "",
    text: specTests(input.spec),
    class: "test-public",
    public: true,
  });
  for (const test of input.acceptanceTests) {
    if (
      !test.path.startsWith(`${PRIVATE_TESTS_DIR}/`) ||
      !test.path.endsWith(".test.ts") ||
      test.path.split("/").some((part) => part === "" || part === "..")
    ) {
      blockers.push({
        code: "test_path_invalid",
        file: test.path,
        detail: `Hidden tests live under ${PRIVATE_TESTS_DIR}/ and end in .test.ts.`,
      });
      continue;
    }
    add({
      path: test.path,
      text: test.text,
      class: "test-private",
      public: false,
    });
  }

  // Configuration.
  const environment = input.manifest.externals.environment.map(
    (item) => item.name,
  );
  add({
    path: "package.json",
    text: `${JSON.stringify(
      {
        name: `sandbox-task-${input.version.versionId.replace(/[^a-z0-9]/gi, "-").toLowerCase()}`,
        version: `${input.version.version}.0.0`,
        private: true,
        type: "module",
        engines: { node: toolchain.nodeRange },
        packageManager: `npm@${toolchain.npm}`,
        scripts: {
          build: "tsc -p tsconfig.json",
          dev: `npm run build && node --env-file=${ENV_FILE} ${runtimePath(RUN_PATH)}`,
          test: `npm run build && node --env-file=${ENV_FILE} --test "${PUBLIC_TESTS_DIR}/**/*.test.js"`,
        },
        dependencies,
        devDependencies: { typescript: toolchain.typescript },
      },
      null,
      2,
    )}\n`,
    class: "config",
    public: true,
  });
  add({
    path: "tsconfig.json",
    text: tsconfigFor(input.compilerOptions),
    class: "config",
    public: true,
  });
  add({
    path: ".nvmrc",
    text: `${toolchain.node}\n`,
    class: "config",
    public: true,
  });
  add({
    path: ".npmrc",
    text: "engine-strict=true\nignore-scripts=true\nfund=false\naudit=false\n",
    class: "config",
    public: true,
  });
  add({
    path: ENV_FILE,
    text: `${[
      "# Fixture values for the environment the task reads. Safe to commit;",
      "# nothing here reaches a real service.",
      ...environment.map(
        (name) =>
          `${name}=sandbox-fixture-${name.toLowerCase().replace(/_/g, "-")}`,
      ),
    ].join("\n")}\n`,
    class: "config",
    public: true,
  });
  // The walkthrough imports the task by relative path; each must land on
  // a generated file once the version's aliases have moved things.
  if (scenario !== null)
    for (const match of scenario.matchAll(IMPORT_LITERAL)) {
      const specifier = match[3] ?? "";
      if (!specifier.startsWith(".") || onCommentLine(scenario, match.index))
        continue;
      const target = joinRelative(HARNESS_DIR, specifier);
      const found =
        target !== null &&
        [target, ...sourceCandidates(target)].some((path) => files.has(path));
      if (!found)
        blockers.push({
          code: "import_unrewritable",
          file: RUN_PATH,
          detail: `${specifier} does not resolve to a file in the project.`,
        });
    }
  const emitted = [...files.values()]
    .filter((file) => isScript(file.path))
    .map((file) => runtimePath(file.path))
    .filter((path) => !files.has(path))
    .sort(compare);
  add({
    path: ".gitignore",
    text: `${["node_modules/", ...emitted].join("\n")}\n`,
    class: "config",
    public: true,
  });
  const editable = input.sources.map((source) => source.path).sort(compare);
  const descriptor: TaskDescriptor = {
    schemaVersion: TASK_DESCRIPTOR_SCHEMA_VERSION,
    sandboxId: input.version.sandboxId,
    versionId: input.version.versionId,
    version: input.version.version,
    title: input.version.title,
    specSummary: input.version.specSummary,
    complexity: input.version.complexity,
    tags: input.version.tags,
    commands: SANDBOX_COMMANDS,
    toolchain,
    editablePaths: editable,
    publicTests,
    testSummary: [
      { label: "public", count: publicTests.length },
      {
        label: "scenarios",
        count: input.spec === null ? 0 : input.spec.scenarios.length,
      },
    ],
  };
  add({
    path: TASK_DESCRIPTOR_PATH,
    text: `${JSON.stringify(descriptor, null, 2)}\n`,
    class: "descriptor",
    public: true,
  });
  add({
    path: "README.md",
    text: readme({
      version: input.version,
      toolchain,
      editable,
      mockedModules: mockedModules.sort(compare),
      mockedPackages,
      approvedPackages,
      environment,
      rewrites,
      publicTests,
      fixtures: fixtures.length,
      walkthrough: scenario !== null,
    }),
    class: "config",
    public: true,
  });
  return {
    files: [...files.values()].sort((a, b) => compare(a.path, b.path)),
    importRewrites: rewrites.sort((a, b) =>
      compare(`${a.file}\n${a.from}`, `${b.file}\n${b.from}`),
    ),
    descriptor,
    publicTests,
    blockers,
  };
}
