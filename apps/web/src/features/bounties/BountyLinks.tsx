/**
 * What a bounty is linked to, under its text on its page: the workspace's
 * repositories, and the Jira issue it follows. One framed group, a row
 * each: the source named on the left, with one line saying where the link
 * stands, and what changes it on the right. Neither is required.
 *
 * A bounty names no repository: its work may touch any the workspace has
 * connected, and its sizing says which. So the repositories' row picks
 * nothing; it says how many there are, and leads to the workspace's GitHub
 * settings, where they are connected. The issue is picked, and saves as it
 * is: it is searched for across every board the workspace has, as typed, in
 * the rows the board's own search uses: key, summary, board. Under the
 * results sits the way to the workspace's Jira settings, where accounts are
 * connected and managed. Linking an issue makes the bounty follow it, so a
 * bounty with text of its own asks first: Jira's replaces it.
 *
 * Under each row, the source's sync: whether its context is in use and up
 * to date, and the way to sync it into the overview (`ContextSync`).
 */

import {
  isWorkspaceSource,
  type BountyDto,
  type MembershipDto,
} from "@sandbox-factory/shared";
import { ApiError } from "@sandbox-factory/client";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ExternalLink,
  Loader2,
  Plus,
  Settings,
  Unlink,
} from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";

import {
  Combobox,
  comboboxTriggerClass,
  type ComboboxAction,
  type ComboboxOption,
} from "@/components/Combobox";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { clients, queryKeys, useUserId } from "../../data/query";
import { JiraIcon, ProviderIcon } from "../../ProviderIcon";
import {
  isPlainLeftClick,
  pathForScreen,
  type ConnectionTab,
} from "../../routes";
import type { Bounties } from "../../useBounties";
import type { GithubRepos } from "../../useGithub";
import { useJira } from "../../useJira";
import { ContextSync, type BountyContextState } from "./BountyContext";

/** Opens a tab of the workspace's settings. */
export type OpenSettings = (tab: ConnectionTab) => void;

/** The links under a bounty's text: the repositories, then its Jira issue. */
export function BountyLinks({
  organization,
  bounty,
  bounties,
  repos,
  onChange,
  onOpenSettings,
  context,
  locked = false,
}: {
  organization: MembershipDto;
  bounty: BountyDto;
  bounties: Bounties;
  repos: GithubRepos;
  /** Holds the bounty as a link or its removal returned it. */
  onChange: (bounty: BountyDto) => void;
  onOpenSettings: OpenSettings;
  /** Where each source's sync stands, and the way to sync it. */
  context?: BountyContextState | undefined;
  /** Its overview is approved: the links are shown, not changed. */
  locked?: boolean;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="text-sm font-medium">
        Links
      </h3>
      <div className="divide-y rounded-lg border">
        <RepositoriesLink
          organization={organization}
          repos={repos}
          onOpenSettings={onOpenSettings}
          sync={
            context === undefined ? null : (
              <ContextSync source="github" context={context} canSync />
            )
          }
        />
        <JiraLink
          organization={organization}
          bounty={bounty}
          bounties={bounties}
          onChange={onChange}
          onOpenSettings={onOpenSettings}
          locked={locked}
          sync={
            context === undefined ? null : (
              <ContextSync
                source="jira"
                context={context}
                canSync={bounty.jira !== null && bounty.jira.removedAt === null}
              />
            )
          }
        />
      </div>
    </section>
  );
}

/**
 * One source: its mark and name over one line on the link, and its picker
 * beside them, as wide as the other row's so the two line up. Under them
 * on a narrow screen.
 */
