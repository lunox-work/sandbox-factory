/**
 * A board's backlog scan: the tickets worth outsourcing, found for free.
 *
 * The first thing a connected board shows. Every open ticket is classified
 * against the six categories by rules over its metadata — age, sprints,
 * votes, links, due date — through the board's `backlog-preview`, which
 * makes no model call and stores nothing. So within seconds of connecting
 * Jira a person sees how much of their backlog is the kind of work teams
 * outsource, by kind, with the tickets themselves.
 *
 * **Sizing is offered one ticket at a time.** The ticket in focus is shown
 * as a bounty-to-be: what sizing will write (a size, a price on the rate
 * card, acceptance scenarios, a sandbox) with the parts only a model can
 * fill left as placeholders, and one button that fills them. Sizing is the
 * slow, paid step, so it is the person's choice and it is one call; the
 * whole board can still be sized on request, with the cost said first.
 *
 * A sized ticket opens as its bounty, on the Bounty tab of its page, where
 * its proposal is. A page that shows the scan over a list of its own may
 * fold it to one line (`foldable`), opened again on demand.
 */

import { ApiError } from "@sandbox-factory/client";
import type { JiraBacklogPreviewDto } from "@sandbox-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Loader2, RefreshCw, ScanSearch } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import { DEFAULT_RATE_CARD } from "sandbox-factory";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorBanner } from "@/components/Message";
import { Button } from "@/components/ui/button";

import { CategoryIcon } from "../../CategoryIcon";
import { clients, queryKeys, useUserId } from "../../data/query";
import { plural } from "../../lib/format";
import { SECTION } from "../../lib/reveal";
import { candidatesIn, openingCategory, scanSummary } from "./insights";
import {
  TeaserBounty,
  type RepositoryAction,
  type ScanRepository,
} from "./TeaserBounty";

type PreviewIssue = JiraBacklogPreviewDto["issues"][number];

/**
 * A scan reads the whole board from Jira, so it is kept for a while rather
 * than read again on every visit to home. Rescan reads it now.
 */
export const SCAN_STALE_MS = 5 * 60_000;

/** Rows shown before "Show more": enough to compare, few enough to scan. */
const VISIBLE_ROWS = 6;

/**
 * Below `lg` the teaser sits under the list rather than beside it, so a
 * tapped row would change something off screen. It is brought into view
 * instead; beside the list it is already in view and nothing moves.
 */
function revealTeaser(teaser: HTMLElement | null) {
  if (
    typeof window.matchMedia !== "function" ||
    window.matchMedia("(min-width: 1024px)").matches
  )
    return;
  teaser?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
}

export type { RepositoryAction, ScanRepository } from "./TeaserBounty";

