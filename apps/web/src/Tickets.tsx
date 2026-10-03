import { rankAtLeast } from "sandbox-factory";
import { pushLocation, subscribeLocation } from "./navigation/location";
/**
 * The organization's tickets, and the proposals made from them.
 *
 * A ticket is the platform's own record of a piece of work. It is written
 * here, or imported from Jira when a board's run reaches it, and either way
 * it is proposed the same way: sized, priced, and reviewed in the proposal
 * list beside it. Nothing on this page needs Jira or GitHub; a ticket from
 * Jira links to its issue, and one about a repository is drafted beside an
 * outline of it.
 *
 * Two tabs, `?tab=proposals` for the second, so a link can name either: the
 * tickets, and every proposal the organization has from any source. Proposing
 * a ticket follows its sizing run and then opens the proposal in that tab.
 */

import type {
  GithubRepoDto,
  TicketDto,
  TicketSummaryDto,
} from "@sandbox-factory/shared";
import { DEFAULT_ISSUE_TYPE, TICKET_LIMITS } from "sandbox-factory";
import {
  ChevronRight,
  ExternalLink,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorBanner, LoadingLine } from "@/components/Message";
import { PeekPanel } from "@/components/PeekPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import { BoardBounties, money } from "./Bounties";
import { JiraIcon } from "./ProviderIcon";
import { TicketText } from "./TicketText";
import { useGithubRepos, type GithubRepos } from "./useGithub";
import { useTickets, type TicketDraft, type Tickets } from "./useTickets";

type Tab = "tickets" | "proposals";

function tabFromUrl(): Tab {
  return new URLSearchParams(window.location.search).get("tab") === "proposals"
    ? "proposals"
    : "tickets";
}

/** The issue types offered; any other may be typed. */
const ISSUE_TYPES = ["Task", "Bug", "Story"] as const;
const PRIORITIES = ["Highest", "High", "Medium", "Low", "Lowest"] as const;

function canManage(role: string): boolean {
  return rankAtLeast(role, "admin");
}

