/**
 * What a Dependency Cruiser run found: counts over the whole cruise, the
 * most connected modules as bars, the cycles, the orphans and the imports
 * that resolved to nothing. Drawn from the bounded summary on the
 * `manifest` and `dependency_graph` artifacts; the cruise itself and its
 * DOT graph open through signed URLs.
 */

import { Braces, GitFork } from "lucide-react";

import { Button } from "@/components/ui/button";
import type {
  ArtifactDto,
  DependencyCruiserSummaryDto,
} from "@sandbox-factory/shared";

import { PathChip, StatTiles, SubHeading, TruncatedNote } from "./Blocks";
import { artifactOfKind } from "./artifacts";

export function DependencyResult({
  summary,
  artifacts,
  onOpen,
}: {
  summary: DependencyCruiserSummaryDto;
  artifacts: readonly ArtifactDto[];
  onOpen: (artifactId: string) => void;
}) {
  const cruise = artifactOfKind(artifacts, "dependency_graph");
  const dot = artifactOfKind(artifacts, "dependency_dot");
  const busiest = Math.max(
    1,
    ...summary.modules.map((module) => module.dependents + module.dependencies),
  );
  return (
    <div className="flex flex-col gap-4">
      <StatTiles
        stats={[
          { label: "Modules", value: summary.counts.modules },
          { label: "Dependencies", value: summary.counts.dependencies },
          { label: "Cycles", value: summary.counts.circular },
          { label: "Orphans", value: summary.counts.orphans },
          { label: "Unresolved", value: summary.counts.unresolved },
          { label: "External", value: summary.counts.external },
        ]}
      />
      {summary.modules.length > 0 && (
        <div className="flex flex-col gap-2">
          <SubHeading>Most connected modules</SubHeading>
          <ul
            aria-label="Most connected modules"
            className="flex flex-col gap-1.5"
          >
            {summary.modules.map((module) => {
              const total = module.dependents + module.dependencies;
              const pct = Math.round((total / busiest) * 100);
              return (
                <li
                  key={module.source}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 text-xs"
                >
                  <span className="truncate font-mono" title={module.source}>
                    {module.source}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {module.dependents} in · {module.dependencies} out
                  </span>
                  {/*
                    One hue, the fill over a lighter step of the same ramp,
                    so the length is the only thing that varies between rows.
                  */}
                  <span
                    className="bg-primary/15 col-span-2 block h-1.5 overflow-hidden rounded-[4px]"
                    aria-hidden="true"
                  >
                    <span
                      className="bg-primary block h-full rounded-[4px]"
                      style={{ width: `${pct}%` }}
                      data-testid="module-bar"
                    />
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {summary.cycles.length > 0 && (
        <div className="flex flex-col gap-2">
          <SubHeading>Cycles</SubHeading>
          <ul aria-label="Cycles" className="flex flex-col gap-1">
            {summary.cycles.map((cycle, index) => (
              <li
                key={index}
                className="bg-muted/40 rounded-[6px] px-3 py-2 font-mono text-xs break-all"
              >
                {cycleText(cycle)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {summary.orphans.length > 0 && (
        <div className="flex flex-col gap-2">
          <SubHeading>Orphans</SubHeading>
          <ul aria-label="Orphans" className="flex flex-wrap gap-1.5">
            {summary.orphans.map((path) => (
              <PathChip key={path}>{path}</PathChip>
            ))}
          </ul>
        </div>
      )}
      {summary.unresolved.length > 0 && (
        <div className="flex flex-col gap-2">
          <SubHeading>Unresolved imports</SubHeading>
          <ul aria-label="Unresolved imports" className="flex flex-col gap-1">
            {summary.unresolved.map((item, index) => (
              <li key={index} className="font-mono text-xs break-all">
                {item.from}{" "}
                <span className="text-muted-foreground">imports</span>{" "}
                {item.module}
              </li>
            ))}
          </ul>
        </div>
      )}
      {summary.truncated && <TruncatedNote whole="the cruise JSON" />}
      {(cruise !== undefined || dot !== undefined) && (
        <div className="flex flex-wrap gap-2">
          {cruise !== undefined && (
            <Button size="sm" onClick={() => onOpen(cruise.id)}>
              <Braces />
              Open cruise JSON
            </Button>
          )}
          {dot !== undefined && (
            <Button variant="outline" size="sm" onClick={() => onOpen(dot.id)}>
              <GitFork />
              Open DOT
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** A cycle written as the walk back to where it started: `a → b → a`. */
export function cycleText(cycle: readonly string[]): string {
  const [first] = cycle;
  if (first === undefined) return "";
  const walk =
    cycle.at(-1) === first && cycle.length > 1 ? cycle : [...cycle, first];
  return walk.join(" → ");
}
