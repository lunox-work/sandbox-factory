/**
 * What a slice run writes, and the rules that read it.
 *
 * `slice-manifest.json` is the immutable record of a proposed slice: the
 * source it was cut from, the copied files pinned by hash, the generated
 * files kept apart from them, the cut edges, the externals and whatever
 * blocks the slice from becoming a sandbox. `boundary-contract.json` is the
 * machine-readable shape of the boundary: the symbols the slice imports from
 * outside (stubs) and the symbols outside code imports from it (its public
 * surface), with their declarations. The markdown views are rendered from
 * the contract and never carry anything it does not.
 */

import type { SliceBudget, SliceParams } from "../analysis.js";
import type { SliceExternals } from "./externals.js";
import type { CutEdge } from "./reach.js";

export const SLICE_MANIFEST_SCHEMA_VERSION = 1;
export const BOUNDARY_CONTRACT_SCHEMA_VERSION = 1;

/**
 * How much of the boundary carries declarations. `full` means every cut
 * and public symbol has one and the fixture compiled; it says nothing about
 * runtime readiness. `partial` and `names-only` are diagnostic output.
 */
export type StubCoverage = "full" | "partial" | "names-only";

export const SLICE_BLOCKER_CODES = [
  "unknown_entry_point",
  "unresolved_import",
  "dynamic_dependency",
  "missing_build_input",
  "no_extractor",
  "declaration_incomplete",
  "compile_error",
] as const;
export type SliceBlockerCode = (typeof SLICE_BLOCKER_CODES)[number];

export interface SliceBlocker {
  readonly code: SliceBlockerCode;
  readonly file: string | null;
  readonly location: string | null;
  readonly detail: string;
}

export interface BoundarySymbol {
  readonly name: string;
  /** `function`, `class`, `interface`, `type`, `enum`, `variable`, `module`, `unknown`. */
  readonly kind: string;
  /** Declaration text, `.d.ts` style; null when the language has no extractor. */
  readonly declaration: string | null;
}

export interface BoundaryModule {
  /** Repository path of the module. */
  readonly module: string;
  readonly symbols: readonly BoundarySymbol[];
  /** Files on the other side of the cut that import it, sorted. */
  readonly importedBy: readonly string[];
  /** For an outbound module: the generated stub's artifact path. */
  readonly stubPath: string | null;
}

export interface CompilationResult {
  readonly attempted: boolean;
  readonly ok: boolean;
  readonly diagnostics: readonly {
    readonly file: string | null;
    readonly line: number | null;
    readonly code: string;
    readonly message: string;
  }[];
  /** Package specifiers declared `any` so the fixture could type-check. */
  readonly shimmedPackages: readonly string[];
}

export interface BoundaryContract {
  readonly schemaVersion: typeof BOUNDARY_CONTRACT_SCHEMA_VERSION;
  readonly toolVersion: string;
  readonly extractorVersion: string | null;
  readonly sourceSnapshotId: string;
  readonly sourceCommitSha: string;
  readonly graphRunId: string;
  readonly language: "typescript" | "none";
  /** Slice → outside: what the slice needs, as stubs. */
  readonly outbound: readonly BoundaryModule[];
  /** Outside → slice: what the slice must keep offering. */
  readonly inbound: readonly BoundaryModule[];
  readonly stubCoverage: StubCoverage;
  readonly compilation: CompilationResult;
  readonly blockers: readonly SliceBlocker[];
}

export interface IncludedFile {
  readonly path: string;
  /** Git's blob id of the bytes read, so the sandbox can verify its copy. */
  readonly blobId: string;
  readonly sha256: string;
  /** `100644` or `100755`, as Git records it. */
  readonly mode: string;
  readonly sizeBytes: number;
  readonly operations: readonly "edit"[];
}

