import type { ArtifactKind, AnalysisParams } from "sandbox-factory";

export interface ArtifactFile {
  readonly path: string;
  readonly absolutePath: string;
  readonly kind: ArtifactKind;
  readonly contentType: string;
  readonly meta: Record<string, unknown> | null;
}
export interface ToolAdapter {
  readonly name: "graphify";
  readonly version: string;
  run(input: {
    sourceDir: string;
    outDir: string;
    params: AnalysisParams;
    signal: AbortSignal;
    log: (line: string) => void;
  }): Promise<ArtifactFile[]>;
}
