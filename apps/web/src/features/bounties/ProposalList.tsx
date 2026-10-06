import { ApiError } from "@sandbox-factory/client";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { rankAtLeast } from "sandbox-factory";
import { terminalRun, useObservation } from "../../data/observe";
import { clients, queryKeys, useUserId } from "../../data/query";
import { money } from "../../lib/format";
import { pushLocation, subscribeLocation } from "../../navigation/location";
import { categoryFromUrl, CategoryLine, CategoryNav } from "./Categories";
import { useProposalMutations } from "./mutations";
import { capitalize, unweighed } from "./presentation";
import { ProposalPeek } from "./ProposalPeek";
import { useProposalResources } from "./queries";
import { SizingStream } from "./SizingProgress";
import { IssueSearch } from "./IssueSearch";
import { type EnrichedProposal } from "./types";
import { useProposalTitles } from "./useProposalTitles";
export { RateCardEditor } from "../../features/pricing/RateCardEditor";
export { modelLabel, money } from "../../lib/format";

import { ErrorBanner, LoadingLine } from "@/components/Message";
import { PeekPanel } from "@/components/PeekPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import type { JiraIssueDetail } from "../../useJira";

function canManage(role: string): boolean {
  return rankAtLeast(role, "admin");
}

/**
 * Proposals, and the peek a reviewer decides them in: one board's, or with
 * no board the organization's, from every source — imported from Jira and
 * written here alike.
 *
 * A board's list has the board's machinery around it: its sizing run as it
 * streams, the search for one of its issues to add, and each row's live
 * title from Jira. The organization's list reads stored rows only, since a
 * bounty's title is stored with it, and each proposal's freshness comes
 * from its own read as on a board.
 */
