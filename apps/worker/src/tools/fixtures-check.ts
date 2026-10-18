/**
 * Whether fixtures and a walkthrough fit the slice they were written for.
 *
 * Each fixture's implementation is assigned, in a generated check file, to
 * the declared type of the call it stands in for, read from the slice's own
 * declaration stubs; the walkthrough is compiled as `sandbox/run.ts` beside
 * the included source. Both use the compiler options, ambient declarations
 * and mock runtime types the generated project builds with, in memory,
 * with nothing installed. Only diagnostics in those two files are reported:
 * the included source is the client's, and the slice already judged it.
 */

import ts from "typescript-compiler";
import {
  CONFINED_FORBIDDEN_NAMES,
  HARNESS_DIR,
  MOCK_RUNTIME_TYPES,
  RUN_PATH,
  ambientDeclarations,
  fixtureMockPath,
  fixtureProblems,
  packageNameOf,
  projectCompilerOptions,
  relativeSpecifier,
  scenarioProblems,
} from "sandbox-factory";
import type { BoundaryContract, SandboxFixture } from "sandbox-factory";
import { compileFixture } from "./slice/fixture.js";
import { NODE_BUILTINS, declarationPathFor } from "./slice/typescript.js";

export const FIXTURE_CHECK_PATH = `${HARNESS_DIR}/fixtures.check.ts`;
const PROBLEMS_MAX = 40;

export interface FixtureCheckInput {
  readonly root: string;
  /** The source's own compiler options, as the build reads them. */
  readonly sourceOptions: Record<string, unknown> | undefined;
  readonly included: readonly { path: string; text: string }[];
  readonly stubs: readonly { module: string; text: string }[];
  /** Package names the slice imports. */
  readonly packages: readonly string[];
  readonly contract: Pick<BoundaryContract, "outbound">;
  readonly fixtures: readonly SandboxFixture[];
  readonly scenario: string;
}
export interface FixtureCheck {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/**
 * Whether a fixture's implementation is exactly one function expression.
 * It is spliced into a generated runtime, so text that closes the call and
 * adds statements of its own must not get past the shape check.
 */
export function isSingleFunctionExpression(text: string): boolean {
  const file = ts.createSourceFile(
    "fixture.ts",
    `(${text}\n);`,
    ts.ScriptTarget.Latest,
    true,
  );
  const [statement, ...rest] = file.statements;
  if (
    rest.length > 0 ||
    statement === undefined ||
    !ts.isExpressionStatement(statement) ||
    !ts.isParenthesizedExpression(statement.expression)
  )
    return false;
  const inner = statement.expression.expression;
  return ts.isArrowFunction(inner) || ts.isFunctionExpression(inner);
}

const FORBIDDEN = new Set(CONFINED_FORBIDDEN_NAMES);
// A template is not a literal key, as the token check reads it.
const literalKey = (node: ts.Node) =>
  (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) &&
  !FORBIDDEN.has(node.text);

/**
 * Whether a string names a property where it stands: an object's, class's
 * or type's member, a destructured key, an import or export specifier.
 */
function quotedName(node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral) {
  const parent = node.parent;
  return (
    ("name" in parent && parent.name === node) ||
    ("propertyName" in parent && parent.propertyName === node)
  );
}

/**
 * The fixture rules (`confinedCodeProblems` in core) read on the parsed
 * code: forbidden names wherever they stand, quoted keys and escapes
 * included; `Date` only as `new Date(value)`; computed members and keys only as literals; no
 * `with`, `import()` or `import.meta`; and, for a walkthrough, only static
 * imports of relative paths. The core check reads tokens and is the gate
 * every build applies; this one is the parser's view of the same rules.
 */
export function confinedAstProblems(
  text: string,
  kind: "fixture" | "walkthrough",
): string[] {
  const file = ts.createSourceFile(
    kind === "fixture" ? "fixture.ts" : "run.ts",
    kind === "fixture" ? `(${text}\n);` : text,
    ts.ScriptTarget.Latest,
    true,
  );
  const problems = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      const name = ts.idText(node);
      if (FORBIDDEN.has(name)) problems.add(`\`${name}\` is not allowed.`);
      // A value, never none: not `()` and not a spread that may be empty.
      const value =
        ts.isNewExpression(node.parent) && node.parent.expression === node
          ? node.parent.arguments?.[0]
          : undefined;
      if (name === "Date" && (value === undefined || ts.isSpreadElement(value)))
        problems.add(
          "`Date` is allowed only as `new Date(value)`, never the current time.",
        );
    } else if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node)
    ) {
      const specifier =
        ts.isImportEqualsDeclaration(node) ||
        node.moduleSpecifier === undefined ||
        !ts.isStringLiteral(node.moduleSpecifier)
          ? null
          : node.moduleSpecifier.text;
      if (kind === "fixture") problems.add("`import` is not allowed.");
      else if (
        specifier === null
          ? !ts.isExportDeclaration(node)
          : !specifier.startsWith("./") && !specifier.startsWith("../")
      )
        problems.add(
          `${specifier ?? "That import"} is not a relative import; the walkthrough imports only the project's own files.`,
        );
    } else if (
      (ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword) ||
      (ts.isMetaProperty(node) &&
        node.keywordToken === ts.SyntaxKind.ImportKeyword)
    )
      problems.add("`import` is not allowed.");
    else if (node.kind === ts.SyntaxKind.WithStatement)
      problems.add("`with` is not allowed.");
    else if (
      (ts.isElementAccessExpression(node) &&
        !literalKey(node.argumentExpression)) ||
      (ts.isComputedPropertyName(node) && !literalKey(node.expression))
    )
      problems.add(
        'A computed member or key must be one string or number literal, such as `rows[0]` or `item["id"]`.',
      );
    else if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      FORBIDDEN.has(node.text) &&
      quotedName(node)
    )
      problems.add(`\`${node.text}\` is not allowed.`);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...problems];
}

