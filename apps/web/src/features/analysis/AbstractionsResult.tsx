/**
 * What an Abstractions run found: how many modules and exports, how each
 * was read (typed, syntactic or names only), the languages, the most
 * imported modules as bars, and what was left out. Drawn from the bounded
 * summary on the `manifest` and `abstraction_index` artifacts; the index
 * itself and its readable view open through signed URLs.
 */

import { Braces, FileText } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  AbstractionsSummaryDto,
  ArtifactDto,
} from "@sandbox-factory/shared";

import { StatTiles, SubHeading, TruncatedNote } from "./Blocks";
import { artifactAtPath, artifactOfKind } from "./artifacts";

/** How a module was read, in the page's words. */
export const coverageLabels: Record<
  AbstractionsSummaryDto["modules"][number]["coverage"],
  string
> = {
  typed: "Typed",
  syntactic: "Syntactic",
  "names-only": "Names only",
};

export function AbstractionsResult({
  summary,
  artifacts,
  onOpen,
}: {
  summary: AbstractionsSummaryDto;
  artifacts: readonly ArtifactDto[];
  onOpen: (artifactId: string) => void;
}) {
  const index = artifactOfKind(artifacts, "abstraction_index");
  const readable = artifactAtPath(artifacts, "abstractions.md");
  const most = Math.max(
    1,
    ...summary.modules.map((module) => module.importers),
  );
  return (
    <div className="flex flex-col gap-4">
      <StatTiles
        stats={[
          { label: "Modules", value: summary.counts.modules },
          { label: "Exports", value: summary.counts.exports },
          { label: "Typed", value: summary.coverage.typed },
          { label: "Syntactic", value: summary.coverage.syntactic },
          { label: "Names only", value: summary.coverage["names-only"] },
          { label: "Omissions", value: summary.counts.omissions },
        ]}
      />
      {summary.languages.length > 0 && (
        <div className="flex flex-col gap-2">
          <SubHeading>Languages</SubHeading>
          <ul
            aria-label="Languages"
            className="flex flex-wrap gap-x-4 gap-y-1 text-sm"
          >
            {summary.languages.map((language) => (
              <li
                key={language.language}
                className="flex items-baseline gap-1.5"
              >
                <span className="font-medium">{language.language}</span>
                <span className="text-muted-foreground tabular-nums">
                  {language.modules.toLocaleString()}{" "}
                  {language.modules === 1 ? "module" : "modules"} ·{" "}
                  {language.exports.toLocaleString()}{" "}
                  {language.exports === 1 ? "export" : "exports"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {summary.modules.length > 0 && (
        <div className="flex flex-col gap-2">
          <SubHeading>Most imported modules</SubHeading>
          <ul
            aria-label="Most imported modules"
            className="flex flex-col gap-1.5"
          >
            {summary.modules.map((module) => (
              <li
                key={module.path}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 text-xs"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-mono" title={module.path}>
                    {module.path}
                  </span>
                  <Badge variant="outline" className="rounded-[4px]">
                    {coverageLabels[module.coverage]}
                  </Badge>
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {module.importers} in · {module.exports}{" "}
                  {module.exports === 1 ? "export" : "exports"}
                </span>
                <span
                  className="bg-primary/15 col-span-2 block h-1.5 overflow-hidden rounded-[4px]"
                  aria-hidden="true"
                >
                  <span
                    className="bg-primary block h-full rounded-[4px]"
                    style={{
                      width: `${Math.round((module.importers / most) * 100)}%`,
                    }}
                    data-testid="importer-bar"
                  />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {summary.omissions.length > 0 && (
        <div className="flex flex-col gap-2">
          <SubHeading>Omissions</SubHeading>
          <ul aria-label="Omissions" className="flex flex-col gap-1 text-xs">
            {summary.omissions.map((omission, position) => (
              <li key={position} className="break-words">
                <span className="font-mono">
                  {omission.file ?? "(project)"}
                </span>{" "}
                <span className="text-muted-foreground">{omission.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {summary.truncated && <TruncatedNote whole="the index JSON" />}
      {(index !== undefined || readable !== undefined) && (
        <div className="flex flex-wrap gap-2">
          {index !== undefined && (
            <Button size="sm" onClick={() => onOpen(index.id)}>
              <Braces />
              Open index JSON
            </Button>
          )}
          {readable !== undefined && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpen(readable.id)}
            >
              <FileText />
              Open readable view
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