export function BacklogScan({
  organizationId,
  organizationSlug,
  boardId,
  canManage,
  repository,
  repositoryAction,
  foldable = false,
}: {
  organizationId: string;
  /** The workspace's handle: a sized ticket opens as its bounty there. */
  organizationSlug: string;
  boardId: string;
  /** Owner or admin: may size a ticket or the board. */
  canManage: boolean;
  /** The board's linked repository, or null. */
  repository: ScanRepository | null;
  /** How a board with no repository gets one. */
  repositoryAction?: RepositoryAction | undefined;
  /** The board has proposals: the scan starts as one line above them. */
  foldable?: boolean;
}) {
  const userId = useUserId();
  const cache = useQueryClient();
  const headingId = useId();
  const [open, setOpen] = useState(!foldable);
  const preview = useQuery({
    queryKey: queryKeys.resource(
      userId,
      organizationId,
      "jira-preview",
      boardId,
    ),
    queryFn: ({ signal }) =>
      clients.jira.preview(organizationId, boardId, signal),
    staleTime: SCAN_STALE_MS,
  });
  // The board's runs, as the proposal list reads them: whether sizing is
  // configured here, and whether the board is being sized already.
  const runs = useQuery({
    queryKey: queryKeys.resource(userId, organizationId, "board-runs", boardId),
    queryFn: ({ signal }) => clients.runs.runs(organizationId, boardId, signal),
  });
  const rateCard = useQuery({
    queryKey: queryKeys.resource(userId, organizationId, "rate-card"),
    queryFn: ({ signal }) => clients.pricing.rateCard(organizationId, signal),
  });

  const [category, setCategory] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  /*
    The ticket being sized, if one is. Its teaser follows the run and opens
    the proposal when it lands, so it stays on screen until then: the list
    is held, and changing category leaves it in place.
  */
  const [sizingId, setSizingId] = useState<string | null>(null);
  const teaser = useRef<HTMLElement>(null);

  const data = preview.data;
  const summary = data === undefined ? null : scanSummary(data);
  // The category on screen: the one chosen, or the one the scan opens on.
  const shown =
    data === undefined ? null : (category ?? openingCategory(data) ?? null);
  // Nothing left to size by category: the scan lists what the API fell
  // back to, the oldest tickets that fit none, if it found any.
  const noneToSize = summary?.candidates === 0;
  const listed =
    data === undefined
      ? []
      : noneToSize
        ? data.issues
        : shown === null
          ? []
          : candidatesIn(data, shown);
  const focus =
    (sizingId === null
      ? undefined
      : data?.issues.find(({ id }) => id === sizingId)) ??
    listed.find(({ id }) => id === focusId) ??
    listed[0] ??
    undefined;
  const sizingAvailable = runs.data?.sizingAvailable ?? true;
  const boardRun = runs.data?.runs.find(
    (run) =>
      run.kind === "backlog" &&
      (run.status === "queued" || run.status === "running"),
  );

  /** After sizing lands: the lists that hold proposals, read again. */
  const sized = async () => {
    await Promise.all(
      [
        "proposals",
        "proposal-categories",
        "board-runs",
        "jira-preview",
        "bounties",
      ].map((resource) =>
        cache.invalidateQueries({
          queryKey: queryKeys.resource(userId, organizationId, resource),
        }),
      ),
    );
  };

  const headline = scanHeadline(data, summary);

  if (foldable && !open) {
    return (
      <button
        type="button"
        id={SECTION.backlogScan}
        data-testid="backlog-scan"
        onClick={() => setOpen(true)}
        className="text-muted-foreground hover:text-foreground hover:bg-muted/50 focus-visible:ring-ring/50 flex w-full items-center gap-2 rounded-lg border border-dashed px-3 py-2.5 text-left text-sm transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
      >
        <ScanSearch className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {summary === null
            ? "Backlog scan"
            : summary.candidates > 0
              ? `Backlog scan: ${plural(summary.candidates, "more ticket")} worth outsourcing`
              : summary.proposed > 0
                ? "Backlog scan: every ticket that fits is sized"
                : "Backlog scan: nothing fits a pattern yet"}
        </span>
        <ChevronDown className="size-4 shrink-0" />
      </button>
    );
  }

  return (
    <section
      aria-labelledby={headingId}
      id={SECTION.backlogScan}
      data-testid="backlog-scan"
      className="flex flex-col gap-4"
    >
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2
            id={headingId}
            className="flex items-center gap-2 text-base font-semibold tracking-tight"
          >
            <ScanSearch className="text-muted-foreground size-4 shrink-0" />
            {headline.title}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            {headline.detail}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {foldable && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setOpen(false)}
            >
              Fold
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground size-8"
            aria-label="Scan again"
            title="Scan again"
            disabled={preview.isFetching}
            onClick={() => void preview.refetch()}
          >
            <RefreshCw className={preview.isFetching ? "animate-spin" : ""} />
          </Button>
        </div>
      </header>

      {preview.isError ? (
        <ErrorBanner className="mt-0">
          {preview.error instanceof ApiError &&
          preview.error.code === "reconnect"
            ? "This Jira site needs reconnecting before its backlog can be scanned."
            : "Could not scan this board's backlog."}
        </ErrorBanner>
      ) : data === undefined ? (
        <ScanSkeleton />
      ) : (
        <>
          {!noneToSize && (
            <CategoryTiles
              preview={data}
              selected={shown}
              onSelect={(id) => {
                setCategory(id);
                setFocusId(null);
                setShowAll(false);
              }}
            />
          )}
          {!noneToSize &&
            (() => {
              const active = data.categories.find(({ id }) => id === shown);
              return active === undefined ? null : (
                <p
                  className="text-muted-foreground -mt-1 text-xs"
                  data-testid="scan-why"
                >
                  <span className="text-foreground font-medium">
                    {active.label}.
                  </span>{" "}
                  {active.why}
                  {active.looksFor !== undefined && (
                    <span className="text-muted-foreground/80">
                      {" "}
                      Looks for: {active.looksFor.toLowerCase()}.
                    </span>
                  )}
                </p>
              );
            })()}
          {listed.length > 0 && (
            <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
              <div className="overflow-hidden rounded-lg border">
                <ul className="divide-y" data-testid="scan-candidates">
                  {(showAll ? listed : listed.slice(0, VISIBLE_ROWS)).map(
                    (issue) => (
                      <CandidateRow
                        key={issue.id}
                        issue={issue}
                        category={noneToSize ? null : shown}
                        focused={issue.id === focus?.id}
                        held={sizingId !== null && issue.id !== sizingId}
                        onFocus={() => {
                          setFocusId(issue.id);
                          revealTeaser(teaser.current);
                        }}
                      />
                    ),
                  )}
                </ul>
                {!showAll && listed.length > VISIBLE_ROWS && (
                  <div className="flex justify-center border-t px-3 py-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowAll(true)}
                    >
                      Show {listed.length - VISIBLE_ROWS} more
                    </Button>
                  </div>
                )}
              </div>
              {focus !== undefined && (
                <TeaserBounty
                  // Keyed by the ticket, so a sizing message for one ticket
                  // does not stay on screen for the next.
                  key={focus.id}
                  ref={teaser}
                  organizationId={organizationId}
                  organizationSlug={organizationSlug}
                  boardId={boardId}
                  issue={focus}
                  canManage={canManage}
                  sizingAvailable={sizingAvailable}
                  boardBusy={boardRun !== undefined}
                  repository={repository}
                  repositoryAction={repositoryAction}
                  range={
                    rateCard.data === undefined
                      ? undefined
                      : (rateCard.data ?? DEFAULT_RATE_CARD)
                  }
                  onSized={sized}
                  onSizing={setSizingId}
                />
              )}
            </div>
          )}
          {canManage &&
            sizingAvailable &&
            !noneToSize &&
            summary !== null &&
            summary.candidates > 1 && (
              <SizeAll
                organizationId={organizationId}
                boardId={boardId}
                count={summary.candidates}
                running={boardRun !== undefined}
                onStarted={sized}
              />
            )}
        </>
      )}
    </section>
  );
}

