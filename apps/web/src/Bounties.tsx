import { rankAtLeast } from "sandbox-factory";
import { subscribeLocation, updateSearch } from "./navigation/location";
/**
 * The organization's bounties, and the proposals made from them.
 *
 * A bounty is the platform's own record of a piece of work. It is written
 * here, or imported from Jira when a board's run reaches it, and either way
 * it is the same two parts: a proposal, which specifies and prices it, and a
 * sandbox, which contributors work in. The peek shows those two, and below
 * them the context that sources add. Nothing on this page needs Jira or
 * GitHub; a bounty from Jira links to its issue, and one about a repository
 * is drafted beside an outline of it and cut from it.
 *
 * The page lists bounties only. A proposal is made from a bounty and lives
 * inside it: the bounty's panel has a Bounty tab and a Proposal tab, and
 * proposing a bounty follows its sizing run and then opens that tab.
 * `?bounty=` names the open bounty and `?proposal=` its proposal, so a
 * reload or a link lands on either.
 */

import type {
  GithubRepoDto,
  BountyDto,
  BountySandboxSummaryDto,
  BountySummaryDto,
} from "@sandbox-factory/shared";
import { DEFAULT_ISSUE_TYPE, BOUNTY_LIMITS } from "sandbox-factory";
import {
  Box,
  ChevronRight,
  ExternalLink,
  Link2,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorBanner, LoadingLine } from "@/components/Message";
import { PeekPanel } from "@/components/PeekPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import { money } from "./Proposals";
import { JiraIcon } from "./ProviderIcon";
import { BountyText } from "./BountyText";
import { clients } from "./data/query";
import { BountyProposal } from "./features/bounties/BountyProposal";
import { useGithubRepos, type GithubRepos } from "./useGithub";
import { useBounties, type BountyDraft, type Bounties } from "./useBounties";

/** How a sandbox's status reads. */
const SANDBOX_STATUS_LABEL: Record<BountySandboxSummaryDto["status"], string> =
  { draft: "Draft", published: "Published", closed: "Closed" };

/** The issue types offered; any other may be typed. */
const ISSUE_TYPES = ["Task", "Bug", "Story"] as const;
const PRIORITIES = ["Highest", "High", "Medium", "Low", "Lowest"] as const;

function canManage(role: string): boolean {
  return rankAtLeast(role, "admin");
}

