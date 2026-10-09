/**
 * What a bounty's sources add to it, synced on request: its Jira issue's
 * fields (type, priority, story points, estimates, links) and its
 * repository's documents. Each sync that finds something new is a version
 * of that source's context. The overview holds the latest of each; the
 * bounty is sized with them and the sandbox generated with them, and each
 * of those says which versions it was made with.
 *
 * Two warnings, each where it is acted on. On the overview's links, a source
 * that has moved past its last sync is ahead, and syncing it brings the
 * overview up to date. On the bounty and the sandbox, a step made with an
 * older context version than the overview holds is behind on that source,
 * and making the step again brings it up to date.
 */

import { ApiError } from "@sandbox-factory/client";
import type {
  BountyContextResponse,
  BountyContextSourceStatusDto,
  BountyDto,
  ContextSourceDto,
  ContextVersionsDto,
} from "@sandbox-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  contextDrift,
  githubRepositories,
  type StageDrift,
} from "sandbox-factory";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { clients, queryKeys, useUserId } from "../../data/query";
import { dateTime, plural } from "../../lib/format";
import { JiraIcon, ProviderIcon } from "../../ProviderIcon";

const SOURCE_NAME: Record<ContextSourceDto, string> = {
  jira: "Jira",
  github: "GitHub",
};

function SourceIcon({ source }: { source: ContextSourceDto }) {
  return (
    <span
      aria-hidden
      className="flex size-3.5 shrink-0 items-center [&_svg]:size-3.5"
    >
      {source === "jira" ? <JiraIcon /> : <ProviderIcon provider="github" />}
    </span>
  );
}

const short = (version: number) => `v${version}`;
const shortSha = (sha: string) => sha.slice(0, 7);

/**
 * The query a bounty's context is read under, by what it is linked to: its
 * Jira issue. Its repositories are the workspace's, whichever it is about.
 */
function contextKey(userId: string, bounty: BountyDto) {
  return queryKeys.resource(
    userId,
    bounty.organizationId,
    "bounty-context",
    bounty.id,
    bounty.jira?.issueId ?? null,
    bounty.jira?.removedAt ?? null,
  );
}

export interface BountyContextState {
  /** Where each source stands; null while it is read, or could not be. */
  readonly status: BountyContextResponse | null;
  readonly loading: boolean;
  /** Which source is being synced now. */
  readonly syncing: ContextSourceDto | null;
  /** Why a source's last sync failed, by source. */
  readonly errors: Partial<Record<ContextSourceDto, string>>;
  /** Syncs a source; the bounty as it then is goes to `onChange`. */
  sync(source: ContextSourceDto): Promise<void>;
}

/**
 * A bounty's sources against their latest sync, read on its page, and the
 * way to sync each. Read again whenever its links change.
 */
export function useBountyContext(
  bounty: BountyDto,
  enabled: boolean,
  onChange: (bounty: BountyDto) => void,
): BountyContextState {
  const userId = useUserId();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: contextKey(userId, bounty),
    enabled,
    queryFn: ({ signal }) =>
      clients.bounties.bountyContext(bounty.organizationId, bounty.id, signal),
  });
  const [syncing, setSyncing] = useState<ContextSourceDto | null>(null);
  const [errors, setErrors] = useState<
    Partial<Record<ContextSourceDto, string>>
  >({});
  const sync = async (source: ContextSourceDto) => {
    setSyncing(source);
    setErrors((current) => ({ ...current, [source]: undefined }));
    try {
      const result = await clients.bounties.syncBountyContext(
        bounty.organizationId,
        bounty.id,
        source,
      );
      queryClient.setQueryData(
        contextKey(userId, result.bounty),
        result.context,
      );
      onChange(result.bounty);
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [source]:
          error instanceof ApiError
            ? error.message
            : "Could not reach the server.",
      }));
    } finally {
      setSyncing(null);
    }
  };
  return {
    status: query.data ?? null,
    loading: enabled && query.isPending,
    syncing,
    errors,
    sync,
  };
}

/** The sources whose own state has moved past their latest sync. */
export function sourcesAhead(
  status: BountyContextResponse | null,
): ContextSourceDto[] {
  if (status === null) return [];
  return (["jira", "github"] as const).filter(
    (source) => status[source].state === "ahead",
  );
}

const STATE_STYLE: Record<BountyContextSourceStatusDto["state"], string> = {
  current: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  ahead: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  unsynced: "bg-muted text-muted-foreground",
  unlinked: "bg-muted text-muted-foreground",
  unavailable: "bg-destructive/10 text-destructive",
};

