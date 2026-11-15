/**
 * An invented pricing corpus: bounty shapes with an expected band each, to
 * read a change to the rubric's bands or points against.
 *
 * Every ticket is made up. Its spec is written the way the drafting prompt
 * writes one (every kind that applies, a weight per scenario, open questions
 * where the ticket is silent) and its code the way a profile measures it.
 * The expected band is engineering judgement of the work, not ground truth:
 * read the table it produces as "where the rubric disagrees with a
 * reviewer", and argue with the rationale before arguing with the rubric.
 *
 * The rough scale the judgements use, for an experienced contributor in a
 * sandbox: XS under an hour, XS+ an hour or two, S half a day, S+ most of a
 * day, M a day, M+ a day and a half, L two to three days, L+ three to four,
 * XL a week or more. It follows the sizing prompt's words (XS a copy edit,
 * S a localized change with obvious validation, M one module, L
 * cross-module, API or schema work, XL worth splitting).
 *
 * `bounds` are the only assertions: gross mistakes a band change must never
 * make, such as a copy change priced above S. Everything else is a report.
 */

import {
  COMPLEXITY_PROFILE_VERSION,
  SCENARIO_KINDS,
  type ComplexityProfile,
  type MeasuredRepository,
  type PricedComplexity,
  type Scenario,
  type ScenarioKind,
  type ScenarioStep,
  type ScenarioWeight,
  type SpecDraft,
  type StubCoverage,
} from "../../src/index.js";

/**
 * A scenario as kind, weight and steps, the steps one letter each: G Given,
 * W When, T Then, A And, B But. `["unhappy", "moderate", "GWTA"]` is an
 * unhappy-path scenario of moderate weight whose test checks two outcomes.
 */
export type ScenarioShape = readonly [ScenarioKind, ScenarioWeight, string];

/** One repository's code as a profile measures it. */
export interface CodeShape {
  readonly kb: number;
  readonly files: number;
  /** Modules the change lands in. */
  readonly touched: number;
  /** Of those, how many have no test file. */
  readonly untested?: number;
  readonly services?: readonly string[];
  readonly seams?: number;
  readonly ci?: boolean;
  readonly migrations?: boolean;
  /** Whether the scope agent named an analogous file to follow. */
  readonly pattern?: boolean;
  readonly stubs?: StubCoverage;
  readonly blockers?: number;
}

export interface CorpusTicket {
  /** Stable, kebab-case. */
  readonly id: string;
  /** What the ticket asks for, in a line. Invented. */
  readonly title: string;
  /** The band a reviewer would price the work at: a judgement. */
  readonly expected: PricedComplexity;
  /** Why that band, in a line. */
  readonly rationale: string;
  readonly scenarios: readonly ScenarioShape[];
  readonly openQuestions: number;
  /** Every repository the work touches; empty for a spec-only bounty. */
  readonly code: readonly CodeShape[];
  /** Gross bounds the rubric must hold, spec-only and code-informed alike. */
  readonly bounds?: {
    readonly atMost?: PricedComplexity;
    readonly atLeast?: PricedComplexity;
  };
}

const KEYWORDS: Readonly<Record<string, ScenarioStep["keyword"]>> = {
  G: "Given",
  W: "When",
  T: "Then",
  A: "And",
  B: "But",
};

export function specOf(ticket: CorpusTicket): SpecDraft {
  return {
    feature: ticket.title,
    background: [],
    scenarios: ticket.scenarios.map(
      ([kind, weight, steps], index): Scenario => ({
        id: `s${index + 1}`,
        kind,
        title: `${kind} ${index + 1}`,
        steps: [...steps].map((letter) => {
          const keyword = KEYWORDS[letter];
          if (keyword === undefined)
            throw new Error(`${ticket.id}: unknown step letter ${letter}`);
          return { keyword, text: "a step" };
        }),
        origin: "draft",
        weight,
      }),
    ),
    openQuestions: Array.from(
      { length: ticket.openQuestions },
      (_, index) => `question ${index + 1}?`,
    ),
    assumptions: [],
  };
}