/**
 * What the scan says above its list. "Nothing to size" has two causes the
 * person needs told apart: nothing on the board fits a category, or
 * everything that does is sized already.
 */
function scanHeadline(
  data: JiraBacklogPreviewDto | undefined,
  summary: ReturnType<typeof scanSummary> | null,
): { title: string; detail: ReactNode } {
  if (data === undefined || summary === null)
    return {
      title: "Scanning the backlog…",
      detail: "Reading ticket metadata from Jira. No AI, nothing stored.",
    };
  const atLeast = summary.partial ? "At least " : "";
  if (summary.candidates > 0)
    return {
      title: `${plural(summary.candidates, "ticket")} worth outsourcing`,
      detail: (
        <>
          {atLeast}
          {summary.fitting} of {plural(summary.scanned, "open ticket")} fit a
          pattern teams outsource
          {summary.proposed > 0 && `, ${summary.proposed} already sized`}. Read
          from ticket metadata — no AI, nothing stored.
        </>
      ),
    };
  if (summary.scanned === 0)
    return {
      title: "No open tickets to scan",
      detail: "When this board has open tickets, the scan sorts them here.",
    };
  // An API from before `fallback` lists the oldest only when it fell back.
  const oldest = data.fallback ?? data.issues.length > 0;
  const rest = oldest
    ? " The oldest of the rest are below — still worth a look."
    : "";
  return summary.proposed > 0
    ? {
        title: "Every ticket that fits is sized",
        detail: `${atLeast}${summary.proposed} of ${plural(summary.scanned, "open ticket")} fit a pattern teams outsource, and all of them are sized.${rest}`,
      }
    : {
        title: "Nothing fits a pattern yet",
        detail: `None of ${plural(summary.scanned, "open ticket")} matched the six patterns.${oldest ? " The oldest are below — still worth a look." : ""}`,
      };
}

function ScanSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="skeleton h-[4.25rem] rounded-lg" />
        ))}
      </div>
      <div className="skeleton h-40 rounded-lg" />
    </div>
  );
}

/**
 * The board's enabled categories, each with how many of its tickets fit it.
 * In the registry's order, an empty one shown but not pressable, so a tile
 * does not move as tickets are sized. A category the board's settings turn
 * off has no tile: the scan does not look for it.
 */
