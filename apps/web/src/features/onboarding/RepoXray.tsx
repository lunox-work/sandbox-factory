/**
 * A repository at a glance: what the platform learned from registering it,
 * and where a first bounty fits.
 *
 * Registering a repository takes a snapshot of its default branch — the file
 * list, never the contents — and detects its stack from a few dependency
 * manifests. That is enough to say something useful straight away without a
 * model call: what it is written in, how it is split into modules, how much
 * of it is tests, whether it keeps migrations and CI. And from the modules,
 * which ones a first bounty is easiest to cut a sandbox from (`fitModules`).
 *
 * A snapshot is taken in the background, so right after registering there is
 * none yet; the list is read again every few seconds until one lands.
 */

import type { GithubRepoDto } from "@sandbox-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, FolderGit2, Lock, PenLine } from "lucide-react";
import { useId } from "react";

import { StackIcon } from "@/components/StackIcon";
import { Button } from "@/components/ui/button";

import { clients, queryKeys, useUserId } from "../../data/query";
import { plural } from "../../lib/format";
import { isPlainLeftClick, pathForScreen } from "../../routes";
import { fitModules, testShare } from "./insights";
import type { BountyPrefill } from "./prefill";

/** How often a repository with no snapshot yet is read again. */
export const SNAPSHOT_POLL_MS = 3_000;

export function RepoXray({
  organizationId,
  organizationSlug,
  repo,
  onOpenRepository,
  onWriteBounty,
}: {
  organizationId: string;
  organizationSlug: string;
  repo: GithubRepoDto;
  onOpenRepository: (repo: GithubRepoDto) => void;
  /** Absent where the person may not write one. */
  onWriteBounty?: ((prefill: BountyPrefill) => void) | undefined;
}) {
  const userId = useUserId();
  const headingId = useId();
  const snapshots = useQuery({
    queryKey: queryKeys.resource(
      userId,
      organizationId,
      "repo-snapshots",
      repo.id,
    ),
    queryFn: ({ signal }) =>
      clients.analysis.snapshots(organizationId, repo.id, signal),
    refetchInterval: (query) =>
      query.state.error === null && (query.state.data ?? []).length === 0
        ? SNAPSHOT_POLL_MS
        : false,
  });
  // The head's, when it has one; otherwise the newest there is.
  const list = snapshots.data ?? [];
  const latest =
    list.find(({ commitSha }) => commitSha === repo.headSha) ?? list[0];
  const detail = useQuery({
    queryKey: queryKeys.resource(
      userId,
      organizationId,
      "snapshot",
      latest?.id ?? null,
    ),
    enabled: latest !== undefined,
    queryFn: ({ signal }) =>
      clients.analysis.snapshot(organizationId, latest?.id ?? "", signal),
  });
  const facts = detail.data?.facts;
  const fits = facts === undefined ? [] : fitModules(facts);
  const href = pathForScreen("org-repository", organizationSlug, repo.id);

  return (
    <section
      aria-labelledby={headingId}
      data-testid="repo-xray"
      className="flex flex-col gap-4 rounded-lg border p-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2
            id={headingId}
            className="flex min-w-0 items-center gap-2 text-base font-semibold tracking-tight"
          >
            <FolderGit2 className="text-muted-foreground size-4 shrink-0" />
            <span className="truncate">{repo.fullName}</span>
            {repo.isPrivate && (
              <Lock
                aria-label="Private"
                className="text-muted-foreground size-3.5 shrink-0"
              />
            )}
          </h2>
          <p className="text-muted-foreground mt-1 text-xs">
            {repo.defaultBranch}
            {latest !== undefined && (
              <>
                {" · "}
                <span className="font-mono">
                  {latest.commitSha.slice(0, 7)}
                </span>
              </>
            )}
            {" · read from its file list and package manifests"}
          </p>
        </div>
        <Button variant="ghost" size="sm" className="-mr-2 gap-1" asChild>
          <a
            href={href}
            onClick={(event) => {
              if (isPlainLeftClick(event)) {
                event.preventDefault();
                onOpenRepository(repo);
              }
            }}
          >
            Open
            <ArrowRight className="size-4" />
          </a>
        </Button>
      </header>

      {(repo.stack ?? []).length > 0 && (
        <ul aria-label="Tech stack" className="flex flex-wrap gap-1.5">
          {(repo.stack ?? []).map((name) => (
            <li
              key={name}
              className="bg-muted/60 flex items-center gap-1.5 rounded-md px-2 py-1 text-xs"
            >
              <StackIcon name={name} className="size-3.5" />
              {name}
            </li>
          ))}
        </ul>
      )}

      {snapshots.isError || detail.isError ? (
        <p className="text-muted-foreground text-sm">
          Could not read this repository&rsquo;s snapshot.
        </p>
      ) : facts === undefined ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <p className="text-muted-foreground text-sm">
            Reading {repo.fullName}&rsquo;s file list…
          </p>
          <div
            aria-hidden="true"
            className="grid grid-cols-2 gap-2 sm:grid-cols-4"
          >
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="skeleton h-14 rounded-md" />
            ))}
          </div>
        </div>
      ) : (
        <>
          <dl
            className="grid grid-cols-2 gap-2 sm:grid-cols-4"
            data-testid="repo-facts"
          >
            <Fact
              label="Files"
              // GitHub cut the listing short: a lower bound, said as one.
              value={`${facts.fileCount.toLocaleString("en-US")}${facts.truncated ? "+" : ""}`}
            />
            <Fact label="Modules" value={String(facts.modules.length)} />
            <Fact
              label="Tests"
              value={`${testShare(facts)}%`}
              note={plural(facts.testFiles, "file")}
            />
            <Fact
              label="Also"
              value={
                [
                  facts.migrationDirectories.length > 0 ? "Migrations" : null,
                  facts.infraDirectories.length > 0 ? "CI" : null,
                ]
                  .filter((part) => part !== null)
                  .join(" · ") || "—"
              }
            />
          </dl>

          {fits.length > 0 && (
            <div className="flex flex-col gap-2">
              <div>
                <h3 className="text-sm font-medium">
                  Where a first bounty fits
                </h3>
                <p className="text-muted-foreground text-xs">
                  Modules with their own tests and a contained size are the
                  easiest to slice into a sandbox and check.
                </p>
              </div>
              <ul
                className="divide-y rounded-md border"
                data-testid="fit-modules"
              >
                {fits.map((module) => (
                  <li
                    key={module.path}
                    className="flex items-center gap-3 px-3 py-2"
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-mono text-xs">
                        {module.path}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {plural(module.files, "file")}
                        {module.testFiles > 0 &&
                          ` · ${plural(module.testFiles, "test")}`}
                        {" · "}
                        {module.reasons.join(", ")}
                      </span>
                    </span>
                    {onWriteBounty !== undefined && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0 gap-1.5"
                        aria-label={`Write a bounty in ${module.path}`}
                        onClick={() =>
                          onWriteBounty({
                            area: module.path,
                            repository: repo.fullName,
                          })
                        }
                      >
                        <PenLine className="size-3.5" />
                        <span className="hidden sm:inline">Write a bounty</span>
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Fact({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string | undefined;
}) {
  return (
    <div className="bg-muted/40 flex flex-col gap-0.5 rounded-md px-3 py-2">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm font-semibold tabular-nums">
        {value}
        {note !== undefined && (
          <span className="text-muted-foreground ml-1 text-xs font-normal">
            {note}
          </span>
        )}
      </dd>
    </div>
  );
}