export function Bounties({
  organizationId,
  role,
}: {
  organizationId: string;
  role: string;
}) {
  const bounties = useBounties(organizationId);
  // Read once for every form and peek on the page.
  const repos = useGithubRepos(organizationId);
  /*
    Which bounty's panel is open, or the form for a new one, and whether
    that panel shows the bounty's proposal. Both in the query, so a reload
    or a link lands on them and Back steps out of them.
  */
  const [openId, setOpenId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("bounty"),
  );
  const [proposalId, setProposalId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("proposal"),
  );
  const [creating, setCreating] = useState(false);
  /*
    The bounty the open peek last read. It names the panel when the bounty
    is not among the rows loaded, as for a link to an older one.
  */
  const [peeked, setPeeked] = useState<BountyDto | null>(null);
  const shown =
    (peeked?.id === openId ? peeked : undefined) ??
    bounties.bounties.find(({ id }) => id === openId);
  // What the Proposal tab opens when the address does not name one yet.
  const knownProposal = proposalId ?? shown?.proposal?.id ?? null;

  useEffect(() => {
    const sync = () => {
      const params = new URLSearchParams(window.location.search);
      setOpenId(params.get("bounty"));
      setProposalId(params.get("proposal"));
    };
    return subscribeLocation(sync);
  }, []);

  /*
    Addresses from when proposals had a tab of their own: `?tab=proposals`,
    and a proposal named with no bounty. The tab is dropped, and the
    proposal opens inside the bounty it belongs to, which its read names.
  */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const orphan = params.get("proposal");
    if (params.has("tab")) updateSearch((next) => next.delete("tab"), true);
    if (orphan === null || params.has("bounty")) return;
    let live = true;
    void clients.pricing
      .detail(organizationId, orphan)
      .then(({ proposal }) => {
        if (live)
          updateSearch((next) => next.set("bounty", proposal.bountyId), true);
      })
      .catch(() => {
        if (live) updateSearch((next) => next.delete("proposal"), true);
      });
    return () => {
      live = false;
    };
  }, [organizationId]);

  const openBounty = (bountyId: string | null) => {
    updateSearch((params) => {
      if (bountyId === null) params.delete("bounty");
      else params.set("bounty", bountyId);
      params.delete("proposal");
    });
  };

  /** A bounty's proposal, opened inside the bounty. */
  const openProposal = (bountyId: string, id: string) => {
    updateSearch((params) => {
      params.set("bounty", bountyId);
      params.set("proposal", id);
    });
  };

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10 sm:px-6 sm:py-14">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Bounties</h1>
          <p className="text-muted-foreground mt-1.5 max-w-prose text-sm">
            The work this workspace wants done, written here or imported from
            Jira. Each bounty is a proposal, which sizes and prices it, and a
            sandbox that contributors work in.
          </p>
        </div>
        <Button type="button" onClick={() => setCreating(true)}>
          <Plus />
          New bounty
        </Button>
      </header>

      <BountyList
        bounties={bounties}
        onOpen={(id) => openBounty(id)}
        onOpenProposal={openProposal}
        onCreate={() => setCreating(true)}
      />

      <PeekPanel
        open={creating}
        onOpenChange={(next) => {
          if (!next) setCreating(false);
        }}
        title="New bounty"
        description="Only the title is required. The more the description says, the better the proposal."
        data-testid="new-bounty"
      >
        {creating && (
          <BountyForm
            repos={repos}
            submitLabel="Create bounty"
            onCancel={() => setCreating(false)}
            onSubmit={async (draft) => {
              const result = await bounties.create(draft);
              if (!result.ok) return result.error;
              setCreating(false);
              openBounty(result.bounty.id);
              return null;
            }}
          />
        )}
      </PeekPanel>

      <PeekPanel
        open={openId !== null}
        onOpenChange={(next) => {
          if (!next) openBounty(null);
        }}
        title={shown?.title ?? "Bounty"}
        description={shown?.key}
        data-testid="bounty-panel"
      >
        {openId !== null && (
          <Tabs
            value={proposalId === null ? "bounty" : "proposal"}
            onValueChange={(value) => {
              if (value === "bounty") openBounty(openId);
              else if (knownProposal !== null)
                openProposal(openId, knownProposal);
            }}
          >
            <TabsList>
              <TabsTrigger value="bounty">Bounty</TabsTrigger>
              <TabsTrigger value="proposal" disabled={knownProposal === null}>
                Proposal
              </TabsTrigger>
            </TabsList>
            <TabsContent value="bounty" className="mt-4">
              <BountyPeek
                key={openId}
                bountyId={openId}
                bounties={bounties}
                repos={repos}
                canManage={canManage(role)}
                onLoaded={setPeeked}
                onOpenProposal={(id) => openProposal(openId, id)}
                onDeleted={() => openBounty(null)}
              />
            </TabsContent>
            <TabsContent value="proposal" className="mt-4">
              {proposalId !== null && (
                <BountyProposal
                  key={proposalId}
                  organizationId={organizationId}
                  proposalId={proposalId}
                  bountyKey={shown?.key}
                  bountyTitle={shown?.title}
                  canDecide={canManage(role)}
                  onChanged={() => void bounties.refresh()}
                  onRemoved={() => {
                    void bounties.refresh();
                    openBounty(openId);
                  }}
                />
              )}
            </TabsContent>
          </Tabs>
        )}
      </PeekPanel>
    </main>
  );
}