/** Module names are placeholders: the rubric counts them, never reads them. */
function profileOf(spec: SpecDraft, code: CodeShape): ComplexityProfile {
  const touched = Array.from(
    { length: code.touched },
    (_, index) => `src/m${index + 1}`,
  );
  const kinds = Object.fromEntries(
    SCENARIO_KINDS.map((kind) => [
      kind,
      spec.scenarios.filter((scenario) => scenario.kind === kind).length,
    ]),
  ) as Record<ScenarioKind, number>;
  return {
    version: COMPLEXITY_PROFILE_VERSION,
    slice: {
      files: code.files,
      bytes: code.kb * 1024,
      modules: touched,
      stubCoverage: code.stubs ?? "full",
      blockers: code.blockers ?? 0,
      workBlockers: code.blockers ?? 0,
      ready: true,
    },
    touchedModules: touched,
    externals: {
      services: [...(code.services ?? [])].sort(),
      environment: 0,
      seams: code.seams ?? 0,
    },
    spec: {
      scenarios: spec.scenarios.length,
      kinds,
      openQuestions: spec.openQuestions.length,
      assumptions: spec.assumptions.length,
    },
    tests: {
      files: code.touched - (code.untested ?? 0),
      untestedModules: touched.slice(code.touched - (code.untested ?? 0)),
    },
    pattern:
      code.pattern === true
        ? { path: "src/m1/example.ts", reason: "an analogous change" }
        : null,
    nonFunctional: {
      scenarios: kinds["non-functional"],
      migrations: code.migrations ?? false,
      ci: code.ci ?? false,
    },
    risks: [],
  };
}

export function repositoriesOf(ticket: CorpusTicket): MeasuredRepository[] {
  const spec = specOf(ticket);
  return ticket.code.map((code, index) => ({
    repository: `example/repo-${index + 1}`,
    profile: profileOf(spec, code),
  }));
}

/** A tidy repository: tests where the change lands, CI, a pattern. */
const tidy = { ci: true, pattern: true } as const;