export function Tickets({
  organizationId,
  role,
}: {
  organizationId: string;
  role: string;
}) {
  const tickets = useTickets(organizationId);
  // Read once for every form and peek on the page.
  const repos = useGithubRepos(organizationId);
  const [tab, setTab] = useState<Tab>(tabFromUrl);
  /*
    Which ticket's peek is open, or the form for a new one. `?ticket=` like
    the proposal list's `?proposal=`, so a reload or a link lands on it and
    Back closes it.
  */
  const [openId, setOpenId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("ticket"),
  );
  const [creating, setCreating] = useState(false);
  /*
    The ticket the open peek last read. It names the panel when the ticket
    is not among the rows loaded, as for a link to an older one.
  */
  const [peeked, setPeeked] = useState<TicketDto | null>(null);
  const shown =
    (peeked?.id === openId ? peeked : undefined) ??
    tickets.tickets.find(({ id }) => id === openId);
  /** Bumped to remount the proposal list on a proposal opened from here. */
  const [proposalsKey, setProposalsKey] = useState(0);

  useEffect(() => {
    const sync = () => {
      setTab(tabFromUrl());
      setOpenId(new URLSearchParams(window.location.search).get("ticket"));
    };
    return subscribeLocation(sync);
  }, []);

  const pushParams = useCallback(
    (change: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(window.location.search);
      change(params);
      const query = params.toString();
      pushLocation(
        window.location.pathname +
          (query === "" ? "" : `?${query}`) +
          (window.location.hash ?? ""),
      );
    },
    [],
  );

  const selectTab = (next: Tab) => {
    if (next === tab) return;
    pushParams((params) => {
      if (next === "tickets") params.delete("tab");
      else params.set("tab", next);
      // Each tab's own peek closes with it.
      params.delete("proposal");
      params.delete("category");
      params.delete("ticket");
    });
    setOpenId(null);
    setTab(next);
  };

  const openTicket = (ticketId: string | null) => {
    pushParams((params) => {
      if (ticketId === null) params.delete("ticket");
      else params.set("ticket", ticketId);
    });
    setOpenId(ticketId);
  };

  /** The proposal a ticket has, opened in the proposals tab. */
  const openProposal = (proposalId: string) => {
    pushParams((params) => {
      params.set("tab", "proposals");
      params.set("proposal", proposalId);
      params.delete("ticket");
      params.delete("category");
    });
    setOpenId(null);
    setProposalsKey((key) => key + 1);
    setTab("proposals");
  };

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10 sm:px-6 sm:py-14">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tickets</h1>
          <p className="text-muted-foreground mt-1.5 max-w-prose text-sm">
            The work this workspace wants done, written here or imported from
            Jira. Propose a ticket to have it sized and priced as a bounty.
          </p>
        </div>
        <Button type="button" onClick={() => setCreating(true)}>
          <Plus />
          New ticket
        </Button>
      </header>

      <Tabs value={tab} onValueChange={(value) => selectTab(value as Tab)}>
        <TabsList>
          <TabsTrigger value="tickets">Tickets</TabsTrigger>
          <TabsTrigger value="proposals">Proposals</TabsTrigger>
        </TabsList>
        <TabsContent value="tickets" className="mt-4">
          <TicketList
            tickets={tickets}
            canPropose={canManage(role)}
            onOpen={(id) => openTicket(id)}
            onOpenProposal={openProposal}
            onCreate={() => setCreating(true)}
          />
        </TabsContent>
        <TabsContent value="proposals" className="mt-4">
          <BoardBounties
            key={proposalsKey}
            organizationId={organizationId}
            role={role}
            emptyText="No proposals yet. Propose a ticket to have it sized."
          />
        </TabsContent>
      </Tabs>

      <PeekPanel
        open={creating}
        onOpenChange={(next) => {
          if (!next) setCreating(false);
        }}
        title="New ticket"
        description="Only the title is required. The more the description says, the better the proposal."
        data-testid="new-ticket"
      >
        {creating && (
          <TicketForm
            repos={repos}
            submitLabel="Create ticket"
            onCancel={() => setCreating(false)}
            onSubmit={async (draft) => {
              const result = await tickets.create(draft);
              if (!result.ok) return result.error;
              setCreating(false);
              openTicket(result.ticket.id);
              return null;
            }}
          />
        )}
      </PeekPanel>

      <PeekPanel
        open={openId !== null}
        onOpenChange={(next) => {
          if (!next) openTicket(null);
        }}
        title={shown?.title ?? "Ticket"}
        description={shown?.key}
        data-testid="ticket-panel"
      >
        {openId !== null && (
          <TicketPeek
            key={openId}
            ticketId={openId}
            tickets={tickets}
            repos={repos}
            canManage={canManage(role)}
            onLoaded={setPeeked}
            onOpenProposal={openProposal}
            onDeleted={() => openTicket(null)}
          />
        )}
      </PeekPanel>
    </main>
  );
}

