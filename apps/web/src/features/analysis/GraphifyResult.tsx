/**
 * What a Graphify run found: the size of the map, how sure it is of its
 * edges, and the documents it wrote. The figures come from the `graph_json`
 * artifact's `meta`; the graph, the report and the wiki pages open through
 * signed URLs.
 */

import { BookOpen, FileText, Waypoints } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ArtifactDto } from "@sandbox-factory/shared";
import { graphifySummarySchema } from "@sandbox-factory/shared";

import { StatTiles, SubHeading } from "./Blocks";
import { artifactOfKind, summaryOf } from "./artifacts";

export function GraphifyResult({
  artifacts,
  onOpen,
}: {
  artifacts: readonly ArtifactDto[];
  onOpen: (artifactId: string) => void;
}) {
  const summary = summaryOf(artifacts, ["graph_json"], graphifySummarySchema);
  const graph = artifactOfKind(artifacts, "graph_html");
  const report = artifactOfKind(artifacts, "report_md");
  const pages = artifacts.filter((artifact) => artifact.kind === "wiki_page");
  const confidence = Object.entries(summary?.confidence ?? {}).sort(
    ([, a], [, b]) => b - a,
  );
  return (
    <div className="flex flex-col gap-4">
      {summary !== null && (
        <StatTiles
          stats={[
            { label: "Nodes", value: summary.nodes },
            { label: "Edges", value: summary.edges },
            { label: "Unresolved", value: summary.unresolved },
            { label: "Shown in graph view", value: summary.visualizationNodes },
          ]}
        />
      )}
      {confidence.length > 0 && (
        <div className="flex flex-col gap-2">
          <SubHeading>Edge confidence</SubHeading>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {confidence.map(([level, count]) => (
              <li key={level} className="flex items-baseline gap-1.5">
                <span className="font-medium tabular-nums">
                  {count.toLocaleString()}
                </span>
                <span className="text-muted-foreground">{level}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {(graph !== undefined || report !== undefined) && (
        <div className="flex flex-wrap gap-2">
          {graph !== undefined && (
            <Button size="sm" onClick={() => onOpen(graph.id)}>
              <Waypoints />
              Open graph
            </Button>
          )}
          {report !== undefined && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpen(report.id)}
            >
              <FileText />
              Open report
            </Button>
          )}
        </div>
      )}
      {pages.length > 0 && (
        <div className="flex flex-col gap-2">
          <SubHeading>Wiki pages</SubHeading>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {pages.map((page) => (
              <li key={page.id}>
                <button
                  type="button"
                  className="hover:bg-muted/60 focus-visible:ring-ring/50 flex w-full items-center gap-2 rounded-[6px] border px-3 py-2 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
                  onClick={() => onOpen(page.id)}
                >
                  <BookOpen className="text-muted-foreground size-4 shrink-0" />
                  <span className="truncate">{wikiTitle(page.path)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** `wiki/foo-bar.md` as "foo-bar": the page's name, not its file. */
function wikiTitle(path: string): string {
  return path.replace(/^wiki\//, "").replace(/\.md$/, "");
}