export interface SyntheticFile {
  readonly path: string;
  readonly kind: "stub" | "shim" | "config";
  readonly generator: string;
  readonly generatorVersion: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface RequiredBuildInputs {
  /** Compiler and package configuration the included files are read with. */
  readonly configs: readonly string[];
  /** Packages the included files import, with the version the source pins. */
  readonly packages: readonly {
    readonly name: string;
    readonly version: string | null;
    readonly declaredIn: string | null;
  }[];
}

/** Every operation a contribution may make on the slice has a stated rule. */
export interface OperationPolicy {
  readonly edit: "included-source-only";
  readonly add: "requires-approved-path-mapping";
  readonly delete: "requires-explicit-allowance";
  readonly rename: "requires-explicit-allowance";
  readonly synthetic: "rejected";
  readonly unknown: "refused";
}

export const OPERATION_POLICY: OperationPolicy = {
  edit: "included-source-only",
  add: "requires-approved-path-mapping",
  delete: "requires-explicit-allowance",
  rename: "requires-explicit-allowance",
  synthetic: "rejected",
  unknown: "refused",
};

export interface SliceMeta {
  readonly includedFiles: number;
  readonly includedBytes: number;
  readonly outboundCuts: number;
  readonly inboundCuts: number;
  readonly stubCoverage: StubCoverage;
  readonly externals: number;
  readonly blockers: number;
  readonly ready: boolean;
}

export interface SliceManifest {
  readonly schemaVersion: typeof SLICE_MANIFEST_SCHEMA_VERSION;
  readonly toolVersion: string;
  readonly extractorVersion: string | null;
  readonly sourceSnapshotId: string;
  readonly sourceCommitSha: string;
  readonly graphRunId: string;
  readonly graphSha256: string;
  readonly params: SliceParams;
  readonly entryPoints: readonly string[];
  readonly budget: SliceBudget;
  readonly included: readonly IncludedFile[];
  readonly synthetic: readonly SyntheticFile[];
  readonly requiredBuildInputs: RequiredBuildInputs;
  readonly cuts: {
    readonly outbound: readonly CutEdge[];
    readonly inbound: readonly CutEdge[];
  };
  /** Import edges between included files, with their specifiers; see `reach`. */
  readonly internalImports: readonly CutEdge[];
  readonly externals: SliceExternals;
  readonly communities: readonly number[];
  readonly blockers: readonly SliceBlocker[];
  readonly policy: OperationPolicy;
  readonly boundaryContractSha256: string;
  readonly meta: SliceMeta;
}

/**
 * Whether a slice may advance past diagnosis. Only full declaration
 * coverage with no blockers may; the sandbox phase then proves the runtime.
 */
export function sliceReadiness(input: {
  readonly stubCoverage: StubCoverage;
  readonly blockers: readonly SliceBlocker[];
}): { ready: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.stubCoverage !== "full")
    reasons.push(`Declaration coverage is ${input.stubCoverage}.`);
  for (const blocker of input.blockers)
    reasons.push(
      `${blocker.code}${blocker.file === null ? "" : ` in ${blocker.file}`}: ${blocker.detail}`,
    );
  return { ready: reasons.length === 0, reasons };
}

/** The bounded view of a boundary a console renders without the files. */
export interface SliceBoundarySummary {
  readonly schemaVersion: 1;
  readonly language: BoundaryContract["language"];
  readonly stubCoverage: StubCoverage;
  readonly ready: boolean;
  readonly counts: {
    readonly includedFiles: number;
    readonly includedBytes: number;
    readonly outboundModules: number;
    readonly inboundModules: number;
    readonly stubs: number;
    readonly publicSymbols: number;
    readonly externals: number;
    readonly blockers: number;
  };
  readonly included: readonly string[];
  readonly outbound: readonly SummaryModule[];
  readonly inbound: readonly SummaryModule[];
  readonly externals: {
    readonly packages: readonly { specifier: string; service: string }[];
    readonly environment: readonly string[];
  };
  readonly blockers: readonly SliceBlocker[];
  /** Whether any list above was cut short. */
  readonly truncated: boolean;
}

export interface SummaryModule {
  readonly module: string;
  readonly symbols: readonly string[];
  readonly importedBy: readonly string[];
  readonly truncated: boolean;
}

export const SUMMARY_LIMITS = {
  files: 200,
  modules: 100,
  symbols: 50,
  importers: 10,
  blockers: 50,
} as const;

function summarizeModules(modules: readonly BoundaryModule[]): {
  modules: SummaryModule[];
  truncated: boolean;
} {
  let truncated = modules.length > SUMMARY_LIMITS.modules;
  const summarized = modules.slice(0, SUMMARY_LIMITS.modules).map((module) => {
    const cut =
      module.symbols.length > SUMMARY_LIMITS.symbols ||
      module.importedBy.length > SUMMARY_LIMITS.importers;
    truncated ||= cut;
    return {
      module: module.module,
      symbols: module.symbols
        .slice(0, SUMMARY_LIMITS.symbols)
        .map((symbol) => symbol.name),
      importedBy: module.importedBy.slice(0, SUMMARY_LIMITS.importers),
      truncated: cut,
    };
  });
  return { modules: summarized, truncated };
}

export function boundarySummary(
  contract: BoundaryContract,
  manifest: Pick<SliceManifest, "included" | "externals" | "meta">,
): SliceBoundarySummary {
  const outbound = summarizeModules(contract.outbound);
  const inbound = summarizeModules(contract.inbound);
  const count = (modules: readonly BoundaryModule[]) =>
    modules.reduce((total, module) => total + module.symbols.length, 0);
  return {
    schemaVersion: 1,
    language: contract.language,
    stubCoverage: contract.stubCoverage,
    ready: manifest.meta.ready,
    counts: {
      includedFiles: manifest.included.length,
      includedBytes: manifest.meta.includedBytes,
      outboundModules: contract.outbound.length,
      inboundModules: contract.inbound.length,
      stubs: count(contract.outbound),
      publicSymbols: count(contract.inbound),
      externals:
        manifest.externals.packages.length +
        manifest.externals.environment.length,
      blockers: contract.blockers.length,
    },
    included: manifest.included
      .slice(0, SUMMARY_LIMITS.files)
      .map((file) => file.path),
    outbound: outbound.modules,
    inbound: inbound.modules,
    externals: {
      packages: manifest.externals.packages.map(({ specifier, service }) => ({
        specifier,
        service,
      })),
      environment: manifest.externals.environment.map(({ name }) => name),
    },
    blockers: contract.blockers.slice(0, SUMMARY_LIMITS.blockers),
    truncated:
      outbound.truncated ||
      inbound.truncated ||
      manifest.included.length > SUMMARY_LIMITS.files ||
      contract.blockers.length > SUMMARY_LIMITS.blockers,
  };
}