function BountyList({
  bounties,
  onOpen,
  onOpenProposal,
  onCreate,
}: {
  bounties: Bounties;
  onOpen: (bountyId: string) => void;
  onOpenProposal: (bountyId: string, proposalId: string) => void;
  onCreate: () => void;
}) {
  const [loadingMore, setLoadingMore] = useState(false);
  if (bounties.loading) return <LoadingLine>Loading bounties…</LoadingLine>;
  return (
    <div className="flex flex-col gap-4">
      {bounties.error !== null && (
        <ErrorBanner className="mt-0">{bounties.error}</ErrorBanner>
      )}
      <div className="overflow-hidden rounded-lg border">
        {bounties.bounties.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <p className="text-muted-foreground text-sm">
              No bounties yet. Write one, or connect Jira and its boards&rsquo;
              bounties arrive here as they are sized.
            </p>
            <Button type="button" variant="outline" onClick={onCreate}>
              <Plus />
              New bounty
            </Button>
          </div>
        ) : (
          <>
            <div
              aria-hidden="true"
              className="text-muted-foreground bg-muted/40 hidden items-center gap-3 border-b px-3 py-2 text-xs font-medium sm:flex"
            >
              <span className="w-20 shrink-0">Bounty</span>
              <span className="flex-1" />
              <span className="w-56 shrink-0">Proposal</span>
              <span className="size-4 shrink-0" />
            </div>
            <ul className="divide-y" data-testid="bounty-list">
              {bounties.bounties.map((bounty) => (
                <BountyRow
                  key={bounty.id}
                  bounty={bounty}
                  onOpen={() => onOpen(bounty.id)}
                  onOpenProposal={(id) => onOpenProposal(bounty.id, id)}
                />
              ))}
            </ul>
            {bounties.more && (
              <div className="flex justify-center border-t px-3 py-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={loadingMore}
                  onClick={() => {
                    setLoadingMore(true);
                    void bounties
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

/** Where a bounty came from, said in a few words. */
function Source({ bounty }: { bounty: BountySummaryDto }) {
  if (bounty.jira === null) {
    return <span className="text-muted-foreground text-xs">Written here</span>;
  }
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
      <span className="size-3 shrink-0">
        <JiraIcon />
      </span>
      {bounty.jira.removedAt === null ? "From Jira" : "Gone from Jira"}
    </span>
  );
}

/**
 * One bounty in the list. Its proposal is shown, and opens inside the
 * bounty; a bounty is proposed from inside it, never from the row.
 */
function BountyRow({
  bounty,
  onOpen,
  onOpenProposal,
}: {
  bounty: BountySummaryDto;
  onOpen: () => void;
  onOpenProposal: (proposalId: string) => void;
}) {
  const { proposal } = bounty;
  return (
    <li className="flex flex-col">
      <div className="hover:bg-muted/50 flex items-center gap-3 px-3 py-2.5 transition-colors">
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 text-left sm:flex-row sm:items-center sm:gap-3"
          onClick={onOpen}
        >
          <span className="text-muted-foreground shrink-0 font-mono text-xs sm:w-20">
            {bounty.key}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="min-w-0 text-sm sm:truncate">{bounty.title}</span>
            <span className="flex flex-wrap items-center gap-x-2">
              <span className="text-muted-foreground text-xs">
                {bounty.issueType}
              </span>
              <Source bounty={bounty} />
              {bounty.sandbox !== null && (
                <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
                  <Box className="size-3" />
                  Sandbox {SANDBOX_STATUS_LABEL[bounty.sandbox.status]}
                </span>
              )}
            </span>
          </span>
        </button>
        <span className="flex shrink-0 items-center gap-2 sm:w-56">
          {proposal !== null ? (
            <button
              type="button"
              className="hover:bg-muted flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5"
              onClick={() => onOpenProposal(proposal.id)}
              aria-label={`Open the proposal for ${bounty.key}`}
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
          ) : (
            <span className="text-muted-foreground text-xs">No proposal</span>
          )}
        </span>
        <ChevronRight
          aria-hidden="true"
          className="text-muted-foreground hidden size-4 shrink-0 sm:block"
        />
      </div>
    </li>
  );
}

/**
 * Proposing one bounty: the request, the sizing run it starts, and the
 * proposal opened when it lands. Stopped if the row goes away.
 */
function usePropose(
  bounties: Bounties,
  bountyId: string,
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
    const result = await bounties.propose(bountyId, current.signal);
    if (current.signal.aborted) return;
    setPending(false);
    if (result.ok) onOpenProposal(result.proposalId);
    else setError(result.error);
  };
  return { pending, error, start };
}

/**
 * What a save changes. Only the fields that differ are sent, so a field
 * nobody touched is not judged again: a bounty gone from Jira can hold text
 * longer than a bounty written here may. A bounty following its Jira issue
 * sends its repository alone.
 */
function changesFrom(
  bounty: BountyDto,
  draft: BountyDraft,
  textLocked: boolean,
): Partial<BountyDraft> {
  const change: Partial<BountyDraft> = {};
  if (draft.repoId !== bounty.repoId) change.repoId = draft.repoId;
  if (textLocked) return change;
  if (draft.title !== bounty.title) change.title = draft.title;
  if (draft.description !== bounty.description) {
    change.description = draft.description;
  }
  if (draft.issueType !== bounty.issueType) change.issueType = draft.issueType;
  if (draft.priority !== bounty.priority) change.priority = draft.priority;
  if (draft.labels.join("\n") !== bounty.labels.join("\n")) {
    change.labels = draft.labels;
  }
  return change;
}

/** Said when a save lost to someone else's, and the form now shows theirs. */
const CHANGED_WHILE_EDITING =
  "Someone changed this bounty while you were editing. It now shows their version; make your change again.";

function BountyPeek({
  bountyId,
  bounties,
  repos,
  canManage,
  onLoaded,
  onOpenProposal,
  onDeleted,
}: {
  bountyId: string;
  bounties: Bounties;
  repos: GithubRepos;
  canManage: boolean;
  onLoaded: (bounty: BountyDto) => void;
  onOpenProposal: (proposalId: string) => void;
  onDeleted: () => void;
}) {
  const [bounty, setBounty] = useState<BountyDto | null>(null);
  /*
    The read found nothing to show. `notFound` is a bounty that is gone;
    anything else failed and is worth trying again, which `attempt` does.
  */
  const [failure, setFailure] = useState<{ notFound: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState(false);
  /*
    Why the form opened again holding the bounty as it is now. The form is
    keyed by revision, so it is held here, where a remount cannot drop it.
  */
  const [notice, setNotice] = useState<string | null>(null);
  const propose = usePropose(bounties, bountyId, onOpenProposal);
  const [sandboxPending, setSandboxPending] = useState(false);
  const [sandboxError, setSandboxError] = useState<string | null>(null);
  const { read } = bounties;

  useEffect(() => {
    let live = true;
    void read(bountyId).then((result) => {
      if (!live) return;
      if (result.ok) {
        setBounty(result.bounty);
        setFailure(null);
      } else {
        setFailure({ notFound: result.notFound });
      }
    });
    return () => {
      live = false;
    };
  }, [read, bountyId, attempt]);

  useEffect(() => {
    if (bounty !== null) onLoaded(bounty);
  }, [bounty, onLoaded]);

  if (failure?.notFound === true) {
    return (
      <p className="text-muted-foreground text-sm">
        This bounty no longer exists.
      </p>
    );
  }
  if (bounty === null) {
    return failure === null ? (
      <LoadingLine>Loading the bounty…</LoadingLine>
    ) : (
      <div className="flex flex-col items-start gap-3">
        <ErrorBanner className="mt-0">Could not load the bounty.</ErrorBanner>
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

  // A bounty following its Jira issue takes its text from Jira.
  const followsJira = bounty.jira !== null && bounty.jira.removedAt === null;
  const repo = repos.repos.find(({ id }) => id === bounty.repoId) ?? null;
  const { proposal, sandbox } = bounty;
  // A sandbox made before its bounty named a repository links that one.
  const unlinked = sandbox !== null && sandbox.sourceRepoId === null;
  const repoToLink = unlinked ? bounty.repoId : null;
  // Either part is kept with the bounty, so either one keeps it.
  const removable = proposal === null && sandbox === null;

  if (editing) {
    return (
      <BountyForm
        key={bounty.revision}
        repos={repos}
        initial={bounty}
        initialError={notice}
        textLocked={followsJira}
        submitLabel="Save"
        onCancel={() => setEditing(false)}
        onSubmit={async (draft) => {
          const change = changesFrom(bounty, draft, followsJira);
          if (Object.keys(change).length === 0) {
            setEditing(false);
            return null;
          }
          const result = await bounties.update(
            bounty.id,
            bounty.revision,
            change,
          );
          if (!result.ok) {
            if (result.bounty === undefined) return result.error;
            // The form remounts on the new revision, holding what is there.
            setNotice(CHANGED_WHILE_EDITING);
            setBounty(result.bounty);
            return CHANGED_WHILE_EDITING;
          }
          setBounty(result.bounty);
          setEditing(false);
          return null;
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-5" data-testid="bounty-detail">
      <div className="flex justify-end">
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
      </div>

      <Part title="Proposal">
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
      </Part>

      <Part title="Sandbox">
        {sandbox !== null ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={
                  sandbox.status === "published" ? "default" : "secondary"
                }
              >
                {SANDBOX_STATUS_LABEL[sandbox.status]}
              </Badge>
              <span className="text-muted-foreground text-sm">
                {sandbox.currentVersionId === null
                  ? "No version published yet."
                  : "Contributors can work in its published version."}
              </span>
            </div>
            {unlinked && (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-muted-foreground text-sm">
                  No repository linked; a version is cut from one.{" "}
                  {!canManage
                    ? "An owner or admin can link one."
                    : repoToLink === null
                      ? "Edit the bounty to name its repository, then link it."
                      : null}
                </p>
                {canManage && repoToLink !== null && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={sandboxPending}
                    onClick={() => {
                      setSandboxPending(true);
                      setSandboxError(null);
                      void bounties
                        .linkSandboxSource(sandbox.id, repoToLink)
                        .then((failure) => {
                          setSandboxPending(false);
                          if (failure === null)
                            setAttempt((count) => count + 1);
                          else setSandboxError(failure);
                        });
                    }}
                  >
                    {sandboxPending ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Link2 />
                    )}
                    Link {repo?.fullName ?? "its repository"}
                  </Button>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-muted-foreground text-sm">
              No sandbox yet.{" "}
              {canManage
                ? "Create one to cut the task contributors work in."
                : "An owner or admin can create one."}
            </p>
            {canManage && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={sandboxPending}
                onClick={() => {
                  setSandboxPending(true);
                  setSandboxError(null);
                  // Cut from the bounty's own repository when it names one;
                  // without one, the sandbox waits for a repository.
                  void bounties
                    .createSandbox(bounty.id, bounty.repoId)
                    .then((failure) => {
                      setSandboxPending(false);
                      if (failure === null) setAttempt((count) => count + 1);
                      else setSandboxError(failure);
                    });
                }}
              >
                {sandboxPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Box />
                )}
                Create sandbox
              </Button>
            )}
          </div>
        )}
        {sandboxError !== null && (
          <p role="alert" className="text-destructive text-xs">
            {sandboxError}
          </p>
        )}
      </Part>

      {/*
        Enrichment: each source adds context the proposal and the sandbox
        are built from, and none of them is required.
      */}
      <Part title="Context">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Jira</span>
            {bounty.jira === null ? (
              <span className="font-medium">Not linked; written here</span>
            ) : (
              <span className="inline-flex items-center gap-1.5 font-medium">
                <span className="size-3.5 shrink-0">
                  <JiraIcon />
                </span>
                {followsJira
                  ? "Follows its Jira issue"
                  : "Gone from Jira; keeps its last text"}
              </span>
            )}
          </span>
          {bounty.jira?.url != null && (
            <Button variant="outline" size="sm" className="gap-1.5" asChild>
              <a
                href={bounty.jira.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                Open in Jira
                <ExternalLink className="size-3" />
              </a>
            </Button>
          )}
        </div>
        <p className="text-sm">
          <span className="text-muted-foreground">Repository </span>
          <span className="font-medium">
            {/*
              A repository that is removed clears the bounty's link, so one
              named but not listed is one the list has not shown yet.
            */}
            {repo?.fullName ??
              (bounty.repoId === null
                ? bounty.jira === null
                  ? "None"
                  : "Its board's, if it has one"
                : repos.loading
                  ? "…"
                  : "Unavailable")}
          </span>
        </p>
      </Part>

      <BountyText
        issueType={bounty.issueType}
        priority={bounty.priority}
        labels={bounty.labels}
        description={bounty.description}
        inputTruncated={bounty.inputTruncated}
      />

      {canManage && removable && (
        <div className="flex flex-col items-start">
          <ConfirmDialog
            trigger={
              <button
                type="button"
                className="text-muted-foreground hover:text-destructive cursor-pointer text-xs underline-offset-2 hover:underline"
              >
                Delete bounty
              </button>
            }
            title={`Delete ${bounty.key}?`}
            description="The bounty is removed from this workspace. A bounty with a proposal or a sandbox, or one being sized, cannot be deleted."
            confirmLabel="Delete bounty"
            onConfirm={async () => {
              // A failure stays in the dialog, which says it.
              const failure = await bounties.remove(bounty.id);
              if (failure !== null) return failure;
              onDeleted();
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * One part of a bounty in its peek: a heading over a card. A bounty is a
 * proposal and a sandbox, with context around them, and each is a part.
 */
function Part({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h3
        id={id}
        className="text-muted-foreground text-xs font-medium tracking-wide uppercase"
      >
        {title}
      </h3>
      <div className="flex flex-col gap-2 rounded-lg border p-4">
        {children}
      </div>
    </section>
  );
}

const fieldClass =
  "border-input focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm";

/**
 * A bounty's fields, for writing one or changing it. `textLocked` is a
 * bounty following its Jira issue: its text is Jira's, so only its
 * repository is offered.
 */
function BountyForm({
  repos,
  initial,
  initialError = null,
  textLocked = false,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  repos: GithubRepos;
  initial?: BountyDto;
  /** What the form opens saying, as after a save that lost a race. */
  initialError?: string | null;
  textLocked?: boolean;
  submitLabel: string;
  /** Resolves to null when saved, or to what to say. */
  onSubmit: (draft: BountyDraft) => Promise<string | null>;
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
      data-testid="bounty-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (title.trim() === "") {
          setError("A bounty needs a title.");
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
        if (!textLocked && labelList.length > BOUNTY_LIMITS.labels) {
          setError(`A bounty takes at most ${BOUNTY_LIMITS.labels} labels.`);
          return;
        }
        if (
          !textLocked &&
          labelList.some((label) => label.length > BOUNTY_LIMITS.label)
        ) {
          setError(
            `A label is at most ${BOUNTY_LIMITS.label} characters long.`,
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
          This bounty follows its Jira issue, so its text is changed in Jira.
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
              maxLength={BOUNTY_LIMITS.title}
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
                list="bounty-issue-types"
                maxLength={BOUNTY_LIMITS.issueType}
                disabled={textLocked}
                onChange={(event) => setIssueType(event.target.value)}
              />
              <datalist id="bounty-issue-types">
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
        hint="The code the bounty is about. Its spec is drafted beside an outline of it."
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
              maxLength={BOUNTY_LIMITS.description}
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
