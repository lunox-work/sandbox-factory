/**
 * Fixtures: believable behaviour for a slice's mocked seams, and the
 * walkthrough `npm run dev` runs.
 *
 * A fixture is the default behaviour of one mock path in the generated
 * project: a call or a construction of an exported symbol of a cut module,
 * or of a member reached through it. Its implementation is one JavaScript
 * function expression with no imports, so it runs inside the generated
 * runtime as written. The scenario is TypeScript for `sandbox/run.ts`,
 * written against the repository's own layout and aliased with the version
 * like the copied source. Both are generated files: copied source is never
 * rewritten for them. Pure shapes and rules; the agent and the compile
 * check live in the worker.
 */

import { isFunctionExpressionText } from "./expression.js";
import type { AgentUsage } from "../analysis.js";
import type { BoundaryModule } from "../slice/manifest.js";

export const FIXTURE_SET_SCHEMA_VERSION = 1;
export const FIXTURE_CALLS = ["call", "construct"] as const;
export type FixtureCall = (typeof FIXTURE_CALLS)[number];

export const FIXTURE_LIMITS = {
  fixtures: 100,
  implementationChars: 4_000,
  scenarioChars: 20_000,
  reasonChars: 500,
  summaryChars: 2_000,
  memberDepth: 4,
} as const;

export interface SandboxFixture {
  /** The cut module's repository path, as the boundary contract names it. */
  readonly module: string;
  /** An exported value of that module; `default` for a default export. */
  readonly symbol: string;
  /** A dotted member path under the symbol, such as `users.findById`. */
  readonly member: string | null;
  readonly call: FixtureCall;
  /** One function expression, such as `async (id) => ({ id, name: "Ada" })`. */
  readonly implementation: string;
  readonly reason: string;
}
/** The agent's answer, before the worker checks and records it. */
export interface FixtureSubmission {
  readonly fixtures: readonly SandboxFixture[];
  /** TypeScript for `sandbox/run.ts`, relative imports from `sandbox/`. */
  readonly scenario: string;
  readonly summary: string;
}
/** `fixture-set.json`. */
export interface FixtureSet extends FixtureSubmission {
  readonly schemaVersion: typeof FIXTURE_SET_SCHEMA_VERSION;
  readonly toolVersion: string;
  readonly sliceRunId: string;
  readonly sourceSnapshotId: string;
  readonly sourceCommitSha: string;
  readonly proposalId: string;
  readonly specRevision: number;
  readonly usage: AgentUsage;
}
/** What a sandbox version keeps in its private transform. */
export interface VersionFixtures {
  /** The fixtures run they were copied from; null when written by hand. */
  readonly fixtureRunId: string | null;
  readonly fixtures: readonly SandboxFixture[];
  readonly scenario: string | null;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const IMPORTING = /\bimport\s*[({'"*\w]|\brequire\s*\(/;
const TYPE_KINDS: readonly string[] = ["interface", "type"];

/**
 * The name the generated mock runtime gives a fixture's call: the module's
 * mock, then the symbol and member as properties, with `new ` in front of
 * a construction. See `sandbox/mock.js`.
 */
export function fixtureMockPath(
  fixture: Pick<SandboxFixture, "module" | "symbol" | "member" | "call">,
): string {
  const name = `module:${fixture.module}.${fixture.symbol}${fixture.member === null ? "" : `.${fixture.member}`}`;
  return fixture.call === "construct" ? `new ${name}` : name;
}

export interface FixtureProblem {
  /** Index into the fixture list; null for the scenario. */
  readonly fixture: number | null;
  readonly detail: string;
}

/**
 * Why fixtures cannot be used with a slice: each must name a value the
 * slice actually mocks, be a self-contained function expression, and give
 * its mock path behaviour once.
 */
export function fixtureProblems(
  fixtures: readonly SandboxFixture[],
  outbound: readonly BoundaryModule[],
): FixtureProblem[] {
  const problems: FixtureProblem[] = [];
  if (fixtures.length > FIXTURE_LIMITS.fixtures)
    problems.push({
      fixture: null,
      detail: `At most ${FIXTURE_LIMITS.fixtures} fixtures are kept.`,
    });
  const modules = new Map(outbound.map((module) => [module.module, module]));
  const seen = new Set<string>();
  for (const [index, fixture] of fixtures.entries()) {
    const report = (detail: string) =>
      problems.push({ fixture: index, detail });
    const module = modules.get(fixture.module);
    const symbol = module?.symbols.find((s) => s.name === fixture.symbol);
    if (module === undefined)
      report(`${fixture.module} is not a module the slice mocks.`);
    else if (symbol === undefined)
      report(`${fixture.module} exports no ${fixture.symbol} the slice uses.`);
    else if (TYPE_KINDS.includes(symbol.kind))
      report(`${fixture.symbol} is a type; it has no runtime behaviour.`);
    if (fixture.member !== null) {
      const parts = fixture.member.split(".");
      if (
        parts.length > FIXTURE_LIMITS.memberDepth ||
        parts.some((part) => !IDENTIFIER.test(part))
      )
        report(
          `${fixture.member} must be up to ${FIXTURE_LIMITS.memberDepth} dotted identifiers.`,
        );
    }
    if (fixture.implementation.length > FIXTURE_LIMITS.implementationChars)
      report(
        `The implementation is longer than ${FIXTURE_LIMITS.implementationChars} characters.`,
      );
    // Read as code, not matched by its start: it is spliced into the
    // public runtime as it stands (`isFunctionExpressionText`).
    if (!isFunctionExpressionText(fixture.implementation))
      report("The implementation must be one function expression.");
    if (IMPORTING.test(fixture.implementation))
      report("The implementation must not import anything.");
    const path = fixtureMockPath(fixture);
    if (seen.has(path)) report(`${path} is given behaviour twice.`);
    seen.add(path);
  }
  return problems;
}

/** Why a scenario cannot be the walkthrough. */
export function scenarioProblems(scenario: string): FixtureProblem[] {
  if (scenario.trim() === "")
    return [{ fixture: null, detail: "The scenario is empty." }];
  if (scenario.length > FIXTURE_LIMITS.scenarioChars)
    return [
      {
        fixture: null,
        detail: `The scenario is longer than ${FIXTURE_LIMITS.scenarioChars} characters.`,
      },
    ];
  return [];
}