export const PRICING_CORPUS: readonly CorpusTicket[] = [
  {
    id: "copy-typo",
    title: "Fix a typo in the checkout button label",
    expected: "XS",
    rationale: "One string in one component, an existing snapshot test.",
    scenarios: [
      ["happy", "light", "GWT"],
      ["non-functional", "covered", "GWT"],
    ],
    openQuestions: 0,
    code: [{ kb: 6, files: 2, touched: 1, ...tidy }],
    bounds: { atMost: "S" },
  },
  {
    id: "copy-error-messages",
    title: "Reword three sign-in error messages to the new tone guide",
    expected: "XS+",
    rationale: "Three strings, each with its own path to assert; no logic.",
    scenarios: [
      ["unhappy", "light", "GWT"],
      ["unhappy", "light", "GWT"],
      ["unhappy", "light", "GWT"],
    ],
    openQuestions: 1,
    code: [{ kb: 20, files: 3, touched: 1, ...tidy }],
    bounds: { atMost: "S" },
  },
  {
    id: "copy-tooltip",
    title: "Explain a disabled export button with a tooltip",
    expected: "XS+",
    rationale: "Copy plus one condition, in a web component with mocks.",
    scenarios: [
      ["happy", "light", "GWTA"],
      ["permission", "light", "GWT"],
      ["non-functional", "light", "GWT"],
    ],
    openQuestions: 0,
    code: [{ kb: 14, files: 4, touched: 1, seams: 2, ...tidy }],
    bounds: { atMost: "S" },
  },
  {
    id: "default-sort",
    title: "Sort a list by last updated instead of created",
    expected: "XS",
    rationale: "A default changes; ties fall out of the existing query.",
    scenarios: [
      ["happy", "light", "GWT"],
      ["boundary", "covered", "GWTA"],
    ],
    openQuestions: 0,
    code: [{ kb: 10, files: 2, touched: 1, ...tidy }],
  },
  {
    id: "flag-cleanup",
    title: "Remove a fully rolled-out feature flag and its dead branch",
    expected: "XS+",
    rationale: "Deletion in three call sites, existing tests prove it.",
    scenarios: [
      ["happy", "light", "GWT"],
      ["non-functional", "covered", "GWT"],
    ],
    openQuestions: 0,
    code: [{ kb: 40, files: 6, touched: 3, ...tidy }],
  },
  {
    id: "config-timeout",
    title: "Make the session timeout configurable, with a default",
    expected: "XS+",
    rationale: "One setting read in one place, one fallback path.",
    scenarios: [
      ["happy", "light", "GWT"],
      ["boundary", "moderate", "GWTA"],
      ["boundary", "covered", "GWT"],
    ],
    openQuestions: 1,
    code: [{ kb: 12, files: 3, touched: 1, ...tidy }],
  },
  {
    id: "health-version",
    title: "Add a public endpoint that returns the build version",
    expected: "XS+",
    rationale: "A read-only route beside others like it.",
    scenarios: [
      ["happy", "light", "GWTA"],
      ["permission", "covered", "GWT"],
    ],
    openQuestions: 0,
    code: [{ kb: 10, files: 3, touched: 1, ...tidy }],
  },
  {
    id: "pagination-off-by-one",
    title: "Stop the last item repeating on the next page",
    expected: "XS+",
    rationale: "An off-by-one in one query; the boundary test is the work.",
    scenarios: [
      ["happy", "light", "GWT"],
      ["boundary", "moderate", "GWTA"],
      ["boundary", "light", "GWT"],
    ],
    openQuestions: 0,
    code: [{ kb: 18, files: 3, touched: 1, ...tidy }],
  },
  {
    id: "dashboard-count",
    title: "Show a tickets-closed-this-week card from an existing endpoint",
    expected: "XS+",
    rationale: "A card beside identical ones; the data already exists.",
    scenarios: [
      ["happy", "light", "GWT"],
      ["boundary", "light", "GWT"],
      ["non-functional", "light", "GWT"],
    ],
    openQuestions: 1,
    code: [{ kb: 45, files: 9, touched: 1, seams: 6, ...tidy }],
  },
  {
    id: "settings-notes",
    title: "Add a notes field with a 500-character limit to settings",
    expected: "S",
    rationale: "A localized change with obvious validation, no migration.",
    scenarios: [
      ["happy", "light", "GWT"],
      ["boundary", "moderate", "GWTA"],
      ["boundary", "covered", "GWT"],
    ],
    openQuestions: 0,
    code: [{ kb: 30, files: 5, touched: 1, ...tidy }],
  },
  {
    id: "dependency-major",
    title: "Upgrade the date library across a breaking major version",
    expected: "S",
    rationale: "Two call sites to port, behaviour pinned by existing tests.",
    scenarios: [
      ["happy", "light", "GWT"],
      ["boundary", "light", "GWT"],
    ],
    openQuestions: 0,
    code: [{ kb: 30, files: 5, touched: 2, ...tidy }],
  },
  {
    id: "modal-focus",
    title: "Trap focus in modals and close them on Escape",
    expected: "S",
    rationale: "One shared component, keyboard tests to write.",
    scenarios: [
      ["happy", "moderate", "GWTA"],
      ["happy", "light", "GWT"],
      ["boundary", "light", "GWT"],
      ["non-functional", "light", "GWT"],
    ],
    openQuestions: 0,
    code: [{ kb: 35, files: 8, touched: 1, seams: 5, ...tidy }],
  },
  {
    id: "session-cleanup-job",
    title: "Delete expired sessions in a nightly job",
    expected: "S",
    rationale: "A job beside another like it; one query, one edge.",
    scenarios: [
      ["happy", "moderate", "GWT"],
      ["boundary", "light", "GWT"],
      ["recovery", "light", "GWT"],
    ],
    openQuestions: 1,
    code: [{ kb: 25, files: 4, touched: 1, services: ["postgres"], ...tidy }],
  },
  {
    id: "phone-field",
    title: "Add an optional phone number to the profile, validated",
    expected: "S+",
    rationale: "Form and API change plus a column, each small.",
    scenarios: [
      ["happy", "moderate", "GWTA"],
      ["unhappy", "moderate", "GWTA"],
      ["boundary", "light", "GWT"],
      ["boundary", "light", "GWT"],
      ["non-functional", "light", "GWT"],
    ],
    openQuestions: 1,
    code: [
      {
        kb: 60,
        files: 9,
        touched: 2,
        seams: 3,
        migrations: true,
        ...tidy,
      },
    ],
  },
  {
    id: "status-filter",
    title: "Filter the issues list by status, kept in the URL",
    expected: "S+",
    rationale: "A dropdown, a query parameter and a where clause.",
    scenarios: [
      ["happy", "moderate", "GWTA"],
      ["boundary", "light", "GWT"],
      ["boundary", "light", "GWT"],
      ["non-functional", "light", "GWT"],
    ],
    openQuestions: 0,
    code: [{ kb: 70, files: 11, touched: 2, seams: 4, ...tidy }],
  },
  {
    id: "trial-ending-email",
    title: "Email users three days before their trial ends",
    expected: "S+",
    rationale: "A template and a condition in an existing daily job.",
    scenarios: [
      ["happy", "moderate", "GWTA"],
      ["boundary", "light", "GWT"],
      ["unhappy", "light", "GWT"],
      ["non-functional", "covered", "GWT"],
    ],
    openQuestions: 1,
    code: [
      {
        kb: 60,
        files: 8,
        touched: 2,
        services: ["email"],
        ...tidy,
      },
    ],
  },
  {
    id: "report-export-endpoint",
    title: "Export a report as CSV from a new member-only endpoint",
    expected: "M",
    rationale: "A new route with auth, streaming and an empty edge.",
    scenarios: [
      ["happy", "moderate", "GWTA"],
      ["permission", "moderate", "GWT"],
      ["permission", "light", "GWT"],
      ["unhappy", "light", "GWT"],
      ["boundary", "light", "GWTA"],
      ["non-functional", "moderate", "GWT"],
    ],
    openQuestions: 2,
    code: [
      {
        kb: 90,
        files: 14,
        touched: 2,
        seams: 3,
        services: ["postgres"],
        ...tidy,
      },
    ],
  },
  {
    id: "login-rate-limit",
    title: "Rate-limit sign-in attempts per address and account",
    expected: "M",
    rationale: "Atomic counting in a shared store, a fail-open path.",
    scenarios: [
      ["happy", "moderate", "GWTA"],
      ["boundary", "light", "GWT"],
      ["concurrency", "moderate", "GWT"],
      ["non-functional", "covered", "GWT"],
      ["unhappy", "light", "GWTA"],
    ],
    openQuestions: 2,
    code: [
      {
        kb: 80,
        files: 10,
        touched: 2,
        seams: 2,
        services: ["redis"],
        ci: true,
      },
    ],
  },
  {
    id: "german-locale",
    title: "Add a German locale; translations are supplied",
    expected: "M",
    rationale: "Mechanical wiring across many modules, little logic.",
    scenarios: [
      ["happy", "moderate", "GWTA"],
      ["boundary", "light", "GWT"],
      ["non-functional", "light", "GWT"],
    ],
    openQuestions: 1,
    code: [{ kb: 300, files: 40, touched: 4, untested: 2, seams: 4, ...tidy }],
  },
  {
    id: "double-charge",
    title: "Stop a double-submitted payment form charging twice",
    expected: "M+",
    rationale: "A concurrency fix across client and server with a provider.",
    scenarios: [
      ["concurrency", "heavy", "GWTA"],
      ["happy", "light", "GWT"],
      ["unhappy", "moderate", "GWTA"],
      ["non-functional", "light", "GWT"],
    ],
    openQuestions: 2,
    code: [
      {
        kb: 100,
        files: 15,
        touched: 2,
        seams: 3,
        services: ["payments"],
        ci: true,
      },
    ],
  },
  {
    id: "date-format-refactor",
    title: "Replace ad-hoc date formatting in six modules with one helper",
    expected: "L",
    rationale: "Behaviour unchanged, but six module boundaries to cross.",
    scenarios: [
      ["happy", "moderate", "GWTA"],
      ["boundary", "light", "GWT"],
      ["non-functional", "light", "GWT"],
    ],
    openQuestions: 1,
    code: [{ kb: 220, files: 30, touched: 6, untested: 2, seams: 4, ...tidy }],
    bounds: { atLeast: "XS+" },
  },
  {
    id: "webhook-retry-job",
    title: "Deliver webhooks from a job with backoff and a dead letter",
    expected: "L",
    rationale: "A new mechanism: job, retry policy, table, no prior art.",
    scenarios: [
      ["happy", "heavy", "GWTA"],
      ["recovery", "heavy", "GWTAA"],
      ["recovery", "moderate", "GWTA"],
      ["concurrency", "moderate", "GWTA"],
      ["unhappy", "light", "GWT"],
      ["boundary", "light", "GWT"],
    ],
    openQuestions: 2,
    code: [
      {
        kb: 140,
        files: 18,
        touched: 2,
        untested: 1,
        seams: 4,
        services: ["http", "postgres"],
        migrations: true,
        ci: true,
      },
    ],
    bounds: { atLeast: "S" },
  },
  {
    id: "gitlab-sign-in",
    title: "Add sign-in with a second OAuth provider beside the first",
    expected: "L",
    rationale: "Auth across three modules; the first provider is a pattern.",
    scenarios: [
      ["happy", "heavy", "GWTAA"],
      ["happy", "moderate", "GWTA"],
      ["unhappy", "moderate", "GWTA"],
      ["unhappy", "light", "GWT"],
      ["permission", "light", "GWT"],
      ["non-functional", "moderate", "GWT"],
    ],
    openQuestions: 2,
    code: [
      {
        kb: 150,
        files: 20,
        touched: 3,
        seams: 4,
        services: ["oauth"],
        ...tidy,
      },
    ],
  },
  {
    id: "role-audit-log",
    title: "Record every role change in an audit log admins can read",
    expected: "L",
    rationale: "New table, new module, admin view and permission checks.",
    scenarios: [
      ["happy", "moderate", "GWTA"],
      ["happy", "moderate", "GWT"],
      ["permission", "moderate", "GWT"],
      ["boundary", "light", "GWT"],
      ["non-functional", "light", "GWT"],
    ],
    openQuestions: 1,
    code: [
      {
        kb: 120,
        files: 16,
        touched: 3,
        untested: 1,
        seams: 3,
        services: ["postgres"],
        migrations: true,
        ...tidy,
      },
    ],
    bounds: { atLeast: "S" },
  },
  {
    id: "event-field-two-repos",
    title: "Publish a new event field in one service, store it in another",
    expected: "L",
    rationale: "Two repositories that must agree, one with a migration.",
    scenarios: [
      ["happy", "moderate", "GWT"],
      ["happy", "moderate", "GWTA"],
      ["unhappy", "light", "GWT"],
      ["boundary", "covered", "GWT"],
    ],
    openQuestions: 1,
    code: [
      { kb: 40, files: 6, touched: 1, services: ["queue"], ...tidy },
      {
        kb: 50,
        files: 7,
        touched: 1,
        services: ["queue"],
        migrations: true,
        ...tidy,
      },
    ],
    bounds: { atLeast: "S" },
  },
  {
    id: "csv-user-import",
    title: "Bulk-import users from a CSV with a per-row error report",
    expected: "L",
    rationale: "Upload, parsing, batching and partial failure, three modules.",
    scenarios: [
      ["happy", "heavy", "GWTAA"],
      ["unhappy", "moderate", "GWTA"],
      ["boundary", "moderate", "GWT"],
      ["boundary", "light", "GWT"],
      ["unhappy", "moderate", "GWTA"],
      ["permission", "light", "GWT"],
      ["recovery", "moderate", "GWT"],
    ],
    openQuestions: 3,
    code: [
      {
        kb: 160,
        files: 22,
        touched: 3,
        untested: 1,
        seams: 4,
        services: ["object-storage", "postgres"],
        ci: true,
      },
    ],
  },
  {
    id: "name-split-migration",
    title: "Split a name column in two and backfill millions of rows",
    expected: "L+",
    rationale: "A resumable backfill without locks, across three modules.",
    scenarios: [
      ["happy", "heavy", "GWTAA"],
      ["boundary", "moderate", "GWTA"],
      ["boundary", "moderate", "GWT"],
      ["recovery", "heavy", "GWTA"],
      ["non-functional", "moderate", "GWT"],
      ["unhappy", "light", "GWT"],
    ],
    openQuestions: 3,
    code: [
      {
        kb: 180,
        files: 24,
        touched: 3,
        untested: 1,
        seams: 2,
        services: ["postgres"],
        migrations: true,
        ci: true,
      },
    ],
    bounds: { atLeast: "S" },
  },
  {
    id: "payout-provider",
    title: "Integrate a payout provider with webhooks and reconciliation",
    expected: "XL",
    rationale: "A new integration with idempotency, recovery and a migration.",
    scenarios: [
      ["happy", "heavy", "GWTAA"],
      ["recovery", "heavy", "GWTA"],
      ["concurrency", "heavy", "GWTA"],
      ["unhappy", "moderate", "GWTA"],
      ["unhappy", "moderate", "GWT"],
      ["boundary", "moderate", "GWT"],
      ["non-functional", "moderate", "GWT"],
      ["recovery", "moderate", "GWTA"],
    ],
    openQuestions: 4,
    code: [
      {
        kb: 400,
        files: 50,
        touched: 4,
        untested: 1,
        seams: 4,
        services: ["payments", "postgres", "queue"],
        migrations: true,
        stubs: "partial",
        blockers: 1,
        ci: true,
      },
    ],
    bounds: { atLeast: "M" },
  },
];