function TicketList({
  tickets,
  canPropose,
  onOpen,
  onOpenProposal,
  onCreate,
}: {
  tickets: Tickets;
  canPropose: boolean;
  onOpen: (ticketId: string) => void;
  onOpenProposal: (proposalId: string) => void;
  onCreate: () => void;
}) {
  const [loadingMore, setLoadingMore] = useState(false);
  if (tickets.loading) return <LoadingLine>Loading tickets…</LoadingLine>;
  return (
    <div className="flex flex-col gap-4">
      {tickets.error !== null && (
        <ErrorBanner className="mt-0">{tickets.error}</ErrorBanner>
      )}
      <div className="overflow-hidden rounded-lg border">
        {tickets.tickets.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <p className="text-muted-foreground text-sm">
              No tickets yet. Write one, or connect Jira and its boards&rsquo;
              tickets arrive here as they are sized.
            </p>
            <Button type="button" variant="outline" onClick={onCreate}>
              <Plus />
              New ticket
            </Button>
          </div>
        ) : (
          <>
            <div
              aria-hidden="true"
              className="text-muted-foreground bg-muted/40 hidden items-center gap-3 border-b px-3 py-2 text-xs font-medium sm:flex"
            >
              <span className="w-20 shrink-0">Ticket</span>
              <span className="flex-1" />
              <span className="w-56 shrink-0">Proposal</span>
              <span className="size-4 shrink-0" />
            </div>
            <ul className="divide-y" data-testid="ticket-list">
              {tickets.tickets.map((ticket) => (
                <TicketRow
                  key={ticket.id}
                  ticket={ticket}
                  canPropose={canPropose}
                  tickets={tickets}
                  onOpen={() => onOpen(ticket.id)}
                  onOpenProposal={onOpenProposal}
                />
              ))}
            </ul>
            {tickets.more && (
              <div className="flex justify-center border-t px-3 py-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={loadingMore}
                  onClick={() => {
                    setLoadingMore(true);
                    void tickets
                      .loadMore()
                      .finally(() => setLoadingMore(false));
                  }}
                >
                  {loadingMore && <Loader2 className="animate-spin" />}
                  Show more
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Where a ticket came from, said in a few words. */
function Source({ ticket }: { ticket: TicketSummaryDto }) {
  if (ticket.jira === null) {
    return <span className="text-muted-foreground text-xs">Written here</span>;
  }
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
      <span className="size-3 shrink-0">
        <JiraIcon />
      </span>
      {ticket.jira.removedAt === null ? "From Jira" : "Gone from Jira"}
    </span>
  );
}

function TicketRow({
  ticket,
  canPropose,
  tickets,
  onOpen,
  onOpenProposal,
}: {
  ticket: TicketSummaryDto;
  canPropose: boolean;
  tickets: Tickets;
  onOpen: () => void;
  onOpenProposal: (proposalId: string) => void;
}) {
  const propose = usePropose(tickets, ticket.id, onOpenProposal);
  const { proposal } = ticket;
  return (
    <li className="flex flex-col">
      <div className="hover:bg-muted/50 flex items-center gap-3 px-3 py-2.5 transition-colors">
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 text-left sm:flex-row sm:items-center sm:gap-3"
          onClick={onOpen}
        >
          <span className="text-muted-foreground shrink-0 font-mono text-xs sm:w-20">
            {ticket.key}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="min-w-0 text-sm sm:truncate">{ticket.title}</span>
            <span className="flex flex-wrap items-center gap-x-2">
              <span className="text-muted-foreground text-xs">
                {ticket.issueType}
              </span>
              <Source ticket={ticket} />
            </span>
          </span>
        </button>
        <span className="flex shrink-0 items-center gap-2 sm:w-56">
          {proposal !== null ? (
            <button
              type="button"
              className="hover:bg-muted flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5"
              onClick={() => onOpenProposal(proposal.id)}
              aria-label={`Open the proposal for ${ticket.key}`}
            >
              <Badge
                variant={
                  proposal.status === "approved" ? "default" : "secondary"
                }
              >
                {proposal.status === "approved" ? "Approved" : "Proposed"}
              </Badge>
              <Badge variant="outline" className="font-mono">
                {proposal.complexity}
              </Badge>
              <span className="text-sm tabular-nums">
                {money(proposal.amountMinor, proposal.currency)}
              </span>
            </button>
          ) : canPropose ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={propose.pending}
              onClick={() => void propose.start()}
            >
              {propose.pending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Sparkles />
              )}
              {propose.pending ? "Sizing…" : "Propose"}
            </Button>
          ) : (
            <span className="text-muted-foreground text-xs">No proposal</span>
          )}
        </span>
        <ChevronRight
          aria-hidden="true"
          className="text-muted-foreground hidden size-4 shrink-0 sm:block"
        />
      </div>
      {propose.error !== null && (
        <p role="alert" className="text-destructive px-3 pb-2.5 text-xs">
          {propose.error}
        </p>
      )}
    </li>
  );
}

/**
 * Proposing one ticket: the request, the sizing run it starts, and the
 * proposal opened when it lands. Stopped if the row goes away.
 */
function usePropose(
  tickets: Tickets,
  ticketId: string,
  onOpenProposal: (proposalId: string) => void,
) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const start = async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setPending(true);
    setError(null);
    const result = await tickets.propose(ticketId, current.signal);
    if (current.signal.aborted) return;
    setPending(false);
    if (result.ok) onOpenProposal(result.proposalId);
    else setError(result.error);
  };
  return { pending, error, start };
}

/**
 * What a save changes. Only the fields that differ are sent, so a field
 * nobody touched is not judged again: a ticket gone from Jira can hold text
 * longer than a ticket written here may. A ticket following its Jira issue
 * sends its repository alone.
 */
function changesFrom(
  ticket: TicketDto,
  draft: TicketDraft,
  textLocked: boolean,
): Partial<TicketDraft> {
  const change: Partial<TicketDraft> = {};
  if (draft.repoId !== ticket.repoId) change.repoId = draft.repoId;
  if (textLocked) return change;
  if (draft.title !== ticket.title) change.title = draft.title;
  if (draft.description !== ticket.description) {
    change.description = draft.description;
  }
  if (draft.issueType !== ticket.issueType) change.issueType = draft.issueType;
  if (draft.priority !== ticket.priority) change.priority = draft.priority;
  if (draft.labels.join("\n") !== ticket.labels.join("\n")) {
    change.labels = draft.labels;
  }
  return change;
}