function CategoryTiles({
  preview,
  selected,
  onSelect,
}: {
  preview: JiraBacklogPreviewDto;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <ul
      aria-label="Kinds of work"
      className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6"
      data-testid="scan-categories"
    >
      {preview.categories
        .filter(({ enabled }) => enabled)
        .map((category) => {
          // Tickets still to size: a category whose every ticket is sized
          // has nothing here to show.
          const count = candidatesIn(preview, category.id).length;
          const pressed = category.id === selected;
          return (
            <li key={category.id}>
              <button
                type="button"
                aria-pressed={pressed}
                aria-label={`${category.label}, ${plural(count, "ticket")}`}
                title={category.why}
                disabled={count === 0}
                onClick={() => onSelect(category.id)}
                className={`focus-visible:ring-ring/50 flex h-full w-full flex-col items-start gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:ring-[3px] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45 ${
                  pressed
                    ? "bg-muted border-foreground/30"
                    : "hover:bg-muted/50"
                }`}
              >
                <span className="flex w-full items-start justify-between gap-2">
                  <span className="text-lg leading-none font-semibold tabular-nums">
                    {count}
                  </span>
                  <CategoryIcon
                    category={category.id}
                    className={`size-4 shrink-0 ${pressed ? "text-foreground" : "text-muted-foreground"}`}
                  />
                </span>
                <span
                  className={`text-xs leading-tight ${pressed ? "text-foreground font-medium" : "text-muted-foreground"}`}
                >
                  {category.label}
                </span>
              </button>
            </li>
          );
        })}
    </ul>
  );
}

function CandidateRow({
  issue,
  category,
  focused,
  held,
  onFocus,
}: {
  issue: PreviewIssue;
  /** The category the list is showing, whose reason the row gives. */
  category: string | null;
  focused: boolean;
  /** Another ticket is being sized, and stays in focus until it lands. */
  held: boolean;
  onFocus: () => void;
}) {
  // The reason says how long it has been open where that is the case, so
  // the row carries no age of its own to repeat it.
  const match =
    (issue.categories ?? []).find(({ id }) => id === category) ??
    issue.categories?.[0];
  return (
    <li>
      <button
        type="button"
        aria-current={focused ? "true" : undefined}
        disabled={held}
        onClick={onFocus}
        className={`hover:bg-muted/50 focus-visible:bg-muted/50 flex w-full flex-col gap-0.5 px-3 py-2.5 text-left transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-60 sm:flex-row sm:items-start sm:gap-3 ${focused ? "bg-muted" : ""}`}
      >
        <span className="text-muted-foreground shrink-0 pt-px font-mono text-xs sm:w-20">
          {issue.key}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm sm:truncate">{issue.summary}</span>
          <span className="text-muted-foreground text-xs sm:truncate">
            {match?.reason ?? issue.issueType}
          </span>
        </span>
      </button>
    </li>
  );
}

/** Every candidate at once, with what that costs said before it starts. */
function SizeAll({
  organizationId,
  boardId,
  count,
  running,
  onStarted,
}: {
  organizationId: string;
  boardId: string;
  count: number;
  running: boolean;
  onStarted: () => Promise<void>;
}) {
  if (running)
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-xs">
        <Loader2 className="size-3.5 animate-spin" />
        Sizing this board&rsquo;s candidates. Proposals appear below as each one
        lands.
      </p>
    );
  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <ConfirmDialog
        tone="default"
        trigger={
          <Button variant="outline" size="sm">
            Size all {count}
          </Button>
        }
        title={`Size ${plural(count, "ticket")}?`}
        description={
          <>
            Each ticket is one model call, run in the background — a few minutes
            for a board this size — and priced on your rate card. Tickets
            already sized are skipped. Sizing one ticket first is a cheaper way
            to see what you get.
          </>
        }
        confirmLabel={`Size ${plural(count, "ticket")}`}
        pendingLabel="Starting…"
        onConfirm={async () => {
          try {
            await clients.runs.start(
              organizationId,
              boardId,
              crypto.randomUUID(),
            );
            await onStarted();
          } catch (error) {
            return error instanceof ApiError
              ? error.message
              : "Could not reach the server.";
          }
        }}
      />
      <span>One model call per ticket.</span>
    </div>
  );
}