export function ProposalList({
  organizationId,
  boardId,
  role,
  writeGranted = true,
  readIssue,
  emptyText,
}: {
  organizationId: string;
  /** The board whose proposals these are; absent, the organization's. */
  boardId?: string | undefined;
  role: string;
  /**
   * Whether this board's site holds the write grant. Shown, not switched:
   * the permission is asked for when a site is connected, and a site
   * without it is connected again from the Jira page to grant it.
   */
  writeGranted?: boolean | undefined;
  /**
   * Reads one bounty live from Jira, for the peek's Spec tab. Passed in
   * rather than fetched here because the board page owns the Jira read and
   * the reconnect banner that answers its failures. Absent, the tab shows
   * the bounty as the proposal's own read returned it.
   */
  readIssue?:
    ((issueKey: string) => Promise<JiraIssueDetail | null>) | undefined;
  /** What an empty list says, in place of the board's wording. */
  emptyText?: string | undefined;
}) {
  const [category, setCategory] = useState<string | null>(categoryFromUrl);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("proposal"),
  );
  /*
    The bounty behind the open proposal, read live for the Spec tab.

    Read when the peek opens rather than when the tab is pressed, so the
    switch to Spec is instant. `wantedKey` is what stops a slow read for one
    bounty landing in a peek that has since moved to another — or closed:
    neither `bounty` nor the selection can be read inside the resolve, both
    are stale by then, so the check is against what was last asked for.
  */
  const [bounty, setBounty] = useState<JiraIssueDetail | null>(null);
  const [bountyError, setBountyError] = useState<string | null>(null);
  const wantedKey = useRef<string | null>(null);

  /*
    Live titles, by proposal id, as the titles stream reports them. Kept
    across list refreshes, so a refresh asks Jira only about rows it has not
    titled yet: after an approval or a landed run result, usually none or
    one. `titleRequests` holds the ids a stream is out for, so a row is never
    asked for twice at once; `titlesPending` is the same set as state, for
    the placeholder.

    `titled` repeats the map's keys in a ref, and is what decides whether
    to ask. An effect can run after the stream that answered a row has
    already let go of it, while its render's `titles` predates that
    answer; checked against state, the row would be asked for again.
  */
  const base = `/api/v1/orgs/${encodeURIComponent(organizationId)}`;
  const boardPath =
    boardId === undefined
      ? null
      : `${base}/jira/boards/${encodeURIComponent(boardId)}`;
  /*
    Runs and stored proposals: both local reads, so the list renders as soon
    as they land. Nothing here waits on Jira — titles stream in below, and
    the open proposal's freshness comes from its own read — and nothing here
    depends on which proposal is open, so opening one does not re-read it.
  */
  const resources = useProposalResources(
    organizationId,
    boardId,
    category,
    selectedId,
  );
  const proposals = useMemo(
    () => resources.list.data?.pages.flatMap((page) => page.proposals) ?? [],
    [resources.list.data],
  );
  const { titles, titlesPending } = useProposalTitles(boardPath, proposals);
  const runs = resources.runs.data?.runs ?? [];
  const sizingAvailable = resources.runs.data?.sizingAvailable ?? true;
  const moreProposals = resources.list.hasNextPage;
  const loadingMore = resources.list.isFetchingNextPage;
  const loading =
    resources.list.isPending ||
    (boardId !== undefined && resources.runs.isPending);
  const switching = resources.list.isFetching;
  const categories = resources.categories.data ?? null;
  const detail = selectedId === null ? null : (resources.detail.data ?? null);
  const detailFailure =
    resources.detail.isError && selectedId !== null
      ? {
          id: selectedId,
          notFound:
            resources.detail.error instanceof ApiError &&
            resources.detail.error.status === 404,
        }
      : null;
  const resourceError =
    resources.list.isError || resources.runs.isError
      ? "Could not load bounty runs and proposals."
      : null;
  const { busy, error, mutate } = useProposalMutations(
    organizationId,
    resources,
  );
  const refresh = resources.refresh;
  const showMore = async () => {
    await resources.list.fetchNextPage();
  };
  const cache = useQueryClient();
  const userId = useUserId();

  /*
    Titles for the rows that have none yet. Each row fills in as its line
    arrives rather than when the slowest bounty answers. A row the stream
    ended without is left untitled and unrecorded, so the next refresh asks
    for it again.

    One stream for all of them, up to what the route accepts in one request;
    a list holding more untitled rows than that opens a stream per batch.
  */
  // The board's own sizing run. A one-bounty run someone added is followed
  // by the search or the bounty that started it, and a change to one
  // proposal's spec by the proposal's peek: none is the board's stream.
  const active = runs.find(
    (run) =>
      run.kind !== "issue" &&
      run.kind !== "respec" &&
      run.kind !== "bounty" &&
      (run.status === "queued" || run.status === "running"),
  );
  // A one-ticket run in flight, which the search follows after a reload.
  const issueRun = runs.find(
    (run) =>
      run.kind === "issue" &&
      (run.status === "queued" || run.status === "running"),
  );
  /*
    While a run is active, the run alone is polled, every second: it is one
    local read, and it carries the plan and each result as it lands. The
    full re-read — which checks every proposal against Jira — runs only when
    a result has landed or the run has ended, so the list catches up
    without Jira being asked about the whole board every second.
  */
  const activeId = active?.id;
  const tracking = useObservation({
    owner: organizationId,
    resource: "run",
    id: activeId,
    read: (id, signal) => clients.runs.run(organizationId, id, signal),
    terminal: terminalRun,
    interval: 1000,
    startDelay: 1000,
  });
  const seenOutcomes = useRef<string | null>(null);
  useEffect(() => {
    const run = tracking.data;
    if (run === undefined) return;
    cache.setQueryData<Awaited<ReturnType<typeof clients.runs.runs>>>(
      queryKeys.resource(userId, organizationId, "board-runs", boardId),
      (current) =>
        current === undefined
          ? current
          : {
              ...current,
              runs: current.runs.map((row) => (row.id === run.id ? run : row)),
            },
    );
    const version = `${run.id}:${run.status}:${run.outcomes.length}`;
    if (seenOutcomes.current !== version) {
      seenOutcomes.current = version;
      void refresh();
    }
  }, [tracking.data, cache, userId, organizationId, boardId, refresh]);

  /*
    `?proposal=<id>` is the open peek, so a reload or a shared link lands on
    the same proposal, and the browser's back button closes it — the same
    contract the backlog peek had with `?issue`.
  */
  const openProposal = useCallback((proposalId: string) => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("proposal") !== proposalId) {
      params.set("proposal", proposalId);
      pushLocation(
        `${window.location.pathname}?${params.toString()}${window.location.hash}`,
      );
    }
    setSelectedId(proposalId);
  }, []);

  // A proposal the bounty search produced: the list re-read so it has the
  // row, then opened. Stable, because the search follows a run with it.
  const showProposal = useCallback(
    async (proposalId: string) => {
      await refresh();
      openProposal(proposalId);
    },
    [refresh, openProposal],
  );

  const closeProposal = useCallback((updateUrl: boolean) => {
    setSelectedId(null);
    if (updateUrl) {
      const params = new URLSearchParams(window.location.search);
      if (params.has("proposal")) {
        params.delete("proposal");
        const query = params.toString();
        pushLocation(
          window.location.pathname +
            (query === "" ? "" : `?${query}`) +
            (window.location.hash ?? ""),
        );
      }
    }
  }, []);

  /** Narrow the list to one category, or to none. */
  const selectCategory = useCallback((next: string | null) => {
    const params = new URLSearchParams(window.location.search);
    if ((params.get("category") ?? null) === next) return;
    if (next === null) params.delete("category");
    else params.set("category", next);
    const query = params.toString();
    pushLocation(
      window.location.pathname +
        (query === "" ? "" : `?${query}`) +
        (window.location.hash ?? ""),
    );
    setCategory(next);
  }, []);

  useEffect(() => {
    const sync = () => {
      const next = new URLSearchParams(window.location.search).get("proposal");
      if (next === null || next === "") closeProposal(false);
      else setSelectedId(next);
      // Back and forward move between category views too.
      setCategory(categoryFromUrl());
    };
    return subscribeLocation(sync);
  }, [closeProposal]);

  const detailProposal: EnrichedProposal | null =
    detail === null
      ? null
      : {
          ...detail.proposal,
          ...detail.freshness,
          writebackOperations: detail.writebackOperations,
          activeRun: detail.activeRun,
        };
  const visibleProposals =
    detailProposal === null ||
    proposals.some(({ id }) => id === detailProposal.id)
      ? proposals
      : [detailProposal, ...proposals];
  /*
    A row's key and title: live once its line has arrived, and until then
    the title the platform holds for the bounty. The two are nearly always
    the same words, so most rows never change.
  */
  const nameOf = (proposal: EnrichedProposal) => {
    const live = titles[proposal.id];
    return {
      key:
        (live !== undefined && "key" in live ? live.key : undefined) ??
        proposal.liveKey ??
        proposal.issueKey,
      title:
        (live !== undefined && "title" in live ? live.title : undefined) ??
        proposal.liveTitle ??
        (proposal.title === "" ? undefined : proposal.title),
      pending: titlesPending.has(proposal.id),
    };
  };
  const selectedRow =
    selectedId === null
      ? null
      : (visibleProposals.find(({ id }) => id === selectedId) ?? null);
  /*
    The open proposal: its stored row, with what only its detail knows —
    freshness, the live title, delivery — laid over it once that arrives.
    The row stays the word on stored fields, as it was before the detail
    was read separately. Freshness is only ever the detail's, so until it
    lands the peek says Jira is being checked, and a failed read says it
    was not.
  */
  const selectedView: EnrichedProposal | null =
    selectedRow === null
      ? null
      : detail !== null && detail.proposal.id === selectedRow.id
        ? {
            ...selectedRow,
            ...detail.freshness,
            writebackOperations: detail.writebackOperations,
            activeRun: detail.activeRun,
          }
        : detailFailure !== null && detailFailure.id === selectedRow.id
          ? { ...selectedRow, freshness: "unknown" }
          : selectedRow;
  const selectedName = selectedView === null ? null : nameOf(selectedView);
  const selected: EnrichedProposal | null =
    selectedView === null || selectedName === null
      ? null
      : {
          ...selectedView,
          ...(selectedName.key === null ? {} : { liveKey: selectedName.key }),
          ...(selectedName.title === undefined
            ? {}
            : { liveTitle: selectedName.title }),
        };
  const selectedKey = selectedName === null ? null : selectedName.key;

  const loadBounty = useCallback(
    (issueKey: string) => {
      if (readIssue === undefined) return;
      wantedKey.current = issueKey;
      setBounty(null);
      setBountyError(null);
      void readIssue(issueKey).then((result) => {
        if (wantedKey.current !== issueKey) return;
        if (result !== null) setBounty(result);
        else setBountyError("Could not load this ticket from Jira.");
      });
    },
    [readIssue],
  );
  useEffect(() => {
    if (selectedKey === null) {
      wantedKey.current = null;
      setBounty(null);
      setBountyError(null);
      return;
    }
    loadBounty(selectedKey);
  }, [selectedKey, loadBounty]);

  /**
   * One POST, then the page catches up.
   *
   * By default that is a full re-read — runs, list and detail — because an
   * approval or a re-price changes more than the row: the run list, the
   * Jira delivery, the bounty's freshness. A mutation that returns the
   * proposal it changed and touches nothing else can `apply` it instead:
   * the row and the open detail take the proposal from the response, and
   * no request follows. That is what keeps a resize instant, where the
   * re-read would check the open proposal against Jira again.
   */
  if (loading) return <LoadingLine>Loading proposals…</LoadingLine>;

  return (
    <div className="flex flex-col gap-4">
      {(error ?? resourceError) !== null && (
        <ErrorBanner className="mt-0">{error ?? resourceError}</ErrorBanner>
      )}
      {tracking.isError && (
        <ErrorBanner>
          Run tracking failed.{" "}
          <button
            onClick={() => {
              void tracking.refetch();
            }}
          >
            Try again
          </button>
        </ErrorBanner>
      )}

      {canManage(role) && sizingAvailable && boardId !== undefined && (
        <IssueSearch
          base={base}
          boardId={boardId}
          activeRun={issueRun}
          onProposal={showProposal}
        />
      )}

      {/*
        Connecting a site sizes its boards on its own, so the first visit
        usually lands mid-run. Said here, above a list that fills as the
        poll brings proposals in.
      */}
      {active !== undefined && (
        <SizingStream
          run={active}
          proposals={visibleProposals}
          onOpen={openProposal}
        />
      )}

      {/* A warning only when there is something to warn about. */}
      {(!sizingAvailable || !writeGranted) && (
        <div className="text-muted-foreground flex flex-col gap-1 text-xs">
          {!sizingAvailable && (
            <p>Sizing is not configured for this deployment.</p>
          )}
          {!writeGranted && (
            <p
              className="text-amber-700 dark:text-amber-400"
              data-testid="jira-writeback"
            >
              Approvals stay here: this site was connected without write access.
              Connect it again from the Jira page to grant it.
            </p>
          )}
        </div>
      )}

      {/*
        The categories, over the list they narrow. Absent on a board with no
        proposals, where a row of zeros would say nothing. If the counts could
        not be read while a link has the list narrowed, the narrowing still
        has to be visible and undoable, so it is said in a line instead.
      */}
      {categories !== null && categories.total > 0 ? (
        <CategoryNav
          summary={categories}
          selected={category}
          onSelect={selectCategory}
        />
      ) : (
        category !== null && (
          <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
            Showing one category.
            <button
              type="button"
              className="text-foreground underline underline-offset-2"
              onClick={() => selectCategory(null)}
            >
              Show all
            </button>
          </p>
        )
      )}

      {/*
        The list at full width, with the proposal opening over it rather than
        beside it or inside it. See `PeekPanel` for why. A row carries only
        what a scan needs — which bounty, at what size, for how much — and
        everything a decision needs is in the peek.
      */}
      <div
        aria-busy={switching}
        className={`overflow-hidden rounded-lg border transition-opacity ${switching ? "opacity-60" : ""}`}
      >
        {visibleProposals.length === 0 ? (
          <p className="text-muted-foreground px-4 py-10 text-center text-sm">
            {category !== null
              ? "No proposals in this category."
              : active === undefined
                ? (emptyText ?? "No proposals yet.")
                : "Proposals appear here as bounties are sized."}
          </p>
        ) : (
          <>
            <div
              aria-hidden="true"
              className="text-muted-foreground bg-muted/40 hidden items-center gap-3 border-b px-3 py-2 text-xs font-medium sm:flex"
            >
              <span className="w-20 shrink-0">Bounty</span>
              <span className="flex-1" />
              <span className="w-24 shrink-0">Status</span>
              <span className="w-12 shrink-0">Size</span>
              <span className="w-24 shrink-0 text-right">Amount</span>
              <span className="size-4 shrink-0" />
            </div>
            <ul className="divide-y" data-testid="proposal-list">
              {visibleProposals.map((proposal) => {
                const name = nameOf(proposal);
                return (
                  <li key={proposal.id}>
                    <button
                      type="button"
                      aria-current={
                        selectedId === proposal.id ? "true" : undefined
                      }
                      className={`hover:bg-muted/50 grid w-full grid-cols-[1fr_auto_1rem] items-center gap-x-3 gap-y-1 px-3 py-3 text-left transition-colors sm:flex sm:py-2.5 ${
                        selectedId === proposal.id ? "bg-muted" : ""
                      }`}
                      onClick={() => openProposal(proposal.id)}
                    >
                      <span className="flex min-w-0 flex-col sm:contents">
                        <span className="text-muted-foreground shrink-0 font-mono text-xs sm:w-20">
                          {name.key}
                        </span>
                        {/*
                          The title, and under it why the run picked the
                          bounty: that is what makes a row more than an old
                          bounty with a price, so it is on the row rather
                          than only in the peek.
                        */}
                        <span className="flex min-w-0 flex-col sm:flex-1">
                          <span className="min-w-0 text-sm sm:truncate">
                            {name.title ??
                              (name.pending ? (
                                // Held open at a title's width, so the row
                                // does not reflow when its line arrives.
                                <span
                                  aria-hidden="true"
                                  data-testid="title-pending"
                                  className="skeleton inline-block h-3 w-40 max-w-full rounded align-middle"
                                />
                              ) : (
                                "Bounty"
                              ))}
                          </span>
                          <CategoryLine
                            categories={proposal.categories}
                            lead={category}
                            wrapOnPhone
                          />
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-3 sm:contents">
                        <span className="sm:w-24 sm:shrink-0">
                          <Badge
                            variant={
                              proposal.status === "approved"
                                ? "default"
                                : "secondary"
                            }
                          >
                            {capitalize(proposal.status)}
                          </Badge>
                        </span>
                        <span className="sm:w-12 sm:shrink-0">
                          {/*
                            A dashed size is one with no weighed spec
                            behind it: sized before weights, or with no
                            draft at all. Re-analyzing weighs it, which a
                            reviewer finds these rows to do.
                          */}
                          {unweighed(proposal) ? (
                            <Badge
                              variant="outline"
                              className="border-dashed font-mono"
                              title="No weighed scenarios: re-analyze to weigh them"
                              data-unweighed=""
                            >
                              {proposal.complexity}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="font-mono">
                              {proposal.complexity}
                            </Badge>
                          )}
                        </span>
                        <span className="text-sm tabular-nums sm:w-24 sm:shrink-0 sm:text-right">
                          {money(proposal.amountMinor, proposal.currency)}
                        </span>
                      </span>
                      <ChevronRight className="text-muted-foreground size-4 shrink-0" />
                    </button>
                  </li>
                );
              })}
            </ul>
            {moreProposals && (
              <div className="flex justify-center border-t px-3 py-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={loadingMore}
                  onClick={() => void showMore()}
                >
                  {loadingMore && <Loader2 className="animate-spin" />}
                  Show more
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/*
        Mounted whether or not a proposal is open, so Radix can animate it
        out on close. The actions live in the Price tab, each beside the
        fact it changes; the card is short, so nothing pushes them off.
      */}
      <PeekPanel
        open={selectedId !== null}
        onOpenChange={(next: boolean) => {
          if (!next) closeProposal(true);
        }}
        title={selected?.liveTitle ?? "Proposal"}
        description={selected?.liveKey ?? selected?.issueKey ?? undefined}
        data-testid="proposal-panel"
      >
        {selected === null ? (
          detailFailure !== null && detailFailure.id === selectedId ? (
            detailFailure.notFound ? (
              <p className="text-muted-foreground text-sm">
                {boardId === undefined
                  ? "This proposal no longer exists."
                  : "This proposal is not on this board."}
              </p>
            ) : (
              <div className="flex flex-col items-start gap-3">
                <ErrorBanner className="mt-0">
                  Could not load the proposal.
                </ErrorBanner>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void refresh()}
                >
                  <RefreshCw />
                  Try again
                </Button>
              </div>
            )
          ) : (
            <LoadingLine>Loading the proposal…</LoadingLine>
          )
        ) : (
          <ProposalPeek
            base={base}
            proposal={selected}
            bounty={readIssue === undefined ? null : bounty}
            liveSpec={
              /*
                On a board, the proposal's own read stands in when Jira's
                fails: a bounty gone from Jira is reviewed as stored.
              */
              detail !== null &&
              detail.proposal.id === selected.id &&
              (readIssue === undefined ||
                (bountyError !== null && detail.liveSpec != null))
                ? (detail.liveSpec ?? null)
                : undefined
            }
            bountyError={readIssue === undefined ? null : bountyError}
            onRetryBounty={() => {
              if (selectedKey !== null) loadBounty(selectedKey);
            }}
            canDecide={canManage(role)}
            busy={busy}
            mutate={mutate}
            onChanged={refresh}
            onRemoved={() => closeProposal(true)}
          />
        )}
      </PeekPanel>
    </div>
  );
}

/** What the freshness check found, said plainly rather than as a code. */