/** The state's pill: whether the source's sync is in use and up to date. */
function statePill(status: BountyContextSourceStatusDto): string {
  const latest = status.latest;
  switch (status.state) {
    case "current":
      return latest === null ? "Synced" : `Synced ${short(latest.version)}`;
    case "ahead":
      return latest === null ? "Ahead" : `Ahead of ${short(latest.version)}`;
    case "unsynced":
      return "Not synced";
    case "unlinked":
      return "Not in use";
    case "unavailable":
      return "Unavailable";
  }
}

const REASONS: Record<string, string> = {
  reconnect: "Its Jira connection needs reconnecting before it can be read.",
  issue_gone: "Jira no longer returns the issue.",
  jira_unavailable: "Its Jira site is not connected to the workspace.",
  jira_failed: "Jira could not be read just now.",
  repository_gone: "The repository is no longer reachable on GitHub.",
  unconfigured: "GitHub is not set up on this server.",
};

/** What the latest version holds, in a line. */
function holds(status: BountyContextSourceStatusDto): string | null {
  const latest = status.latest;
  if (latest === null) return null;
  if (latest.source === "jira") {
    const { content } = latest;
    const parts = [
      content.issueType,
      content.priority === null ? null : `${content.priority} priority`,
      content.storyPoints === null
        ? null
        : plural(content.storyPoints, "point"),
      content.links.length === 0 ? null : plural(content.links.length, "link"),
    ].filter((part): part is string => part !== null);
    return parts.length === 0 ? "No fields set" : parts.join(" · ");
  }
  const repositories = githubRepositories(latest.content);
  const documents = repositories.reduce(
    (sum, { documents }) => sum + documents.length,
    0,
  );
  const [only] = repositories;
  return repositories.length === 1 && only !== undefined
    ? `${plural(documents, "document")} at ${shortSha(only.commitSha)}`
    : `${plural(documents, "document")} from ${repositories.length} repositories`;
}

/** Why a source is ahead, or why it cannot be synced, in a sentence. */
function aheadText(
  source: ContextSourceDto,
  status: BountyContextSourceStatusDto,
): string | null {
  const latest = status.latest;
  if (status.state !== "ahead" || latest === null) return null;
  const name = status.linked?.ref ?? SOURCE_NAME[source];
  if (source === "jira") {
    return `${name} has changed in Jira since ${short(latest.version)} was synced. Sync to bring the change into the overview.`;
  }
  const since = `since ${short(latest.version)} was synced`;
  const was = commitsOf(latest.revision);
  const now = commitsOf(status.liveRevision ?? "");
  const sameSet =
    status.liveRevision !== null &&
    was.size === now.size &&
    [...now.keys()].every((fullName) => was.has(fullName));
  if (!sameSet)
    return `The workspace's repositories have changed ${since}. Sync to read their documents again.`;
  const moved = [...now].filter(([fullName, sha]) => was.get(fullName) !== sha);
  const [one] = moved;
  if (moved.length === 1 && one !== undefined) {
    const [fullName, sha] = one;
    return `${fullName} has new commits ${since} (${shortSha(was.get(fullName) ?? "")} → ${shortSha(sha)}). Sync to read its documents again.`;
  }
  return `${moved.length} repositories have new commits ${since}. Sync to read their documents again.`;
}

/**
 * Each repository's commit in a GitHub version's revision, which is one
 * `owner/name@sha` line per repository its sync found.
 */
function commitsOf(revision: string): Map<string, string> {
  return new Map(
    revision.split("\n").flatMap((line): [string, string][] => {
      const at = line.lastIndexOf("@");
      return at <= 0 ? [] : [[line.slice(0, at), line.slice(at + 1)]];
    }),
  );
}

/**
 * Under a link's row: whether its sync is in use and up to date, what its
 * latest version holds, and the way to sync it. An ahead source says so,
 * and what syncing does about it.
 */