const indexed = (names: readonly string[]) =>
  names.map((name) => `[${JSON.stringify(name)}]`).join("");

/**
 * The check file: one type import per module, then each implementation
 * assigned to the type of the call it gives behaviour to. `lines[i]` is
 * the first and last line of fixture `i`, for mapping diagnostics back.
 */
export function fixtureCheckSource(fixtures: readonly SandboxFixture[]): {
  text: string;
  lines: readonly (readonly [number, number])[];
} {
  const modules = [...new Set(fixtures.map((fixture) => fixture.module))];
  const alias = new Map(
    modules.map((module, index) => [module, `__m${index}`]),
  );
  const out: string[] = [
    "// Each fixture against the declaration it stands in for.",
    ...modules.map(
      (module) =>
        `import type * as ${alias.get(module) ?? ""} from ${JSON.stringify(relativeSpecifier(FIXTURE_CHECK_PATH, module))};`,
    ),
  ];
  const lines: (readonly [number, number])[] = [];
  for (const [index, fixture] of fixtures.entries()) {
    const target = `typeof ${alias.get(fixture.module) ?? ""}${indexed([
      fixture.symbol,
      ...(fixture.member === null ? [] : fixture.member.split(".")),
    ])}`;
    const type =
      fixture.call === "construct"
        ? `(...args: ConstructorParameters<${target}>) => Partial<InstanceType<${target}>>`
        : target;
    const start = out.length + 1;
    out.push(`export const __f${index}: ${type} = (`);
    out.push(...fixture.implementation.split("\n"));
    out.push(");");
    lines.push([start, out.length]);
  }
  return { text: `${out.join("\n")}\n`, lines };
}

export function checkFixtures(input: FixtureCheckInput): FixtureCheck {
  const problems = [
    ...fixtureProblems(input.fixtures, input.contract.outbound).map(
      (problem) =>
        problem.fixture === null
          ? problem.detail
          : `Fixture ${problem.fixture}: ${problem.detail}`,
    ),
    ...input.fixtures.flatMap((fixture, index) =>
      isSingleFunctionExpression(fixture.implementation)
        ? []
        : [
            `Fixture ${index}: The implementation must be exactly one function expression.`,
          ],
    ),
    ...input.fixtures.flatMap((fixture, index) =>
      confinedAstProblems(fixture.implementation, "fixture").map(
        (problem) => `Fixture ${index}: ${problem}`,
      ),
    ),
    ...scenarioProblems(input.scenario).map(
      (problem) => `Walkthrough: ${problem.detail}`,
    ),
    ...confinedAstProblems(input.scenario, "walkthrough").map(
      (problem) => `Walkthrough: ${problem}`,
    ),
  ].filter((problem, index, all) => all.indexOf(problem) === index);
  if (problems.length > 0)
    return { ok: false, problems: problems.slice(0, PROBLEMS_MAX) };
  const files = new Map<string, string>();
  for (const file of input.included) files.set(file.path, file.text);
  for (const stub of input.stubs)
    files.set(declarationPathFor(stub.module), stub.text);
  // The generated project is an ES module package.
  files.set("package.json", '{ "type": "module" }\n');
  files.set(
    `${HARNESS_DIR}/ambient.d.ts`,
    ambientDeclarations([
      ...input.packages,
      ...NODE_BUILTINS.filter((name) => !name.startsWith("node:")).map(
        packageNameOf,
      ),
    ]),
  );
  files.set(`${HARNESS_DIR}/mock.d.ts`, MOCK_RUNTIME_TYPES);
  files.set(RUN_PATH, input.scenario);
  const check = fixtureCheckSource(input.fixtures);
  files.set(FIXTURE_CHECK_PATH, check.text);
  const options = ts.convertCompilerOptionsFromJson(
    projectCompilerOptions(input.sourceOptions),
    input.root,
  ).options;
  const result = compileFixture({
    root: input.root,
    files,
    compilerOptions: options,
    shimmedPackages: input.packages,
  });
  for (const diagnostic of result.diagnostics) {
    const line = diagnostic.line ?? 0;
    if (diagnostic.file === FIXTURE_CHECK_PATH) {
      const index = check.lines.findIndex(
        ([start, end]) => line >= start && line <= end,
      );
      const fixture = input.fixtures[index];
      problems.push(
        fixture === undefined
          ? `Fixture imports: ${diagnostic.code} ${diagnostic.message}`
          : `Fixture ${index} (${fixtureMockPath(fixture)}): ${diagnostic.code} ${diagnostic.message}`,
      );
    } else if (diagnostic.file === RUN_PATH)
      problems.push(
        `Walkthrough line ${line}: ${diagnostic.code} ${diagnostic.message}`,
      );
  }
  return {
    ok: problems.length === 0,
    problems: problems.slice(0, PROBLEMS_MAX),
  };
}