function LinkRow({
  icon,
  title,
  titleId,
  description,
  busy,
  error,
  control,
  sync,
}: {
  icon: ReactNode;
  title: string;
  titleId: string;
  description: ReactNode;
  busy: boolean;
  error: string | null;
  control: ReactNode;
  /** The source's sync, under the row. */
  sync?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span
            id={titleId}
            className="flex items-center gap-2 text-sm font-medium"
          >
            <span className="flex size-4 shrink-0 items-center [&_svg]:size-4">
              {icon}
            </span>
            {title}
            {busy && (
              <Loader2 className="text-muted-foreground size-3 animate-spin" />
            )}
          </span>
          <span className="text-muted-foreground truncate text-xs">
            {description}
          </span>
        </div>
        <div className="w-full sm:w-64 sm:shrink-0">{control}</div>
      </div>
      {error !== null && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      {sync}
    </div>
  );
}

function settingsHref(organization: MembershipDto, tab: ConnectionTab) {
  return pathForScreen("org-settings", organization.slug, undefined, tab);
}

/**
 * The workspace's repositories, any of which the bounty's work may touch:
 * how many, and the way to its GitHub settings, where one is connected.
 */
function RepositoriesLink({
  organization,
  repos,
  onOpenSettings,
  sync,
}: {
  organization: MembershipDto;
  repos: GithubRepos;
  onOpenSettings: OpenSettings;
  sync: ReactNode;
}) {
  const titleId = useId();
  const sources = repos.repos.filter(isWorkspaceSource);
  const [only] = sources;
  const description = repos.loading
    ? "Loading repositories…"
    : sources.length === 0
      ? "No repository is connected to the workspace."
      : sources.length === 1 && only !== undefined
        ? `${only.fullName}: sizing says whether the work touches it.`
        : `All ${sources.length} of the workspace's: sizing says which the work touches.`;
  return (
    <LinkRow
      icon={<ProviderIcon provider="github" />}
      title="Repositories"
      titleId={titleId}
      description={description}
      busy={false}
      error={null}
      sync={sync}
      control={
        <a
          href={settingsHref(organization, "github")}
          aria-describedby={titleId}
          className={cn(
            buttonVariants({ variant: "outline" }),
            "w-full justify-start",
          )}
          onClick={(event) => {
            if (!isPlainLeftClick(event)) return;
            event.preventDefault();
            onOpenSettings("github");
          }}
        >
          {sources.length === 0 ? <Plus /> : <Settings />}
          {sources.length === 0
            ? "Connect a repository"
            : "Manage repositories"}
        </a>
      }
    />
  );
}

/** The value an issue is picked by: the board it was found on, and its id. */
function issueValue(issue: { boardId: string; id: string }): string {
  return `${issue.boardId}:${issue.id}`;
}

/** The value while the issue followed is not among the results, or none is. */
const UNLISTED = "";

/**
 * The Jira issue the bounty follows, searched for across the workspace's
 * boards. The same picker whatever the workspace has connected: with no
 * account, its list says so and leads to settings.
 */
function JiraLink({
  organization,
  bounty,
  bounties,
  onChange,
  onOpenSettings,
  locked,
  sync,
}: {
  organization: MembershipDto;
  bounty: BountyDto;
  bounties: Bounties;
  onChange: (bounty: BountyDto) => void;
  onOpenSettings: OpenSettings;
  locked: boolean;
  sync: ReactNode;
}) {
  const titleId = useId();
  const userId = useUserId();
  const jira = useJira(organization.id);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An issue picked for a bounty with text of its own, waiting on the question.
  const [asking, setAsking] = useState<{
    boardId: string;
    issueId: string;
    key: string;
  } | null>(null);

  /*
    Searched as the person types, a quarter-second after they stop. The
    query key is the search, so an answer to an older one is never shown
    for a newer one.
  */
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const connected = jira.connections.length > 0;
  const found = useQuery({
    queryKey: queryKeys.resource(
      userId,
      organization.id,
      "jira-search-all",
      search,
    ),
    enabled: connected && search !== "",
    queryFn: ({ signal }) =>
      clients.jira.searchAll(organization.id, search, signal),
  });
  const searching =
    query.trim() !== "" && (search !== query.trim() || found.isFetching);
  const results = search === "" ? [] : (found.data ?? []);

  const link = bounty.jira;
  const follows = link !== null && link.removedAt === null;

  // As the board's own search lists them: key, summary, and what sets
  // them apart, here the board.
  const options: ComboboxOption[] = results.map((issue) => {
    const elsewhere = issue.bountyId !== null && issue.bountyId !== bounty.id;
    return {
      value: issueValue(issue),
      label: issue.summary,
      keywords: [issue.key, issue.boardName],
      icon: (
        <span className="text-muted-foreground w-16 truncate font-mono text-xs">
          {issue.key}
        </span>
      ),
      detail: elsewhere ? "Another bounty's" : issue.boardName,
      disabled: elsewhere,
    };
  });
  const linked = results.find((issue) => issue.bountyId === bounty.id);
  const value = linked === undefined ? UNLISTED : issueValue(linked);

  const save = async (
    send: () => ReturnType<Bounties["linkJira"]>,
  ): Promise<string | null> => {
    setSaving(true);
    setError(null);
    const result = await send();
    setSaving(false);
    if (!result.ok) return result.error;
    onChange(result.bounty);
    return null;
  };

  const pick = (next: string) => {
    const issue = results.find((result) => issueValue(result) === next);
    if (issue === undefined) return;
    const chosen = { boardId: issue.boardId, issueId: issue.id };
    // Its text is Jira's already while it follows an issue: nothing of its
    // own is replaced.
    if (follows) {
      void save(() => bounties.linkJira(bounty.id, chosen)).then(setError);
    } else {
      setAsking({ ...chosen, key: issue.key });
    }
  };

  const actions: ComboboxAction[] = [
    ...(link === null
      ? []
      : [
          {
            key: "unlink",
            label: "Remove the link",
            icon: <Unlink />,
            onSelect: () => {
              void save(() => bounties.unlinkJira(bounty.id)).then(setError);
            },
          },
        ]),
    connected
      ? {
          key: "jira-settings",
          label: "Manage Jira accounts",
          icon: <Settings />,
          href: settingsHref(organization, "jira"),
          onSelect: () => onOpenSettings("jira"),
        }
      : {
          key: "jira-settings",
          label: "Connect Jira in settings",
          icon: <Plus />,
          href: settingsHref(organization, "jira"),
          onSelect: () => onOpenSettings("jira"),
        },
  ];

  const description =
    link === null ? (
      connected || jira.loading ? (
        "The issue the bounty follows, from any board."
      ) : (
        "No Jira account is connected to the workspace."
      )
    ) : follows ? (
      <>
        Its title and description follow{" "}
        {link.url === null ? (
          <span className="text-foreground font-mono">{link.key}</span>
        ) : (
          <a
            href={link.url}
            target="_blank"
            rel="noreferrer noopener"
            className="text-foreground inline-flex items-center gap-1 font-mono underline-offset-2 hover:underline"
          >
            {link.key}
            <ExternalLink className="size-3" />
          </a>
        )}
        .
      </>
    ) : (
      `${link.key} is gone from Jira; the bounty keeps its last text.`
    );

  const trigger = (
    <button
      type="button"
      aria-label="Jira issue"
      aria-describedby={titleId}
      className={comboboxTriggerClass}
    >
      {link === null ? (
        <span className="text-muted-foreground min-w-0 flex-1 truncate">
          None
        </span>
      ) : (
        <>
          <span className="flex shrink-0 items-center">
            <JiraIcon />
          </span>
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              !follows && "text-muted-foreground line-through",
            )}
          >
            {link.key}
          </span>
        </>
      )}
      <ChevronDown aria-hidden="true" className="text-muted-foreground" />
    </button>
  );

  return (
    <>
      <LinkRow
        icon={<JiraIcon />}
        title="Jira issue"
        titleId={titleId}
        description={description}
        busy={saving}
        error={error}
        sync={sync}
        control={
          <Combobox
            label="Jira issue"
            trigger={trigger}
            filter={false}
            onSearchChange={setQuery}
            searchPlaceholder="Search by key or title…"
            emptyMessage={
              !connected
                ? jira.loading
                  ? "Reading the workspace's Jira accounts…"
                  : "No Jira account is connected."
                : query.trim() === ""
                  ? "Type a key, or words from a title."
                  : searching
                    ? "Searching…"
                    : found.isError
                      ? found.error instanceof ApiError
                        ? found.error.message
                        : "Could not reach the server."
                      : "No issue matches."
            }
            contentClassName="w-[26rem]"
            align="end"
            options={options}
            actions={actions}
            value={value}
            disabled={saving || locked}
            onValueChange={pick}
          />
        }
      />
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open) setAsking(null);
        }}
        title={`Link ${asking?.key ?? "the issue"}?`}
        description={`The bounty follows the issue once it is linked: ${asking?.key ?? "its"} title and description replace the ones written here. Removing the link later keeps whatever text it has then.`}
        confirmLabel="Link issue"
        pendingLabel="Linking…"
        onConfirm={async () => {
          if (asking === null) return;
          const failure = await save(() =>
            bounties.linkJira(bounty.id, {
              boardId: asking.boardId,
              issueId: asking.issueId,
            }),
          );
          if (failure !== null) return failure;
        }}
      />
    </>
  );
}