/** Said when a save lost to someone else's, and the form now shows theirs. */
const CHANGED_WHILE_EDITING =
  "Someone changed this ticket while you were editing. It now shows their version; make your change again.";

function TicketPeek({
  ticketId,
  tickets,
  repos,
  canManage,
  onLoaded,
  onOpenProposal,
  onDeleted,
}: {
  ticketId: string;
  tickets: Tickets;
  repos: GithubRepos;
  canManage: boolean;
  onLoaded: (ticket: TicketDto) => void;
  onOpenProposal: (proposalId: string) => void;
  onDeleted: () => void;
}) {
  const [ticket, setTicket] = useState<TicketDto | null>(null);
  /*
    The read found nothing to show. `notFound` is a ticket that is gone;
    anything else failed and is worth trying again, which `attempt` does.
  */
  const [failure, setFailure] = useState<{ notFound: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState(false);
  /*
    Why the form opened again holding the ticket as it is now. The form is
    keyed by revision, so it is held here, where a remount cannot drop it.
  */
  const [notice, setNotice] = useState<string | null>(null);
  const propose = usePropose(tickets, ticketId, onOpenProposal);
  const { read } = tickets;

  useEffect(() => {
    let live = true;
    void read(ticketId).then((result) => {
      if (!live) return;
      if (result.ok) {
        setTicket(result.ticket);
        setFailure(null);
      } else {
        setFailure({ notFound: result.notFound });
      }
    });
    return () => {
      live = false;
    };
  }, [read, ticketId, attempt]);

  useEffect(() => {
    if (ticket !== null) onLoaded(ticket);
  }, [ticket, onLoaded]);

  if (failure?.notFound === true) {
    return (
      <p className="text-muted-foreground text-sm">
        This ticket no longer exists.
      </p>
    );
  }
  if (ticket === null) {
    return failure === null ? (
      <LoadingLine>Loading the ticket…</LoadingLine>
    ) : (
      <div className="flex flex-col items-start gap-3">
        <ErrorBanner className="mt-0">Could not load the ticket.</ErrorBanner>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setFailure(null);
            setAttempt((count) => count + 1);
          }}
        >
          <RefreshCw />
          Try again
        </Button>
      </div>
    );
  }

  // A ticket following its Jira issue takes its text from Jira.
  const followsJira = ticket.jira !== null && ticket.jira.removedAt === null;
  const repo = repos.repos.find(({ id }) => id === ticket.repoId) ?? null;
  const { proposal } = ticket;

  if (editing) {
    return (
      <TicketForm
        key={ticket.revision}
        repos={repos}
        initial={ticket}
        initialError={notice}
        textLocked={followsJira}
        submitLabel="Save"
        onCancel={() => setEditing(false)}
        onSubmit={async (draft) => {
          const change = changesFrom(ticket, draft, followsJira);
          if (Object.keys(change).length === 0) {
            setEditing(false);
            return null;
          }
          const result = await tickets.update(
            ticket.id,
            ticket.revision,
            change,
          );
          if (!result.ok) {
            if (result.ticket === undefined) return result.error;
            // The form remounts on the new revision, holding what is there.
            setNotice(CHANGED_WHILE_EDITING);
            setTicket(result.ticket);
            return CHANGED_WHILE_EDITING;
          }
          setTicket(result.ticket);
          setEditing(false);
          return null;
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-5" data-testid="ticket-detail">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex flex-wrap items-center gap-2 text-sm">
          {ticket.jira === null ? (
            <span className="text-muted-foreground">Written here</span>
          ) : (
            <span className="text-muted-foreground inline-flex items-center gap-1.5">
              <span className="size-3.5 shrink-0">
                <JiraIcon />
              </span>
              {followsJira
                ? "Follows its Jira issue"
                : "Gone from Jira; keeps its last text"}
            </span>
          )}
        </span>
        <span className="flex flex-wrap items-center gap-2">
          {ticket.jira?.url != null && (
            <Button variant="outline" size="sm" className="gap-1.5" asChild>
              <a
                href={ticket.jira.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                Open in Jira
                <ExternalLink className="size-3" />
              </a>
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setNotice(null);
              setEditing(true);
            }}
          >
            <Pencil />
            Edit
          </Button>
        </span>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border p-4">
        {proposal !== null ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <Badge
                variant={
                  proposal.status === "approved" ? "default" : "secondary"
                }
              >
                {proposal.status === "approved" ? "Approved" : "Proposed"}
              </Badge>
              <Badge variant="outline" className="font-mono">
                {proposal.complexity}
              </Badge>
              <span className="text-lg font-semibold tabular-nums">
                {money(proposal.amountMinor, proposal.currency)}
              </span>
            </span>
            <Button
              type="button"
              size="sm"
              onClick={() => onOpenProposal(proposal.id)}
            >
              Open proposal
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-muted-foreground text-sm">
              No proposal yet.{" "}
              {canManage
                ? "Propose it to have it sized and priced."
                : "An owner or admin can propose it."}
            </p>
            {canManage && (
              <Button
                type="button"
                size="sm"
                disabled={propose.pending}
                onClick={() => void propose.start()}
              >
                {propose.pending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Sparkles />
                )}
                {propose.pending ? "Sizing…" : "Propose"}
              </Button>
            )}
          </div>
        )}
        {propose.error !== null && (
          <p role="alert" className="text-destructive text-xs">
            {propose.error}
          </p>
        )}
      </div>

      <p className="text-sm">
        <span className="text-muted-foreground">Repository </span>
        <span className="font-medium">
          {/*
            A repository that is removed clears the ticket's link, so one
            named but not listed is one the list has not shown yet.
          */}
          {repo?.fullName ??
            (ticket.repoId === null
              ? ticket.jira === null
                ? "None"
                : "Its board's, if it has one"
              : repos.loading
                ? "…"
                : "Unavailable")}
        </span>
      </p>

      <TicketText
        issueType={ticket.issueType}
        priority={ticket.priority}
        labels={ticket.labels}
        description={ticket.description}
        inputTruncated={ticket.inputTruncated}
      />

      {canManage && proposal === null && (
        <div className="flex flex-col items-start">
          <ConfirmDialog
            trigger={
              <button
                type="button"
                className="text-muted-foreground hover:text-destructive cursor-pointer text-xs underline-offset-2 hover:underline"
              >
                Delete ticket
              </button>
            }
            title={`Delete ${ticket.key}?`}
            description="The ticket is removed from this workspace. A ticket with a proposal or a sandbox, or one being sized, cannot be deleted."
            confirmLabel="Delete ticket"
            onConfirm={async () => {
              // A failure stays in the dialog, which says it.
              const failure = await tickets.remove(ticket.id);
              if (failure !== null) return failure;
              onDeleted();
            }}
          />
        </div>
      )}
    </div>
  );
}

const fieldClass =
  "border-input focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm";

/**
 * A ticket's fields, for writing one or changing it. `textLocked` is a
 * ticket following its Jira issue: its text is Jira's, so only its
 * repository is offered.
 */
function TicketForm({
  repos,
  initial,
  initialError = null,
  textLocked = false,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  repos: GithubRepos;
  initial?: TicketDto;
  /** What the form opens saying, as after a save that lost a race. */
  initialError?: string | null;
  textLocked?: boolean;
  submitLabel: string;
  /** Resolves to null when saved, or to what to say. */
  onSubmit: (draft: TicketDraft) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [issueType, setIssueType] = useState(
    initial?.issueType ?? DEFAULT_ISSUE_TYPE,
  );
  const [priority, setPriority] = useState(initial?.priority ?? "");
  const [labels, setLabels] = useState((initial?.labels ?? []).join(", "));
  const [repoId, setRepoId] = useState(initial?.repoId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const choices: GithubRepoDto[] = repos.repos.filter(
    (repo) =>
      (repo.role === "source" && repo.syncStatus !== "gone") ||
      repo.id === initial?.repoId,
  );
  /*
    A value the options do not hold — a Jira priority such as "Critical",
    or a repository the list has not shown yet — is offered as itself.
    Otherwise the select would show "None" while still sending the value.
  */
  const otherPriority =
    priority !== "" && !(PRIORITIES as readonly string[]).includes(priority)
      ? priority
      : null;
  const otherRepo =
    repoId !== "" && !choices.some(({ id }) => id === repoId) ? repoId : null;

  return (
    <form
      className="flex flex-col gap-4"
      data-testid="ticket-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (title.trim() === "") {
          setError("A ticket needs a title.");
          return;
        }
        // Trimmed, and each kept once in the order first given, as stored.
        const labelList = [
          ...new Set(
            labels
              .split(",")
              .map((label) => label.trim())
              .filter((label) => label !== ""),
          ),
        ];
        if (!textLocked && labelList.length > TICKET_LIMITS.labels) {
          setError(`A ticket takes at most ${TICKET_LIMITS.labels} labels.`);
          return;
        }
        if (
          !textLocked &&
          labelList.some((label) => label.length > TICKET_LIMITS.label)
        ) {
          setError(
            `A label is at most ${TICKET_LIMITS.label} characters long.`,
          );
          return;
        }
        setSaving(true);
        setError(null);
        void onSubmit({
          title: title.trim(),
          description,
          issueType:
            issueType.trim() === "" ? DEFAULT_ISSUE_TYPE : issueType.trim(),
          priority: priority === "" ? null : priority,
          labels: labelList,
          repoId: repoId === "" ? null : repoId,
        }).then((failure) => {
          setSaving(false);
          setError(failure);
        });
      }}
    >
      {textLocked && (
        <p className="text-muted-foreground text-sm">
          This ticket follows its Jira issue, so its text is changed in Jira.
          Its repository is this workspace&rsquo;s to set.
        </p>
      )}
      <Labelled label="Title">
        {(field) => (
          <>
            <Input
              id={field.id}
              aria-describedby={field.describedBy}
              value={title}
              maxLength={TICKET_LIMITS.title}
              disabled={textLocked}
              required
              onChange={(event) => setTitle(event.target.value)}
            />
          </>
        )}
      </Labelled>
      <div className="grid gap-4 sm:grid-cols-2">
        <Labelled label="Type">
          {(field) => (
            <>
              <Input
                id={field.id}
                aria-describedby={field.describedBy}
                value={issueType}
                list="ticket-issue-types"
                maxLength={TICKET_LIMITS.issueType}
                disabled={textLocked}
                onChange={(event) => setIssueType(event.target.value)}
              />
              <datalist id="ticket-issue-types">
                {ISSUE_TYPES.map((type) => (
                  <option key={type} value={type} />
                ))}
              </datalist>
            </>
          )}
        </Labelled>
        <Labelled label="Priority">
          {(field) => (
            <>
              <select
                id={field.id}
                aria-describedby={field.describedBy}
                className={cn(fieldClass, "h-9 py-1")}
                value={priority}
                disabled={textLocked}
                onChange={(event) => setPriority(event.target.value)}
              >
                <option value="">None</option>
                {PRIORITIES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
                {otherPriority !== null && (
                  <option value={otherPriority}>{otherPriority}</option>
                )}
              </select>
            </>
          )}
        </Labelled>
      </div>
      <Labelled label="Labels" hint="Separated by commas.">
        {(field) => (
          <>
            <Input
              id={field.id}
              aria-describedby={field.describedBy}
              value={labels}
              disabled={textLocked}
              onChange={(event) => setLabels(event.target.value)}
            />
          </>
        )}
      </Labelled>
      <Labelled
        label="Repository"
        hint="The code the ticket is about. Its spec is drafted beside an outline of it."
      >
        {(field) => (
          <>
            <select
              id={field.id}
              aria-describedby={field.describedBy}
              className={cn(fieldClass, "h-9 py-1")}
              value={repoId}
              onChange={(event) => setRepoId(event.target.value)}
            >
              <option value="">None</option>
              {choices.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.fullName}
                </option>
              ))}
              {otherRepo !== null && (
                <option value={otherRepo}>
                  {repos.loading ? "…" : "Unavailable"}
                </option>
              )}
            </select>
          </>
        )}
      </Labelled>
      <Labelled
        label="Description"
        hint="What should be true when it is done. Markdown works."
      >
        {(field) => (
          <>
            <textarea
              id={field.id}
              aria-describedby={field.describedBy}
              className={cn(fieldClass, "min-h-48 font-mono")}
              value={description}
              maxLength={TICKET_LIMITS.description}
              disabled={textLocked}
              onChange={(event) => setDescription(event.target.value)}
            />
          </>
        )}
      </Labelled>
      {error !== null && <ErrorBanner className="mt-0">{error}</ErrorBanner>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="animate-spin" />}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/**
 * A field and its label, joined by id so the label alone is the field's
 * name; the hint describes it.
 */
function Labelled({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (field: { id: string; describedBy?: string }) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      {children(hint === undefined ? { id } : { id, describedBy: hintId })}
      {hint !== undefined && (
        <span id={hintId} className="text-muted-foreground text-xs">
          {hint}
        </span>
      )}
    </div>
  );
}