function fence(text: string, language: string) {
  // A scan rather than /\n+$/, which backtracks quadratically on a long run
  // of newlines that does not end the declaration.
  let end = text.length;
  while (end > 0 && text[end - 1] === "\n") end -= 1;
  return `\`\`\`${language}\n${text.slice(0, end)}\n\`\`\``;
}

function renderModules(modules: readonly BoundaryModule[], empty: string) {
  if (modules.length === 0) return [empty];
  const lines: string[] = [];
  for (const module of modules) {
    lines.push(`### \`${module.module}\``, "");
    if (module.importedBy.length > 0)
      lines.push(
        `Imported by: ${module.importedBy.map((file) => `\`${file}\``).join(", ")}`,
        "",
      );
    if (module.stubPath !== null)
      lines.push(`Stub: \`${module.stubPath}\``, "");
    for (const symbol of module.symbols) {
      lines.push(`- **${symbol.name}** (${symbol.kind})`);
      if (symbol.declaration !== null)
        lines.push("", fence(symbol.declaration, "ts"), "");
    }
    lines.push("");
  }
  return lines;
}

/** `boundary.md`: the whole boundary, readable, rendered from the contract. */
export function renderBoundaryMarkdown(
  contract: BoundaryContract,
  manifest: Pick<
    SliceManifest,
    "included" | "entryPoints" | "budget" | "externals" | "meta"
  >,
): string {
  const readiness = sliceReadiness(contract);
  const lines: string[] = [
    "# Slice boundary",
    "",
    `Source commit \`${contract.sourceCommitSha}\` (snapshot \`${contract.sourceSnapshotId}\`), graph run \`${contract.graphRunId}\`.`,
    "",
    `Entry points: ${manifest.entryPoints.map((entry) => `\`${entry}\``).join(", ")}. Budget: ${manifest.budget.maxFiles} files, depth ${manifest.budget.maxDepth}.`,
    "",
    `Declaration coverage: **${contract.stubCoverage}**. ${readiness.ready ? "No blockers: the slice may proceed to the sandbox gates." : "Diagnostic only: this slice cannot be published."}`,
    "",
  ];
  if (!readiness.ready) {
    lines.push("## Blockers", "");
    for (const reason of readiness.reasons) lines.push(`- ${reason}`);
    lines.push("");
  }
  lines.push("## Included files", "");
  for (const file of manifest.included)
    lines.push(
      `- \`${file.path}\` (${file.sizeBytes} bytes, blob ${file.blobId})`,
    );
  lines.push(
    "",
    "## Stubbed modules",
    "",
    "What the slice imports from outside, as declarations without bodies.",
    "",
    ...renderModules(
      contract.outbound,
      "The slice imports nothing outside itself.",
    ),
    "## Public surface",
    "",
    "What outside code imports from the slice; a contribution must keep these.",
    "",
    ...renderModules(contract.inbound, "Nothing outside the slice imports it."),
    "## Externals to mock",
    "",
  );
  if (
    manifest.externals.packages.length === 0 &&
    manifest.externals.environment.length === 0
  )
    lines.push("No service SDKs or environment reads were detected.");
  for (const item of manifest.externals.packages)
    lines.push(
      `- \`${item.specifier}\` (${item.service}) in ${item.files.map((file) => `\`${file}\``).join(", ")}`,
    );
  for (const item of manifest.externals.environment)
    lines.push(
      `- \`${item.name}\` read in ${item.files.map((file) => `\`${file}\``).join(", ")}`,
    );
  lines.push("", "## Compilation", "");
  if (!contract.compilation.attempted)
    lines.push("No compilation was attempted for this language.");
  else if (contract.compilation.ok)
    lines.push(
      `The included files and stubs type-check together${contract.compilation.shimmedPackages.length === 0 ? "." : `, with ${contract.compilation.shimmedPackages.map((name) => `\`${name}\``).join(", ")} declared as untyped packages.`}`,
    );
  else
    for (const diagnostic of contract.compilation.diagnostics)
      lines.push(
        `- ${diagnostic.file === null ? "" : `\`${diagnostic.file}\`${diagnostic.line === null ? "" : `:${diagnostic.line}`} `}${diagnostic.code}: ${diagnostic.message}`,
      );
  lines.push("");
  return lines.join("\n");
}

/** `public-surface.md`: only what a contribution must keep. */
export function renderPublicSurfaceMarkdown(
  contract: BoundaryContract,
): string {
  return [
    "# Public surface",
    "",
    `Symbols outside code imports from the slice at commit \`${contract.sourceCommitSha}\`. Their contracts are checked on every contribution; keeping a name alone is not compatibility.`,
    "",
    ...renderModules(contract.inbound, "Nothing outside the slice imports it."),
  ].join("\n");
}
