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
 * bounty with text of its own asks first: Jira's replaces it. Text edited
 * here is the bounty's own too: Jira no longer updates it, until an issue
 * is picked again.
 *
 * Under each row, the source's context: whether it is in use and up to
 * date, and the way to bring it into the scope (`ContextSync`): syncing the
 * issue, in its row's menu, and picking each repository's commit.
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
import {
  ContextSync,
  ContextSyncMenu,
  type BountyContextState,
} from "./BountyContext";

/** Opens a tab of the workspace's settings. */
export type OpenSettings = (tab: ConnectionTab) => void;

/** The links under a bounty's text: its Jira issue, then the repositories. */
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
  /** Its scope is approved: the links are shown, not changed. */
  locked?: boolean;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      {/* Ruled under its heading, as the task's text is. */}
      <h3
        id={headingId}
        className="eyebrow flex min-h-9 items-center border-b pb-2"
      >
        Links
      </h3>
      <div className="flex flex-col">
        <JiraLink
          organization={organization}
          bounty={bounty}
          bounties={bounties}
          onChange={onChange}
          onOpenSettings={onOpenSettings}
          locked={locked}
          sync={
            context === undefined ? null : (
              <ContextSync source="jira" context={context} />
            )
          }
          menu={
            context === undefined ? null : (
              <ContextSyncMenu
                source="jira"
                context={context}
                canSync={bounty.jira !== null && bounty.jira.removedAt === null}
              />
            )
          }
        />
        <RepositoriesLink
          organization={organization}
          repos={repos}
          onOpenSettings={onOpenSettings}
          sync={
            context === undefined ? null : (
              <ContextSync
                source="github"
                context={context}
                organization={organization}
              />
            )
          }
          menu={null}
        />
      </div>
    </section>
  );
}

/**
 * One source, on three columns every row shares: its mark; its name over
 * one line on the link, with its sync under them; and its control, as wide
 * as the other row's so the two line up. The control goes under the name on
 * a narrow screen.
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
  menu,
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
  /** Its other actions, beside the control. */
  menu?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-3 gap-y-2 py-3 sm:grid-cols-[1rem_minmax(0,1fr)_14rem] sm:gap-x-4">
      <span className="flex h-5 items-center [&_svg]:size-4">{icon}</span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span
          id={titleId}
          className="flex h-5 items-center gap-2 text-sm font-medium"
        >
          {title}
          {busy && (
            <Loader2 className="text-muted-foreground size-3 animate-spin" />
          )}
        </span>
        <span className="text-muted-foreground truncate text-xs">
          {description}
        </span>
      </div>
      {/*
        The control and its menu as one split button: the control's right
        corners squared where the menu's half joins it, on one shared border.
      */}
      <div className="col-start-2 flex sm:col-start-3 sm:row-start-1">
        <div
          className={cn(
            "min-w-0 flex-1",
            menu !== null && menu !== undefined && "*:rounded-r-none",
          )}
        >
          {control}
        </div>
        {menu}
      </div>
      {error !== null && (
        <p
          role="alert"
          className="text-destructive col-span-full col-start-2 text-xs"
        >
          {error}
        </p>
      )}
      {sync !== null && sync !== undefined && (
        <div className="col-span-full col-start-2">{sync}</div>
      )}
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
  menu,
}: {
  organization: MembershipDto;
  repos: GithubRepos;
  onOpenSettings: OpenSettings;
  sync: ReactNode;
  menu: ReactNode;
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
      menu={menu}
      control={
        <a
          href={settingsHref(organization, "github")}
          aria-describedby={titleId}
          className={cn(
            buttonVariants({ variant: "outline" }),
            // The input's border, as the Jira picker and the menu have.
            "border-input w-full justify-start",
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

/** The issue linked now, listed on its own before anything is searched. */
const CURRENT = "current";

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
  menu,
}: {
  organization: MembershipDto;
  bounty: BountyDto;
  bounties: Bounties;
  onChange: (bounty: BountyDto) => void;
  onOpenSettings: OpenSettings;
  locked: boolean;
  sync: ReactNode;
  menu: ReactNode;
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
  // Its text is still the issue's, not edited here since.
  const textFollows = follows && !bounty.textEdited;

  /*
    Before anything is typed, the list opens on the issue linked now, chosen,
    rather than on a hint: picking it again changes nothing. Its summary is
    not known here, so the bounty's title stands in while it follows it.
  */
  const current: ComboboxOption | null =
    link === null || search !== ""
      ? null
      : {
          value: CURRENT,
          label: textFollows
            ? bounty.title
            : follows
              ? "Linked; its text was edited here"
              : "Gone from Jira",
          icon: (
            <span className="text-muted-foreground w-16 truncate font-mono text-xs">
              {link.key}
            </span>
          ),
        };
  // As the board's own search lists them: key, summary, and what sets
  // them apart, here the board.
  const searched: ComboboxOption[] = results.map((issue) => {
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
  const options = current === null ? searched : [current];
  const linked = results.find((issue) => issue.bountyId === bounty.id);
  const value =
    current !== null
      ? CURRENT
      : linked === undefined
        ? UNLISTED
        : issueValue(linked);

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
    if (textFollows) {
      void save(() => bounties.linkJira(bounty.id, chosen)).then(setError);
    } else {
      setAsking({ ...chosen, key: issue.key });
    }
  };

  // The accounts first, and removing the link last, in red: never what a
  // stray Enter lands on.
  const actions: ComboboxAction[] = [
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
    ...(link === null
      ? []
      : [
          {
            key: "unlink",
            label: "Remove the link",
            icon: <Unlink />,
            destructive: true,
            onSelect: () => {
              void save(() => bounties.unlinkJira(bounty.id)).then(setError);
            },
          },
        ]),
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
        {textFollows ? "Its title and description follow " : "Linked to "}
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
        {textFollows
          ? "."
          : ". Its text was edited here, so Jira no longer updates it."}
      </>
    ) : (
      `${link.key} is gone from Jira; the bounty keeps its last text.`
    );

  const trigger = (
    <button
      type="button"
      aria-label="Jira issue"
      aria-describedby={titleId}
      // Its ring over the menu's half, not under it.
      className={cn(
        comboboxTriggerClass,
        "relative focus-visible:z-10 data-[state=open]:z-10",
      )}
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
        menu={menu}
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
            // To the menu's edge, as wide as the whole split button.
            alignOffset={-31}
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
