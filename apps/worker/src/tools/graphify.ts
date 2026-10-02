import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GRAPHIFY_TOOL_VERSION } from "sandbox-factory";
import { command } from "../command.js";
import { AnalysisError } from "../errors.js";
import type { ArtifactFile, ToolAdapter } from "./adapter.js";

export function artifactKind(path: string): ArtifactFile["kind"] {
  if (path === "graph.json") return "graph_json";
  if (path === "graph.html") return "graph_html";
  if (path === "GRAPH_REPORT.md") return "report_md";
  if (path === "manifest.json") return "manifest";
  return path.startsWith("wiki/") && path.endsWith(".md")
    ? "wiki_page"
    : "other";
}
export function createGraphifyAdapter(
  options: {
    execute?: typeof command;
    python?: string;
    scriptPath?: string;
  } = {},
): ToolAdapter {
  return {
    name: "graphify",
    version: GRAPHIFY_TOOL_VERSION,
    async run(input) {
      input.log("Graphify AST analysis started.");
      const script =
        options.scriptPath ??
        fileURLToPath(new URL("../../python/run_graphify.py", import.meta.url));
      await (options.execute ?? command)(
        options.python ?? "python3",
        [script, input.sourceDir, input.outDir],
        { signal: input.signal },
      );
      const artifacts: ArtifactFile[] = [];
      const visit = async (directory: string, prefix = "") => {
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries.sort((a, b) =>
          a.name.localeCompare(b.name),
        )) {
          const path = `${prefix}${entry.name}`;
          const absolutePath = join(directory, entry.name);
          if (entry.isDirectory()) await visit(absolutePath, `${path}/`);
          else if (entry.isFile()) {
            if (artifacts.length >= 25_005)
              throw new AnalysisError("tool_failed");
            const kind = artifactKind(path);
            const meta =
              kind === "manifest"
                ? (JSON.parse(await readFile(absolutePath, "utf8")) as Record<
                    string,
                    unknown
                  >)
                : null;
            artifacts.push({
              path,
              absolutePath,
              kind,
              contentType: path.endsWith(".html")
                ? "text/html; charset=utf-8"
                : path.endsWith(".json")
                  ? "application/json"
                  : "text/plain; charset=utf-8",
              meta,
            });
          } else throw new AnalysisError("tool_failed");
        }
      };
      await visit(input.outDir);
      if (
        ![
          "graph_json",
          "graph_html",
          "report_md",
          "manifest",
          "wiki_page",
        ].every((kind) => artifacts.some((artifact) => artifact.kind === kind))
      )
        throw new AnalysisError("tool_failed");
      const manifest =
        artifacts.find((artifact) => artifact.kind === "manifest")?.meta ??
        null;
      input.log("Graphify AST analysis completed.");
      return artifacts.map((artifact) =>
        artifact.kind === "graph_json"
          ? { ...artifact, meta: manifest }
          : artifact,
      );
    },
  };
}
