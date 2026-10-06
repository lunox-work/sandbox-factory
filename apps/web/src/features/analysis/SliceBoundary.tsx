/**
 * Reading a slice's boundary: the bounded summary the worker attached to
 * the `boundary-contract.json` artifact. What was included, what is
 * stubbed, what must stay public, what to mock and what blocks the slice.
 * The full documents open through signed URLs like every other artifact.
 *
 * Slices are made by bounties now, not from the repository page, so this
 * is a read-only view of a run that already happened.
 */

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  ArtifactDto,
  SliceBoundarySummaryDto,
} from "@sandbox-factory/shared";

function ModuleList({
  title,
  modules,
  empty,
}: {
  title: string;
  modules: SliceBoundarySummaryDto["outbound"];
  empty: string;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {modules.length === 0 ? (
        <p className="text-muted-foreground text-sm">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {modules.map((module) => (
            <li key={module.module} className="rounded border p-2">
              <p className="font-mono text-xs">{module.module}</p>
              <p className="text-muted-foreground mt-1 text-xs">
                {module.symbols.length === 0
                  ? "Whole module"
                  : module.symbols.join(", ")}
                {module.truncated ? " …" : ""}
              </p>
              {module.importedBy.length > 0 && (
                <p className="text-muted-foreground mt-1 text-xs">
                  Imported by {module.importedBy.join(", ")}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function SliceBoundary({
  summary,
  artifacts,
  onOpen,
}: {
  summary: SliceBoundarySummaryDto;
  artifacts: readonly ArtifactDto[];
  onOpen: (artifactId: string) => void;
}) {
  const document = (path: string) =>
    artifacts.find((artifact) => artifact.path === path);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={summary.ready ? "default" : "destructive"}>
          {summary.ready ? "Ready for the sandbox gates" : "Diagnostic only"}
        </Badge>
        <Badge variant="outline">coverage: {summary.stubCoverage}</Badge>
        <Badge variant="outline">{summary.language}</Badge>
      </div>
      <p className="text-muted-foreground text-xs">
        {summary.counts.includedFiles} files included · {summary.counts.stubs}{" "}
        stubbed symbols across {summary.counts.outboundModules} modules ·{" "}
        {summary.counts.publicSymbols} public symbols ·{" "}
        {summary.counts.externals} externals
        {summary.truncated ? " · summary truncated; open boundary.md" : ""}
      </p>
      {summary.blockers.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Blockers</h3>
          <ul className="space-y-1">
            {summary.blockers.map((blocker, index) => (
              <li key={index} className="text-xs">
                <span className="font-mono">{blocker.code}</span>
                {blocker.file !== null && (
                  <span className="font-mono">
                    {" "}
                    {blocker.file}
                    {blocker.location !== null ? `:${blocker.location}` : ""}
                  </span>
                )}{" "}
                — {blocker.detail}
              </li>
            ))}
          </ul>
        </section>
      )}
      <ModuleList
        title="Stubbed modules"
        modules={summary.outbound}
        empty="The slice imports nothing outside itself."
      />
      <ModuleList
        title="Public surface"
        modules={summary.inbound}
        empty="Nothing outside the slice imports it."
      />
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Externals to mock</h3>
        {summary.externals.packages.length === 0 &&
        summary.externals.environment.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No service SDKs or environment reads were detected.
          </p>
        ) : (
          <ul className="space-y-1 text-xs">
            {summary.externals.packages.map((item) => (
              <li key={item.specifier} className="font-mono">
                {item.specifier}{" "}
                <span className="text-muted-foreground">({item.service})</span>
              </li>
            ))}
            {summary.externals.environment.map((name) => (
              <li key={name} className="font-mono">
                {name}{" "}
                <span className="text-muted-foreground">(environment)</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="flex flex-wrap gap-2">
        {["boundary.md", "public-surface.md", "abstract.md"].map((path) => {
          const artifact = document(path);
          return artifact === undefined ? null : (
            <Button
              key={path}
              variant="outline"
              size="sm"
              onClick={() => onOpen(artifact.id)}
            >
              Open {path}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
