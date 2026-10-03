import type {
  AnalysisTool,
  ArtifactKind,
  AnalysisParams,
  SpecDraft,
} from "sandbox-factory";
import type {
  BuildOutput,
  StoredAnalysisRun,
  StoredArtifact,
  StoredVersionWithSource,
} from "@sandbox-factory/db";

/** The ticket an agent run works for: one revision of a proposal's spec. */
export interface AgentTask {
  readonly issueKey: string;
  readonly specRevision: number;
  readonly specHash: string;
  readonly draft: SpecDraft;
}
export interface ArtifactFile {
  readonly path: string;
  readonly absolutePath: string;
  readonly kind: ArtifactKind;
  readonly contentType: string;
  readonly meta: Record<string, unknown> | null;
}
/**
 * What a tool may read of earlier runs, scoped to the claimed run's owner.
 * A slice reads the graph a graphify run on the same snapshot wrote.
 */
export interface ToolInputs {
  getRun(runId: string): Promise<StoredAnalysisRun | null>;
  listArtifacts(runId: string): Promise<readonly StoredArtifact[]>;
  readArtifact(objectKey: string): Promise<Uint8Array | undefined>;
  /** A sandbox version with its private provenance, for a build. */
  getVersion(versionId: string): Promise<StoredVersionWithSource | null>;
  /** A proposal's spec revision, for an agent run. */
  getTask(proposalId: string, specRevision: number): Promise<AgentTask | null>;
  /** What a succeeded build proved, kept only while the draft still points at it. */
  recordBuildOutput(
    versionId: string,
    buildRunId: string,
    output: BuildOutput,
  ): Promise<boolean>;
}
export interface ToolRunInput {
  readonly sourceDir: string;
  readonly outDir: string;
  readonly params: AnalysisParams;
  /** The run being executed: which snapshot and commit the source is. */
  readonly run: { readonly snapshotId: string; readonly commitSha: string };
  readonly inputs: ToolInputs;
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
}
export interface ToolCommittedInput {
  readonly runId: string;
  /** The files `run` returned; still on disk until the run is cleaned up. */
  readonly files: readonly ArtifactFile[];
  readonly inputs: ToolInputs;
}
export interface ToolAdapter {
  readonly name: AnalysisTool;
  readonly version: string;
  run(input: ToolRunInput): Promise<ArtifactFile[]>;
  /**
   * After the run's artifacts are committed as succeeded. Best effort: the
   * run has already succeeded, so a failure here is logged, not reported.
   */
  committed?(input: ToolCommittedInput): Promise<void>;
}
