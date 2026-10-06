/**
 * What a DeepWiki-Open run wrote: the wiki's outline, from the bounded
 * summary on the `wiki_structure` artifact. Each page names the artifact
 * its text is in, which opens through a signed URL.
 *
 * The service reads the repository at its default branch when the run
 * happens, not from the snapshot, and the view says so: the commit the run
 * was asked for is shown as what was requested, not what was read.
 */

import { BookOpenText } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ArtifactDto, DeepwikiSummaryDto } from "@sandbox-factory/shared";
import { WIKI_IMPORTANCE } from "@sandbox-factory/shared";

import { PathChip, StatTiles, SubHeading } from "./Blocks";
import { artifactAtPath } from "./artifacts";
import { shortSha } from "./labels";

/** File paths a page's card lists before the rest are folded into a count. */
const PATHS_SHOWN = 6;

const IMPORTANCE_LABELS: Record<
  DeepwikiSummaryDto["pages"][number]["importance"],
  string
> = {
  high: "Key pages",
  medium: "Supporting pages",
  low: "Reference pages",
};

export function DeepwikiResult({
  summary,
  artifacts,
  onOpen,
}: {
  summary: DeepwikiSummaryDto;
  artifacts: readonly ArtifactDto[];
  onOpen: (artifactId: string) => void;
}) {
  const groups = WIKI_IMPORTANCE.map((importance) => ({
    importance,
    pages: summary.pages.filter((page) => page.importance === importance),
  })).filter((group) => group.pages.length > 0);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="text-base font-semibold">{summary.title}</p>
        {summary.description !== "" && (
          <p className="text-muted-foreground text-sm">{summary.description}</p>
        )}
        <p className="text-muted-foreground text-xs">
          {[summary.provider, summary.model]
            .filter((part): part is string => part !== null)
            .join(" · ") || "Provider not reported"}
        </p>
      </div>
      <StatTiles
        stats={[
          { label: "Pages", value: summary.pages.length },
          { label: "Sections", value: summary.sections.length },
        ]}
      />
      <p className="text-muted-foreground text-xs">
        DeepWiki read the repository&rsquo;s default branch at run time, not
        this snapshot. The run was asked for{" "}
        <span className="font-mono">
          {shortSha(summary.requestedCommitSha)}
        </span>
        .
      </p>
      {groups.map((group) => (
        <div key={group.importance} className="flex flex-col gap-2">
          <SubHeading>{IMPORTANCE_LABELS[group.importance]}</SubHeading>
          <ul
            aria-label={IMPORTANCE_LABELS[group.importance]}
            className="grid gap-3 sm:grid-cols-2"
          >
            {group.pages.map((page) => {
              const artifact = artifactAtPath(artifacts, page.path);
              const hidden = page.filePaths.length - PATHS_SHOWN;
              return (
                <li
                  key={page.id}
                  className="flex flex-col gap-2 rounded-[6px] border p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 text-sm font-medium">{page.title}</p>
                    {artifact !== undefined && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        aria-label={`Open page ${page.title}`}
                        onClick={() => onOpen(artifact.id)}
                      >
                        <BookOpenText />
                        Open page
                      </Button>
                    )}
                  </div>
                  {page.filePaths.length > 0 && (
                    <ul className="flex flex-wrap gap-1">
                      {page.filePaths.slice(0, PATHS_SHOWN).map((path) => (
                        <PathChip key={path}>{path}</PathChip>
                      ))}
                      {hidden > 0 && (
                        <li className="text-muted-foreground px-1 py-0.5 text-xs">
                          +{hidden}
                        </li>
                      )}
                    </ul>
                  )}
                  {page.relatedPages.length > 0 && (
                    <p className="text-muted-foreground text-xs">
                      {page.relatedPages.length} related{" "}
                      {page.relatedPages.length === 1 ? "page" : "pages"}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {summary.sections.length > 0 && (
        <div className="flex flex-col gap-2">
          <SubHeading>Sections</SubHeading>
          <ul aria-label="Sections" className="flex flex-col gap-1 text-sm">
            {summary.sections.map((section) => (
              <li key={section.id} className="flex items-baseline gap-2">
                <span className="font-medium">{section.title}</span>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {section.pages.length}{" "}
                  {section.pages.length === 1 ? "page" : "pages"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