export function ContextSync({
  source,
  context,
  canSync,
}: {
  source: ContextSourceDto;
  context: BountyContextState;
  /** False while the source cannot be synced, such as with no link. */
  canSync: boolean;
}) {
  const status = context.status?.[source] ?? null;
  const [open, setOpen] = useState(false);
  const busy = context.syncing === source;
  const error = context.errors[source] ?? null;
  const unsyncedNote =
    status?.state === "unsynced"
      ? status.latest === null
        ? "Sync to add what it says to sizing and the sandbox."
        : `Its last sync, ${short(status.latest.version)}, was from ${status.latest.ref}. Sync to read this one.`
      : null;
  const line =
    status === null
      ? context.loading
        ? "Reading where it stands…"
        : null
      : status.state === "unavailable"
        ? (REASONS[status.reason ?? ""] ?? "It cannot be read just now.")
        : status.state === "unlinked"
          ? source === "jira"
            ? "Link an issue to sync its fields into the bounty."
            : "Connect a repository to the workspace to sync its documents into the bounty."
          : (unsyncedNote ?? holds(status));
  const warning = status === null ? null : aheadText(source, status);
  return (
    <div
      className="flex flex-col gap-2 border-t border-dashed pt-3"
      data-testid={`${source}-context`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          className={cn(
            "rounded-[4px] px-1.5 py-px text-[11px] leading-4 font-medium whitespace-nowrap",
            status === null ? STATE_STYLE.unsynced : STATE_STYLE[status.state],
          )}
        >
          {status === null ? "Context" : statePill(status)}
        </span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
          {line}
        </span>
        {status?.latest != null &&
          (status.state === "current" || status.state === "ahead") && (
            // Left out on a narrow screen, where it would crowd out what the
            // version holds.
            <span className="text-muted-foreground hidden text-xs whitespace-nowrap sm:inline">
              Checked{" "}
              <time dateTime={status.latest.checkedAt}>
                {dateTime(status.latest.checkedAt)}
              </time>
            </span>
          )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2.5 text-xs"
          disabled={!canSync || busy || status?.state === "unlinked"}
          aria-label={`Sync ${SOURCE_NAME[source]} context`}
          onClick={() => void context.sync(source)}
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          {busy ? "Syncing…" : "Sync"}
        </Button>
      </div>
      {warning !== null && (
        <p
          role="status"
          className="flex items-start gap-2 text-xs text-amber-900 dark:text-amber-200"
        >
          <TriangleAlert
            aria-hidden
            className="mt-px size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
          />
          {warning}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      {status?.latest != null && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex w-fit cursor-pointer items-center gap-1 rounded-sm text-xs focus-visible:ring-[3px] focus-visible:outline-none"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronDown
              aria-hidden
              className={cn(
                "size-3.5 transition-transform",
                !open && "-rotate-90",
              )}
            />
            What {short(status.latest.version)} adds
          </button>
          {open && <ContextDetails status={status} />}
        </div>
      )}
    </div>
  );
}

/** A synced version's content, as a reader checks what sizing was shown. */
function ContextDetails({ status }: { status: BountyContextSourceStatusDto }) {
  const latest = status.latest;
  if (latest === null) return null;
  if (latest.source === "github") {
    const repositories = githubRepositories(latest.content);
    const unread = "unread" in latest.content ? latest.content.unread : [];
    const several = repositories.length > 1;
    const omitted = repositories.reduce((sum, { omitted }) => sum + omitted, 0);
    const documents = repositories.flatMap(({ fullName, documents }) =>
      documents.map((document) => ({ fullName, document })),
    );
    return (
      <div className="bg-muted/40 flex flex-col gap-1 rounded-md px-3 py-2 text-xs">
        {documents.length === 0 ? (
          <span className="text-muted-foreground">
            No documents were found to read.
          </span>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {documents.map(({ fullName, document }) => (
              <li
                key={`${fullName}:${document.path}`}
                className="flex justify-between gap-3"
              >
                <span className="truncate font-mono">
                  {several ? `${fullName}: ${document.path}` : document.path}
                </span>
                <span className="text-muted-foreground whitespace-nowrap">
                  {document.truncated
                    ? "cut short"
                    : plural(document.text.length, "char")}
                </span>
              </li>
            ))}
          </ul>
        )}
        {omitted > 0 && (
          <span className="text-muted-foreground">
            {plural(omitted, "more document")} left out for length.
          </span>
        )}
        {unread.length > 0 && (
          <span className="text-muted-foreground">
            Not read yet: {unread.join(", ")}.
          </span>
        )}
      </div>
    );
  }
  const { content } = latest;
  const hours = (seconds: number | null) =>
    seconds === null ? null : `${Math.round((seconds / 3600) * 10) / 10}h`;
  const rows: [string, string | null][] = [
    ["Type", content.issueType],
    ["Status", content.status],
    ["Priority", content.priority],
    [
      "Story points",
      content.storyPoints === null ? null : String(content.storyPoints),
    ],
    ["Estimate", hours(content.originalEstimateSeconds)],
    ["Remaining", hours(content.remainingEstimateSeconds)],
    ["Due", content.dueDate],
    ["Labels", content.labels.join(", ") || null],
    ["Components", content.components.join(", ") || null],
    ["Releases", content.fixVersions.join(", ") || null],
    [
      "Links",
      content.links.length === 0
        ? null
        : content.links
            .map(
              ({ type, key, done }) =>
                `${type} ${key ?? "an issue"}${done ? " (done)" : ""}`,
            )
            .join(", "),
    ],
    [
      "Sub-tasks",
      content.subtaskCount === 0 ? null : String(content.subtaskCount),
    ],
    [
      "Votes",
      content.votes === null || content.votes === 0
        ? null
        : String(content.votes),
    ],
    [
      "Watchers",
      content.watchers === null || content.watchers === 0
        ? null
        : String(content.watchers),
    ],
  ];
  const shown = rows.filter((row): row is [string, string] => row[1] !== null);
  return (
    <dl className="bg-muted/40 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 rounded-md px-3 py-2 text-xs">
      {shown.length === 0 ? (
        <dd className="text-muted-foreground col-span-2">No fields set.</dd>
      ) : (
        shown.map(([name, value]) => (
          <div key={name} className="contents">
            <dt className="text-muted-foreground">{name}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))
      )}
    </dl>
  );
}

/** One source's version on a step's context line. */
function SourceVersion({
  source,
  name,
  version,
  drift,
}: {
  source: ContextSourceDto;
  /** What the source is called, when known. */
  name: string | null;
  version: number | null;
  /** Set when the step is behind the overview on this source. */
  drift: StageDrift | null;
}) {
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5"
      data-testid={`context-${source}`}
    >
      <SourceIcon source={source} />
      <span className="truncate">{name ?? SOURCE_NAME[source]}</span>
      <span
        className={cn(
          "rounded-[4px] px-1.5 py-px font-mono text-[11px] leading-4 font-medium",
          drift !== null
            ? "bg-amber-500/15 text-amber-800 dark:text-amber-300"
            : version === null
              ? "bg-muted text-muted-foreground"
              : "bg-muted text-foreground",
        )}
      >
        {version === null ? "none" : short(version)}
      </span>
      {drift !== null && (
        <TriangleAlert
          aria-label="behind"
          className="size-3.5 text-amber-600 dark:text-amber-400"
        />
      )}
    </span>
  );
}

/**
 * Which context versions a step stands on, in a line: the overview's held
 * versions, or those the bounty was sized and the sandbox generated with.
 * A source the step is behind the overview on is marked.
 */
export function StepContext({
  label,
  versions,
  held,
  names,
}: {
  /** What the step did with them: "Holds", "Sized with", "Generated with". */
  label: string;
  versions: ContextVersionsDto;
  /** The overview's; absent for the overview itself. */
  held?: ContextVersionsDto;
  names: { readonly jira: string | null; readonly github: string | null };
}) {
  const drift =
    held === undefined
      ? { jira: null, github: null }
      : contextDrift(held, versions);
  return (
    <div
      className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs"
      data-testid="step-context"
    >
      <span>{label} context</span>
      {(["jira", "github"] as const).map((source) => (
        <SourceVersion
          key={source}
          source={source}
          name={names[source]}
          version={versions[source]}
          drift={drift[source]}
        />
      ))}
    </div>
  );
}

/**
 * A warning at the top of the bounty's or the sandbox's page once the
 * overview holds newer context than the step was made with, with what to do.
 */
export function ContextLineage({
  step,
  versions,
  held,
  remedy,
}: {
  step: "bounty" | "sandbox";
  versions: ContextVersionsDto;
  held: ContextVersionsDto;
  remedy: string;
}) {
  const drift = contextDrift(held, versions);
  const behind = (["jira", "github"] as const).filter(
    (source) => drift[source] !== null,
  );
  if (behind.length === 0) return null;
  const made = step === "bounty" ? "Sized with" : "Generated with";
  const parts: ReactNode[] = behind.map((source) => {
    const found = drift[source];
    if (found === null) return null;
    return (
      <span key={source}>
        {SOURCE_NAME[source]} {found.uses === null ? "none" : short(found.uses)}
        , now {short(found.current)}
      </span>
    );
  });
  return (
    <div
      role="status"
      data-testid={`${step}-context-lineage`}
      className="flex items-start gap-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-900 dark:text-amber-200"
    >
      <TriangleAlert
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
      />
      <p>
        <span className="font-medium">
          The overview's context has moved ahead.
        </span>{" "}
        {made} older context than it holds:{" "}
        {parts.map((part, index) => (
          <span key={index}>
            {index > 0 && "; "}
            {part}
          </span>
        ))}
        . {remedy}
      </p>
    </div>
  );
}

/** Whether a step is behind the overview's context on any source. */
export function contextBehind(
  held: ContextVersionsDto,
  versions: ContextVersionsDto | undefined,
): boolean {
  if (versions === undefined) return false;
  const drift = contextDrift(held, versions);
  return drift.jira !== null || drift.github !== null;
}
