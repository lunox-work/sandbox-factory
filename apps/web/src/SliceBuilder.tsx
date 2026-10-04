import { useInfiniteQuery } from "@tanstack/react-query";
import { queryKeys, useUserId } from "./data/query";
/**
 * Choosing a slice and reading its boundary.
 *
 * The picker lists a snapshot's files a page at a time, under a directory
 * the person types, and collects the entry points a slice starts from. The
 * boundary view renders the bounded summary the worker attached to the
 * `boundary-contract.json` artifact: what was included, what is stubbed,
 * what must stay public, what to mock and what blocks the slice. The full
 * documents open through signed URLs like every other artifact.
 */

import { ErrorBanner, LoadingLine } from "@/components/Message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { GithubAnalysisClient } from "@sandbox-factory/client";
import { ApiError } from "@sandbox-factory/client";
import type {
  ArtifactDto,
  SliceBoundarySummaryDto,
} from "@sandbox-factory/shared";
import { SLICE_ENTRY_POINTS_MAX } from "@sandbox-factory/shared";
import { useEffect, useState } from "react";

const PAGE = 200;
/** Typing settles for this long before the file list is asked again. */
const FILTER_DELAY_MS = 250;

export function SliceEntryPicker({
  client,
  organizationId,
  snapshotId,
  selected,
  onChange,
}: {
  client: GithubAnalysisClient;
  organizationId: string;
  snapshotId: string;
  selected: readonly string[];
  onChange: (entryPoints: string[]) => void;
}) {
  // What the person typed, and the trimmed directory it settles into.
  const [filter, setFilter] = useState("");
  const [prefix, setPrefix] = useState("");
  const userId = useUserId();
  useEffect(() => {
    const timer = setTimeout(() => setPrefix(filter.trim()), FILTER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [filter]);
  const query = useInfiniteQuery({
    queryKey: queryKeys.resource(
      userId,
      organizationId,
      "tree",
      snapshotId,
      prefix,
    ),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) =>
      client.tree(
        organizationId,
        snapshotId,
        {
          prefix,
          limit: PAGE,
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
        signal,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const entries =
    query.data?.pages.flatMap((page) =>
      page.entries.filter((entry) => entry.type === "blob"),
    ) ?? [];
  const loading = query.isFetching;
  const cursor = query.hasNextPage ? "more" : null;
  const error =
    query.error === null
      ? null
      : query.error instanceof ApiError
        ? query.error.message
        : "The file list could not be loaded.";
  const more = async () => {
    await query.fetchNextPage();
  };
  const toggle = (path: string) =>
    onChange(
      selected.includes(path)
        ? selected.filter((item) => item !== path)
        : [...selected, path].sort(),
    );
  const full = selected.length >= SLICE_ENTRY_POINTS_MAX;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Directory filter"
          placeholder="Directory, such as src/api"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void query.refetch();
          }}
        >
          Reload
        </Button>
      </div>
      {error !== null && <ErrorBanner className="mt-0">{error}</ErrorBanner>}
      {selected.length > 0 && (
        <ul className="flex flex-wrap gap-1" aria-label="Chosen entry points">
          {selected.map((path) => (
            <li key={path}>
              <button
                type="button"
                className="bg-muted rounded px-2 py-0.5 font-mono text-xs"
                onClick={() => toggle(path)}
                aria-label={`Remove ${path}`}
              >
                {path} ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <ul className="max-h-64 space-y-1 overflow-auto rounded border p-2">
        {entries.map((entry) => (
          <li key={entry.path}>
            <label className="flex items-center gap-2 font-mono text-xs">
              <input
                type="checkbox"
                checked={selected.includes(entry.path)}
                disabled={full && !selected.includes(entry.path)}
                onChange={() => toggle(entry.path)}
              />
              {entry.path}
            </label>
          </li>
        ))}
        {!loading && entries.length === 0 && error === null && (
          <li className="text-muted-foreground text-xs">
            No files under this directory.
          </li>
        )}
      </ul>
      {loading && <LoadingLine />}
      {cursor !== null && !loading && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void more();
          }}
        >
          Load more files
        </Button>
      )}
      <p className="text-muted-foreground text-xs">
        {selected.length} of {SLICE_ENTRY_POINTS_MAX} entry points chosen. The
        slice reaches outward from them through the snapshot&rsquo;s imports.
      </p>
    </div>
  );
}

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
