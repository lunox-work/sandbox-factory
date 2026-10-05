import { rankAtLeast } from "sandbox-factory";
import {
  pushLocation,
  replaceLocation,
  updateSearch,
  useLocation,
} from "./navigation/location";
/**
 * The person's bounties from every workspace they are in, and the proposals
 * made from them. A team workspace's bounty is tagged with the workspace's
 * name; a personal one's is not, since that one is simply the person's own.
 *
 * A bounty is the platform's own record of a piece of work. It is written
 * here, or imported from Jira when a board's run reaches it, and either way
 * it is the same two parts: a proposal, which specifies and prices it, and a
 * sandbox, which contributors work in. An open bounty shows those two, and
 * beside them the context that sources add. Nothing on this page needs Jira
 * or GitHub; a bounty from Jira links to its issue, and one about a
 * repository is drafted beside an outline of it and cut from it.
 *
 * The page lists bounties only, a card each, one to a row. A proposal is made from a bounty
 * and lives inside it: an open bounty shows its proposal in full under its
 * text, and proposing a bounty follows its sizing run and then shows the
 * proposal in the same place.
 *
 * A bounty opens in a panel over the list, `/bounties?peek=acme/bty_1`, or as
 * a page of its own, `/bounties/acme/bty_1`, which the panel opens and whose
 * trail leads back to the list. The workspace is named because a bounty is
 * read and changed through its own workspace's routes. A new bounty is
 * written on a page of its own, `/bounties/new`, and opens here once it is
 * saved.
 */

import type {
  BountyDto,
  MembershipDto,
  BountySandboxSummaryDto,
  BountySummaryDto,
} from "@sandbox-factory/shared";
import { BOUNTY_LIMITS, sameStackName } from "sandbox-factory";
import {
  Box,
  ExternalLink,
  Inbox,
  Link2,
  Loader2,
  Maximize2,
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
  type ReactElement,
  type ReactNode,
} from "react";

import { Combobox } from "@/components/Combobox";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorBanner, LoadingLine } from "@/components/Message";
import {
  PEEK_ACTION_CLASS,
  PEEK_ROW_ATTRIBUTE,
  PeekPanel,
} from "@/components/PeekPanel";
import { StackPicker } from "@/components/StackPicker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import {
  orderWorkspaces,
  workspaceLabel,
  WorkspaceFace,
  type Viewer,
} from "./OrganizationSwitcher";
import { money } from "./Proposals";
import { JiraIcon } from "./ProviderIcon";
import {
  BOUNTIES_PATH,
  bountiesUrl,
  bountyForPath,
  bountyForSearch,
  bountyPagePath,
  bountyProposalPath,
  isPlainLeftClick,
  NEW_BOUNTY_PATH,
  pathForScreen,
  type BountyAddress,
} from "./routes";
import { clients } from "./data/query";
import {
  InlineDescription,
  InlineTitle,
  RepositoryField,
  repositoryOptions,
  StackField,
  type SaveField,
} from "./features/bounties/BountyFields";
import { BountyProposal } from "./features/bounties/BountyProposal";
import { SandboxCard } from "./features/bounties/SandboxCard";
import { SandboxGeneration } from "./features/bounties/SandboxGeneration";
import { useGithubRepos, type GithubRepos } from "./useGithub";
import {
  useAllBounties,
  useBounties,
  type AllBounties,
  type BountyDraft,
  type Bounties,
} from "./useBounties";

/** How a sandbox's status reads. */
const SANDBOX_STATUS_LABEL: Record<BountySandboxSummaryDto["status"], string> =
  { draft: "Draft", published: "Published", closed: "Closed" };

/**
 * The tabs a bounty's own page splits it into: what it is and where it
 * came from, what it pays and why, and where the work is done.
 */
const PAGE_TABS = [
  { value: "overview", label: "Overview" },
  { value: "bounty", label: "Bounty" },
  { value: "sandbox", label: "Sandbox" },
] as const;
type PageTab = (typeof PAGE_TABS)[number]["value"];

/** The tab `?tab=` names, or the overview when it names none. */
function pageTabFrom(search: string): PageTab {
  const value = new URLSearchParams(search).get("tab");
  return PAGE_TABS.find((tab) => tab.value === value)?.value ?? "overview";
}

/** Opens a tab in the address, so Back returns to the one before. */
function selectPageTab(next: string) {
  updateSearch((params) => {
    if (next === "overview") params.delete("tab");
    else params.set("tab", next);
  });
}

function canManage(role: string): boolean {
  return rankAtLeast(role, "admin");
}

/** Enough of a bounty to open it: which one, and whose. */
type OpenedBounty = Pick<BountySummaryDto, "id" | "organizationId">;

/** The workspace an address names by its handle, in any case. */
function workspaceNamed(
  organizations: MembershipDto[],
  slug: string,
): MembershipDto | undefined {
  return organizations.find(
    (organization) => organization.slug.toLowerCase() === slug.toLowerCase(),
  );
}

/**
 * Where a bounty opens: its workspace's handle and its id. Undefined while
 * the workspace is not among those known.
 */
function addressOf(
  bounty: OpenedBounty,
  organizations: MembershipDto[],
): BountyAddress | undefined {
  const workspace = organizations.find(
    ({ id }) => id === bounty.organizationId,
  )?.slug;
  return workspace === undefined ? undefined : { workspace, id: bounty.id };
}

export function Bounties({
  organizations,
  active,
  organizationsLoading,
  viewer,
  onCreate,
  onOpenPage,
}: {
  /** Every workspace the person is in: whose bounties are listed. */
  organizations: MembershipDto[];
  /** The workspace in the rail, where a new bounty goes unless changed. */
  active: MembershipDto | null;
  organizationsLoading: boolean;
  /** Whoever is looking: the face their personal workspace wears. */
  viewer: Viewer;
  /** Opens the page a new bounty is written on. */
  onCreate: () => void;
  /** Opens a bounty's own page, with the list behind it in history. */
  onOpenPage: (path: string) => void;
}) {
  const bounties = useAllBounties();
  /*
    The bounty open over the list. In the query, so a reload or a link lands
    on it and Back steps out of it.
  */
  const { search } = useLocation();
  const peek = bountyForSearch(search) ?? null;
  /*
    The bounty the open peek last read. It names the panel when the bounty
    is not among the rows loaded, as for a link to an older one.
  */
  const [peeked, setPeeked] = useState<BountyDto | null>(null);
  const listed =
    peek === null
      ? undefined
      : bounties.bounties.find(({ id }) => id === peek.id);
  const shown =
    (peeked !== null && peeked.id === peek?.id ? peeked : undefined) ?? listed;
  const owner =
    peek === null ? undefined : workspaceNamed(organizations, peek.workspace);
  useLegacyProposal(search, organizations, organizationsLoading);

  /*
    Opening one from the list is a step Back undoes; moving from one open
    bounty to another replaces it, so Back closes the panel rather than
    walking through every card looked at.
  */
  const open = (address: BountyAddress | null) => {
    if (address !== null && peek !== null) {
      if (address.workspace === peek.workspace && address.id === peek.id) {
        return;
      }
      replaceLocation(bountiesUrl(address));
    } else {
      pushLocation(bountiesUrl(address));
    }
  };

  // Nowhere to write one until there is a workspace to write it in.
  const target = active ?? organizations[0] ?? null;

  return (
    // The panel sits beside the list rather than over it: on a screen wide
    // enough for both, the list makes room for it, as wide as the panel is.
    <div
      className={cn(
        "w-full transition-[padding] duration-300 motion-reduce:transition-none",
        peek !== null && "xl:pr-[42rem]",
      )}
    >
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10 sm:px-6 sm:py-14">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Bounties</h1>
            <p className="text-muted-foreground mt-1.5 max-w-prose text-sm">
              The work your workspaces want done, created in Lunox or imported
              from Jira. Each bounty is a proposal, which sizes and prices it,
              and a sandbox that contributors work in.
            </p>
          </div>
          <NewBountyLink disabled={target === null} onCreate={onCreate} />
        </header>

        <BountyList
          bounties={bounties}
          organizations={organizations}
          organizationsLoading={organizationsLoading}
          peek={peek}
          onOpen={open}
          onCreate={onCreate}
        />

        <PeekPanel
          // Beside the list, which stays live: another card shows in it.
          modal={false}
          open={peek !== null}
          onOpenChange={(next) => {
            if (!next) open(null);
          }}
          title={shown?.title ?? "Bounty"}
          // The open bounty shows its title itself, where it is renamed.
          titleHidden={peeked !== null && peeked.id === peek?.id}
          // Its Jira key, when it came from Jira; a bounty written here has none.
          description={shown?.jira?.key}
          actions={
            peek === null ? undefined : (
              <OpenAsPage href={bountyPagePath(peek)} onOpen={onOpenPage} />
            )
          }
          data-testid="bounty-panel"
        >
          {peek !== null &&
            (owner === undefined ? (
              organizationsLoading ? (
                <LoadingLine>Loading the bounty…</LoadingLine>
              ) : (
                <NotYours />
              )
            ) : (
              <OpenBounty
                // Keyed by both: the same id in another workspace is not this
                // bounty, and its actions go through that workspace's routes.
                key={`${owner.id}:${peek.id}`}
                layout="panel"
                organization={owner}
                viewer={viewer}
                bountyId={peek.id}
                listed={listed}
                onLoaded={setPeeked}
                onDeleted={() => open(null)}
              />
            ))}
        </PeekPanel>
      </main>
    </div>
  );
}

/**
 * A proposal named with no bounty, from when proposals had a list of their
 * own; `canonicalUrl` keeps it in the query with its workspace. It is read
 * for the bounty it belongs to, whose page then opens on its proposal, in
 * the address's place: a panel does not show the proposal. Only once the workspace is known: with none, there is
 * nowhere to read it from, and the address is dropped.
 */
function useLegacyProposal(
  search: string,
  organizations: MembershipDto[],
  organizationsLoading: boolean,
) {
  const params = new URLSearchParams(search);
  const proposalId = params.has("peek") ? null : params.get("proposal");
  const slug = params.get("workspace");
  const ownerId =
    slug === null ? undefined : workspaceNamed(organizations, slug)?.id;
  useEffect(() => {
    if (proposalId === null) return;
    if (slug === null || ownerId === undefined) {
      if (!organizationsLoading) replaceLocation(BOUNTIES_PATH);
      return;
    }
    let live = true;
    void clients.pricing.detail(ownerId, proposalId).then(
      ({ proposal }) => {
        if (live)
          replaceLocation(
            bountyProposalPath({ workspace: slug, id: proposal.bountyId }),
          );
      },
      () => {
        if (live) replaceLocation(BOUNTIES_PATH);
      },
    );
    return () => {
      live = false;
    };
  }, [proposalId, slug, ownerId, organizationsLoading]);
}

/** Said of an address naming a workspace the person is not in. */
function NotYours() {
  return (
    <p className="text-muted-foreground text-sm">
      This bounty is not in any of your workspaces.
    </p>
  );
}

/**
 * Opens the bounty in the panel as a page of its own. A link, so it can be
 * opened in another tab; a plain click stays in the app.
 */
function OpenAsPage({
  href,
  onOpen,
}: {
  href: string;
  onOpen: (path: string) => void;
}) {
  return (
    <a
      href={href}
      className={PEEK_ACTION_CLASS}
      aria-label="Open as page"
      title="Open as page"
      onClick={(event) => {
        if (isPlainLeftClick(event)) {
          event.preventDefault();
          onOpen(href);
        }
      }}
    >
      <Maximize2 className="size-4" />
    </a>
  );
}

/**
 * The way to the page a new bounty is written on. A link, so it can be
 * opened in another tab; a plain click stays in the app.
 */
function NewBountyLink({
  variant,
  disabled = false,
  onCreate,
}: {
  variant?: "outline";
  disabled?: boolean;
  onCreate: () => void;
}) {
  if (disabled) {
    return (
      <Button type="button" variant={variant} disabled>
        <Plus />
        New bounty
      </Button>
    );
  }
  return (
    <Button variant={variant} asChild>
      <a
        href={NEW_BOUNTY_PATH}
        onClick={(event) => {
          if (isPlainLeftClick(event)) {
            event.preventDefault();
            onCreate();
          }
        }}
      >
        <Plus />
        New bounty
      </a>
    </Button>
  );
}

/**
 * One bounty as a page of its own: what the panel over the list shows, with
 * the room of a page, the description beside the bounty's parts. The trail
 * above it leads back to the list.
 */
export function BountyPage({
  organizations,
  organizationsLoading,
  viewer,
  onTitle,
  onOpenBounties,
}: {
  /** Every workspace the person is in: the one the address names among them. */
  organizations: MembershipDto[];
  organizationsLoading: boolean;
  /** Whoever is looking: the face their personal workspace wears. */
  viewer: Viewer;
  /** Names the trail's last crumb and the document once the bounty is read. */
  onTitle: (title: string | undefined) => void;
  /** Back to the list, once the bounty is deleted. */
  onOpenBounties: () => void;
}) {
  const { pathname } = useLocation();
  const address = bountyForPath(pathname);
  const owner =
    address === undefined
      ? undefined
      : workspaceNamed(organizations, address.workspace);
  const [read, setRead] = useState<BountyDto | null>(null);
  // Only the bounty the address names: another's read must not linger.
  const bounty = read !== null && read.id === address?.id ? read : null;
  const title = bounty?.title;
  useEffect(() => {
    onTitle(title);
    return () => onTitle(undefined);
  }, [onTitle, title]);
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10 sm:px-6 sm:py-14">
      {/* Once its workspace is known, the open bounty heads its own page. */}
      {(address === undefined || owner === undefined) && <PageHeading />}
      {address !== undefined &&
        (owner === undefined ? (
          organizationsLoading ? (
            <LoadingLine>Loading the bounty…</LoadingLine>
          ) : (
            <NotYours />
          )
        ) : (
          <OpenBounty
            key={`${owner.id}:${address.id}`}
            layout="page"
            organization={owner}
            viewer={viewer}
            bountyId={address.id}
            onLoaded={setRead}
            onDeleted={onOpenBounties}
          />
        ))}
    </main>
  );
}

/**
 * A bounty page's heading until the bounty is read, and while it cannot be.
 */
function PageHeading() {
  return <h1 className="text-2xl font-semibold tracking-tight">Bounty</h1>;
}

/**
 * The page a new bounty is written on: the form, with room beside the
 * description for the rest of its fields. Once saved, the bounty opens on
 * the bounties page in this one's place, so Back from it returns to the
 * list rather than to an empty form.
 */
export function NewBountyPage({
  organizations,
  active,
  organizationsLoading,
  viewer,
  onCancel,
  onConnectRepository,
}: {
  /** Every workspace the person is in: where it may be written. */
  organizations: MembershipDto[];
  /** The workspace in the rail, where it goes unless changed. */
  active: MembershipDto | null;
  organizationsLoading: boolean;
  /** Whoever is writing it: the face their personal workspace wears. */
  viewer: Viewer;
  onCancel: () => void;
  /** Opens the GitHub settings of the workspace chosen. */
  onConnectRepository: (organization: MembershipDto) => void;
}) {
  // The workspace in the rail, or the first there is.
  const target = active ?? organizations[0] ?? null;
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-10 sm:px-6 sm:py-14">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">New bounty</h1>
        <p className="text-muted-foreground mt-1.5 max-w-prose text-sm">
          Only the title is required. The more the description says, the better
          the proposal.
        </p>
      </header>
      {organizationsLoading ? (
        <LoadingLine />
      ) : target === null ? (
        <p className="text-muted-foreground text-sm">
          You are not in a workspace yet.
        </p>
      ) : (
        <NewBounty
          organizations={organizations}
          viewer={viewer}
          initial={target.id}
          onCancel={onCancel}
          onConnectRepository={onConnectRepository}
          onCreated={(bounty) => {
            replaceLocation(
              bountiesUrl(addressOf(bounty, organizations) ?? null),
            );
          }}
        />
      )}
    </main>
  );
}

/**
 * A new bounty, in the workspace chosen for it. The repositories offered are
 * that workspace's, so they follow the choice, and a repository it lacks is
 * connected in its settings.
 */
function NewBounty({
  organizations,
  viewer,
  initial,
  onCancel,
  onConnectRepository,
  onCreated,
}: {
  organizations: MembershipDto[];
  viewer: Viewer;
  /** The workspace chosen until another is. */
  initial: string;
  onCancel: () => void;
  onConnectRepository: (organization: MembershipDto) => void;
  onCreated: (bounty: BountyDto) => void;
}) {
  const [organizationId, setOrganizationId] = useState(initial);
  const bounties = useBounties(organizationId);
  const repos = useGithubRepos(organizationId);
  const chosen = organizations.find(({ id }) => id === organizationId);
  return (
    <BountyForm
      layout="page"
      repos={repos}
      // Shown even with one to choose from, so it says where the bounty goes.
      workspace={{
        organizations,
        viewer,
        value: organizationId,
        onChange: setOrganizationId,
      }}
      newRepository={
        chosen === undefined
          ? undefined
          : {
              href: pathForScreen(
                "org-settings",
                chosen.slug,
                undefined,
                undefined,
                "github",
              ),
              onOpen: () => onConnectRepository(chosen),
            }
      }
      submitLabel="Create bounty"
      onCancel={onCancel}
      onSubmit={async (draft) => {
        const result = await bounties.create(draft);
        if (!result.ok) return result.error;
        onCreated(result.bounty);
        return null;
      }}
    />
  );
}

/**
 * One bounty, read when it opens and again on `reload`, since a change made
 * from its other tab can move it. Shown at once from its last read while it
 * is read again, as when a panel is opened as a page.
 */
function useBountyRead(bounties: Bounties, bountyId: string) {
  const [bounty, setBounty] = useState<BountyDto | null>(
    () => bounties.cached(bountyId) ?? null,
  );
  /*
    The read found nothing to show. `notFound` is a bounty that is gone;
    anything else failed and is worth trying again.
  */
  const [failure, setFailure] = useState<{ notFound: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
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

  const reload = useCallback(() => setAttempt((count) => count + 1), []);
  const retry = useCallback(() => {
    setFailure(null);
    setAttempt((count) => count + 1);
  }, []);
  return { bounty, failure, set: setBounty, reload, retry };
}

/**
 * An open bounty, in the panel over the list or on its own page, read and
 * changed through the workspace it belongs to, as the person's role there
 * allows. A panel is a read-only glance without its proposal; its page has
 * the proposal, and is where it is changed.
 */
function OpenBounty({
  layout,
  organization,
  viewer,
  bountyId,
  listed,
  onLoaded,
  onDeleted,
}: {
  layout: "panel" | "page";
  organization: MembershipDto;
  viewer: Viewer;
  bountyId: string;
  /** Its card in the list, if it has one: names its proposal before the read. */
  listed?: BountySummaryDto | undefined;
  onLoaded: (bounty: BountyDto) => void;
  onDeleted: () => void;
}) {
  const bounties = useBounties(organization.id);
  const repos = useGithubRepos(organization.id);
  const manages = canManage(organization.role);
  const opened = useBountyRead(bounties, bountyId);
  const { bounty, failure } = opened;
  /*
    A proposal made since the bounty was read, and one removed since. The
    bounty names either as it was until it is read again; until then, these
    say which proposal it has. An id is never reused, so a removed one is
    held for good.
  */
  const [landed, setLanded] = useState<string | null>(null);
  const [removed, setRemoved] = useState<string | null>(null);
  const named = bounty?.proposal?.id ?? listed?.proposal?.id ?? null;
  const proposalId = landed ?? (named === removed ? null : named);

  useEffect(() => {
    if (bounty !== null) onLoaded(bounty);
  }, [bounty, onLoaded]);

  const heading = layout === "page" && <PageHeading />;

  if (failure?.notFound === true) {
    return (
      <>
        {heading}
        <p className="text-muted-foreground text-sm">
          This bounty no longer exists.
        </p>
      </>
    );
  }

  if (bounty === null) {
    return failure === null ? (
      <>
        {heading}
        <LoadingLine>Loading the bounty…</LoadingLine>
      </>
    ) : (
      <div className="flex flex-col items-start gap-3">
        {heading}
        <ErrorBanner className="mt-0">Could not load the bounty.</ErrorBanner>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={opened.retry}
        >
          <RefreshCw />
          Try again
        </Button>
      </div>
    );
  }

  return (
    <BountyDetail
      layout={layout}
      organization={organization}
      viewer={viewer}
      bounty={bounty}
      bounties={bounties}
      repos={repos}
      canManage={manages}
      proposal={
        proposalId === null ? null : (
          <BountyProposal
            key={proposalId}
            organizationId={organization.id}
            proposalId={proposalId}
            bountyKey={bounty.jira?.key}
            bountyTitle={bounty.title}
            canDecide={manages}
            onChanged={() => {
              void bounties.refresh();
              opened.reload();
            }}
            onRemoved={() => {
              void bounties.refresh();
              setLanded(null);
              setRemoved(proposalId);
              opened.reload();
            }}
          />
        )
      }
      onChange={opened.set}
      onReload={opened.reload}
      onProposed={(id) => {
        setLanded(id);
        opened.reload();
      }}
      onDeleted={onDeleted}
    />
  );
}

function BountyList({
  bounties,
  organizations,
  organizationsLoading,
  peek,
  onOpen,
  onCreate,
}: {
  bounties: AllBounties;
  organizations: MembershipDto[];
  organizationsLoading: boolean;
  /** The bounty open in the panel, whose card is marked; null for none. */
  peek: BountyAddress | null;
  onOpen: (address: BountyAddress) => void;
  onCreate: () => void;
}) {
  const [loadingMore, setLoadingMore] = useState(false);
  // A card opens at its workspace's handle, so it waits for the workspaces.
  if (bounties.loading || organizationsLoading) {
    return <LoadingLine>Loading bounties…</LoadingLine>;
  }
  return (
    <div className="flex flex-col gap-4">
      {bounties.error !== null && (
        <ErrorBanner className="mt-0">{bounties.error}</ErrorBanner>
      )}
      {bounties.bounties.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-10 text-center">
          <p className="text-muted-foreground text-sm">
            No bounties yet. Write one, or connect Jira and its boards&rsquo;
            bounties arrive here as they are sized.
          </p>
          <NewBountyLink variant="outline" onCreate={onCreate} />
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-2" data-testid="bounty-list">
            {bounties.bounties.map((bounty) => {
              const address = addressOf(bounty, organizations);
              return (
                <BountyCard
                  key={bounty.id}
                  bounty={bounty}
                  workspace={teamName(organizations, bounty.organizationId)}
                  address={address}
                  selected={
                    address !== undefined &&
                    peek !== null &&
                    address.workspace === peek.workspace &&
                    address.id === peek.id
                  }
                  onOpen={onOpen}
                />
              );
            })}
          </ul>
          {bounties.more && (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={loadingMore}
                onClick={() => {
                  setLoadingMore(true);
                  void bounties.loadMore().finally(() => setLoadingMore(false));
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
  );
}

/**
 * The tag a bounty carries: its workspace's name when that is a team, and
 * none when it is the person's own.
 */
function teamName(
  organizations: MembershipDto[],
  organizationId: string,
): string | undefined {
  const organization = organizations.find(({ id }) => id === organizationId);
  return organization?.kind === "team" ? organization.name : undefined;
}

/** A team workspace's name, as a bounty's card carries it. */
function WorkspaceTag({ name }: { name: string }) {
  return (
    <Badge
      variant="outline"
      className="text-muted-foreground max-w-40 px-1.5 py-0 font-normal"
    >
      <span className="truncate">{name}</span>
    </Badge>
  );
}

/** Where a bounty came from, said in a few words. */
function Source({ bounty }: { bounty: BountySummaryDto }) {
  if (bounty.jira === null) {
    return (
      <span className="text-muted-foreground text-xs">Created in Lunox</span>
    );
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
 * A proposal in brief: whether it is decided, and its price. Its size is
 * in the bounty, not on its card.
 */
function ProposalBrief({
  proposal,
}: {
  proposal: NonNullable<BountySummaryDto["proposal"]>;
}) {
  return (
    <>
      <Badge variant={proposal.status === "approved" ? "default" : "secondary"}>
        {proposal.status === "approved" ? "Approved" : "Proposed"}
      </Badge>
      <span className="ml-auto text-sm font-medium tabular-nums">
        {money(proposal.amountMinor, proposal.currency)}
      </span>
    </>
  );
}

/**
 * One bounty in the list, as a card the width of the list: its title with
 * where it came from under it, and its proposal at the far end. A click
 * anywhere on it opens the bounty over the list, its proposal with it; it is
 * a link to the bounty's own page, so it can be opened in another tab. While
 * the panel is open, a click on another card shows that one in it instead.
 * A bounty is proposed from inside it, never from its card.
 */
function BountyCard({
  bounty,
  workspace,
  address,
  selected,
  onOpen,
}: {
  bounty: BountySummaryDto;
  /** The team workspace it belongs to; absent for the person's own. */
  workspace: string | undefined;
  /** Where it opens; undefined while its workspace is not known. */
  address: BountyAddress | undefined;
  /** It is the bounty open in the panel. */
  selected: boolean;
  onOpen: (address: BountyAddress) => void;
}) {
  const { proposal, sandbox } = bounty;
  const heading = (
    <span className="line-clamp-2 text-sm font-medium sm:line-clamp-1">
      {bounty.title}
    </span>
  );
  const headingClass = "flex min-w-0";
  return (
    // `relative` for the link's overlay, which makes the whole card its target.
    <li
      {...{ [PEEK_ROW_ATTRIBUTE]: "" }}
      className={cn(
        "bg-card hover:bg-muted/40 relative flex flex-col gap-3 rounded-lg border px-4 py-3 transition-colors sm:flex-row sm:items-center sm:gap-6",
        selected && "bg-muted/60 hover:bg-muted/60 border-foreground/20",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {address === undefined ? (
          <div className={headingClass}>{heading}</div>
        ) : (
          <a
            href={bountyPagePath(address)}
            aria-current={selected ? "true" : undefined}
            className={cn(
              headingClass,
              "focus-visible:after:ring-ring/50 outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-[3px]",
            )}
            onClick={(event) => {
              if (isPlainLeftClick(event)) {
                event.preventDefault();
                onOpen(address);
              }
            }}
          >
            {heading}
          </a>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {workspace !== undefined && <WorkspaceTag name={workspace} />}
          <Source bounty={bounty} />
          {sandbox !== null && (
            <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
              <Box className="size-3" />
              Sandbox {SANDBOX_STATUS_LABEL[sandbox.status]}
            </span>
          )}
        </div>
      </div>
      <div className="shrink-0 border-t pt-3 sm:w-56 sm:border-t-0 sm:pt-0">
        {proposal === null ? (
          // Shaped like a proposal's brief, so its status and price line up.
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className="text-muted-foreground border-dashed font-normal"
            >
              No proposal
            </Badge>
            <span
              aria-hidden
              className="text-muted-foreground/60 ml-auto text-sm tabular-nums"
            >
              —
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2" data-testid="proposal-brief">
            <ProposalBrief proposal={proposal} />
          </div>
        )}
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

/** Said when a save lost to someone else's, and the field now shows theirs. */
const CHANGED_WHILE_EDITING =
  "Someone changed this bounty while you were editing. It now shows their version; make your change again.";

/**
 * An open bounty: its text, its proposal, its sandbox and its context, and
 * the edit that changes them. In a panel, read-only and without its
 * proposal, in one column; on a page, its text and proposal in a wide
 * column with the rest beside them, below them on a narrow screen.
 */
function BountyDetail({
  layout,
  organization,
  viewer,
  bounty,
  bounties,
  repos,
  canManage,
  onChange,
  onReload,
  proposal,
  onProposed,
  onDeleted,
}: {
  layout: "panel" | "page";
  /** The workspace it belongs to, named under its parts. */
  organization: MembershipDto;
  viewer: Viewer;
  bounty: BountyDto;
  bounties: Bounties;
  repos: GithubRepos;
  canManage: boolean;
  /**
   * Its proposal in full, or null while it has none. Made by the caller,
   * which knows of a proposal made or removed since the bounty was read.
   */
  proposal: ReactElement | null;
  /** Holds the bounty as a save returned it. */
  onChange: (bounty: BountyDto) => void;
  /** Reads it again, after a change that does not return it. */
  onReload: () => void;
  /** A proposal was made from it. */
  onProposed: (proposalId: string) => void;
  onDeleted: () => void;
}) {
  const propose = usePropose(bounties, bounty.id, onProposed);
  const [sandboxPending, setSandboxPending] = useState(false);
  const [sandboxError, setSandboxError] = useState<string | null>(null);
  // Which tab a page has open; a panel has none.
  const { search } = useLocation();
  const tab = pageTabFrom(search);
  // A panel is read; the bounty is changed on its page.
  const readOnly = layout === "panel";
  // Whether its sandbox is offered to be made, linked or generated here.
  const managesSandbox = canManage && !readOnly;

  // A bounty following its Jira issue takes its text from Jira.
  const followsJira = bounty.jira !== null && bounty.jira.removedAt === null;
  const repo = repos.repos.find(({ id }) => id === bounty.repoId) ?? null;
  const { sandbox } = bounty;
  // A sandbox made before its bounty named a repository links that one.
  const unlinked = sandbox !== null && sandbox.sourceRepoId === null;
  const repoToLink = unlinked ? bounty.repoId : null;
  // Either part is kept with the bounty, so either one keeps it.
  const removable = proposal === null && sandbox === null;

  /*
    Each field saves on its own, sending that field alone. A save that lost
    to someone else's shows theirs, so saving again cannot undo it.
  */
  const save: SaveField = async (change) => {
    const result = await bounties.update(bounty.id, bounty.revision, change);
    if (result.ok) {
      onChange(result.bounty);
      return null;
    }
    if (result.bounty === undefined) {
      return { message: result.error, conflict: false };
    }
    onChange(result.bounty);
    return { message: CHANGED_WHILE_EDITING, conflict: true };
  };

  /*
    The proposal in full, under the text it was sized from, since that is
    what it is reviewed against. It brings its own cards, so it is not set
    in the part's.
  */
  const proposalPart =
    proposal !== null ? (
      <Part title="Proposal" framed={false} titleHidden={layout === "page"}>
        {proposal}
      </Part>
    ) : (
      <Part title="Proposal" titleHidden={layout === "page"}>
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
        {propose.error !== null && (
          <p role="alert" className="text-destructive text-xs">
            {propose.error}
          </p>
        )}
      </Part>
    );

  /*
    The workspace the bounty belongs to, and so whose routes change it. It
    is not moved between workspaces, so it is named, not offered. On a page,
    where the bounty came from is said under it.
  */
  const workspacePart = (
    <Part title="Workspace" framed={false}>
      <div className="flex flex-col gap-1.5">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <WorkspaceFace
            organization={organization}
            viewer={viewer}
            className="size-5 shrink-0"
            squareRadius="rounded-[5px]"
          />
          <span className="truncate">{workspaceLabel(organization)}</span>
        </span>
        {layout === "page" && <Source bounty={bounty} />}
      </div>
    </Part>
  );

  /*
    What the bounty pays and the size that sets it, from its proposal, at
    the head of the sandbox the paid work is done in. The bounty names a
    removed proposal until it is read again, so only one the caller still
    knows of is shown. A page has the proposal in a tab of its own, which
    says the price already, so only a panel shows it here.
  */
  const priced = proposal !== null ? bounty.proposal : null;
  const price = (
    <div className="mb-1 border-b pb-3">
      {priced === null ? (
        <p className="text-muted-foreground text-sm">
          Not priced yet; its proposal prices it.
        </p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span
            className={cn(
              "text-2xl leading-none font-semibold tracking-tight",
              priced.amountMinor === null
                ? "text-muted-foreground"
                : "tabular-nums",
            )}
          >
            {money(priced.amountMinor, priced.currency)}
          </span>
          <span className="flex items-center gap-1.5 text-sm">
            <span className="text-muted-foreground">Size</span>
            <Badge variant="outline" className="font-mono">
              {priced.complexity}
            </Badge>
          </span>
        </div>
      )}
    </div>
  );

  // Where the sandbox stands: its status and whether it can be worked in.
  const sandboxStatus = sandbox !== null && (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={sandbox.status === "published" ? "default" : "secondary"}>
        {SANDBOX_STATUS_LABEL[sandbox.status]}
      </Badge>
      <span className="text-muted-foreground text-sm">
        {sandbox.currentVersionId === null
          ? "No version published yet."
          : "Contributors can work in its published version."}
      </span>
    </div>
  );

  /*
    A page's bounty at a glance, beside whichever tab is open: what it pays
    and the size that sets it, over where its sandbox stands. Its tabs have
    each in full.
  */
  const summaryPart = (
    <Part title="Bounty">
      {price}
      {sandboxStatus === false ? (
        <p className="text-muted-foreground text-sm">No sandbox yet.</p>
      ) : (
        sandboxStatus
      )}
    </Part>
  );

  const sandboxPart = (
    <Part
      title="Sandbox"
      titleHidden={layout === "page"}
      // A page's sandbox is its cards alone, not a card around them.
      framed={layout === "panel"}
    >
      {layout === "panel" && price}
      {/* Where it stands, under the price, as the page's summary has it. */}
      {layout === "panel" && sandboxStatus}
      {sandbox !== null ? (
        <div className="flex flex-col gap-3">
          {/*
            With no repository, its versions are generated from the bounty;
            a repository the bounty names can still be linked to slice them
            from it instead.
          */}
          <SandboxGeneration
            organizationId={bounty.organizationId}
            workspace={organization.slug}
            sandbox={sandbox}
            canManage={canManage}
            canGenerate={unlinked}
            // A slice is generated from an approved bounty only: one with
            // no proposal, or a draft one, is refused.
            generationBlocked={
              bounty.proposal === null
                ? "Size and approve the bounty before generating its slice."
                : bounty.proposal.status !== "approved"
                  ? "The bounty is a draft. Approve it before generating its slice."
                  : null
            }
            readOnly={readOnly}
            onPublished={onReload}
          >
            {unlinked && managesSandbox && repoToLink !== null && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                <p className="text-muted-foreground text-sm">
                  Or link the bounty's repository, to slice versions from its
                  code.
                </p>
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
                        if (failure === null) onReload();
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
              </div>
            )}
          </SandboxGeneration>
          <SandboxCard
            icon={Inbox}
            title="Submission"
            description="Where successful submissions are held, once their work is accepted."
          >
            <p className="text-muted-foreground text-sm">
              No successful submissions yet.
            </p>
          </SandboxCard>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-muted-foreground text-sm">
            No sandbox yet.
            {!readOnly &&
              (canManage
                ? " Create one to cut the task contributors work in."
                : " An owner or admin can create one.")}
          </p>
          {managesSandbox && (
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
                    if (failure === null) onReload();
                    else setSandboxError(failure);
                  });
              }}
            >
              {sandboxPending ? <Loader2 className="animate-spin" /> : <Box />}
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
  );

  /*
    Enrichment: each source adds context the proposal and the sandbox are
    built from, and none of them is required.
  */
  const jiraContext = (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <div className="flex min-w-0 flex-col gap-0.5">
        {/*
            Each source named in the foreground, over what it holds; what
            is not there is said quietly.
          */}
        <span className="font-medium">Jira</span>
        {bounty.jira === null ? (
          <span className="text-muted-foreground">
            Not linked; created in Lunox
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <span className="size-3.5 shrink-0">
              <JiraIcon />
            </span>
            {followsJira
              ? "Follows its Jira issue"
              : "Gone from Jira; keeps its last text"}
          </span>
        )}
      </div>
      {bounty.jira?.url != null && (
        <Button variant="outline" size="sm" className="gap-1.5" asChild>
          <a href={bounty.jira.url} target="_blank" rel="noreferrer noopener">
            Open in Jira
            <ExternalLink className="size-3" />
          </a>
        </Button>
      )}
    </div>
  );

  const codeContext = (
    <>
      <RepositoryField
        bounty={bounty}
        repos={repos}
        readOnly={readOnly}
        onSave={save}
      />
      <StackField
        bounty={bounty}
        repos={repos}
        readOnly={readOnly}
        onSave={save}
      />
    </>
  );

  const contextPart = (
    <Part title="Context">
      {jiraContext}
      {codeContext}
    </Part>
  );

  const remove = canManage && removable && (
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
        title="Delete this bounty?"
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
  );

  const description = (
    <InlineDescription
      bounty={bounty}
      locked={followsJira || readOnly}
      // A page's overview tab heads it, so it reads as a field there.
      labelled={layout !== "page"}
      {...(layout === "page" ? { label: "Describe task" } : {})}
      onSave={save}
    />
  );

  /*
    A page splits the bounty into tabs: its overview, its text; the bounty,
    what it pays and the reasoning behind the price; and its sandbox. The
    title, the tabs on their rule and the tab's part make a wide column, so
    the tabs head only what they switch; beside it, from the top and
    whichever tab is open, a narrow one: its workspace, the bounty at a
    glance, its context and the way to delete it. Under the wide one
    when the page is narrow.
  */
  if (layout === "page") {
    return (
      <div
        className="grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_20rem]"
        data-testid="bounty-detail"
      >
        <div className="flex min-w-0 flex-col gap-5">
          <header className="flex flex-col gap-2">
            <InlineTitle
              as="h1"
              size="page"
              value={bounty.title}
              locked={followsJira}
              onSave={save}
            />
            {/* Its workspace and source are named beside, not here too. */}
            {bounty.jira !== null && (
              <span className="text-muted-foreground font-mono text-xs">
                {bounty.jira.key}
              </span>
            )}
          </header>
          <Tabs value={tab} onValueChange={selectPageTab} className="gap-6">
            <TabsList variant="line">
              {PAGE_TABS.map(({ value, label }) => (
                <TabsTrigger key={value} value={value}>
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="overview">{description}</TabsContent>
            <TabsContent value="bounty">{proposalPart}</TabsContent>
            <TabsContent value="sandbox">{sandboxPart}</TabsContent>
          </Tabs>
        </div>
        <div className="flex flex-col gap-5">
          {workspacePart}
          {summaryPart}
          {contextPart}
          {remove}
        </div>
      </div>
    );
  }

  /*
    A panel is a glance, read and not changed, in one column: its text, its
    sandbox under its price, its context and its workspace. Its proposal,
    and every change, are on its page, which the panel's header opens.
  */
  return (
    <div className="flex flex-col gap-5" data-testid="bounty-detail">
      <InlineTitle
        as="h2"
        size="panel"
        value={bounty.title}
        locked
        onSave={save}
      />
      {description}
      {sandboxPart}
      {contextPart}
      {workspacePart}
    </div>
  );
}

/**
 * One part of an open bounty: a heading over a card. A bounty is a
 * proposal and a sandbox, with context around them, and each is a part.
 * One that brings its own cards, as an open proposal does, is not
 * `framed` in another. One that is a page's tab has the tab for its heading,
 * so its own is only read out: shown, it would name the tab a second time.
 */
function Part({
  title,
  framed = true,
  titleHidden = false,
  children,
}: {
  title: string;
  framed?: boolean;
  titleHidden?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h3
        id={id}
        className={cn(
          "text-muted-foreground text-xs font-medium tracking-wide uppercase",
          titleHidden && "sr-only",
        )}
      >
        {title}
      </h3>
      {framed ? (
        <div className="flex flex-col gap-2 rounded-lg border p-4">
          {children}
        </div>
      ) : (
        children
      )}
    </section>
  );
}

const fieldClass =
  "border-input focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm";

/**
 * A bounty's fields, for writing one or changing it. `textLocked` is a
 * bounty following its Jira issue: its text is Jira's, so only its
 * repository is offered.
 *
 * `layout` is the room it has: one column in a panel, or on a page the
 * title and description in a wide column with the rest of the fields
 * beside them, below them on a narrow screen.
 */
function BountyForm({
  layout = "panel",
  repos,
  workspace,
  newRepository,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  layout?: "panel" | "page";
  repos: GithubRepos;
  /**
   * The workspace a new bounty goes to. A bounty that exists stays in its
   * own, so editing one offers none.
   */
  workspace?:
    | {
        organizations: MembershipDto[];
        viewer: Viewer;
        value: string;
        onChange: (organizationId: string) => void;
      }
    | undefined;
  /**
   * Where a repository the list lacks is connected, offered under the
   * repositories: the workspace's GitHub settings.
   */
  newRepository?: { href: string; onOpen: () => void } | undefined;
  submitLabel: string;
  /** Resolves to null when saved, or to what to say. */
  onSubmit: (draft: BountyDraft) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [repoId, setRepoId] = useState("");
  /*
    Everything the person has added, kept across a change of repository: a
    name the repository chosen also has shows as the repository's while it
    is chosen, and comes back as theirs if another is.
  */
  const [stack, setStack] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosenRepo = repos.repos.find(({ id }) => id === repoId);
  const inherited = chosenRepo?.stack ?? [];
  const added = stack.filter(
    (name) => !inherited.some((repo) => sameStackName(repo, name)),
  );

  const page = layout === "page";

  const workspaceField = workspace !== undefined && (
    <Labelled label="Workspace">
      {(field) => (
        <Combobox
          id={field.id}
          label="Workspace"
          searchPlaceholder="Search workspaces…"
          // As the switcher in the rail shows them: personal first, called
          // "Personal", and each with its face.
          options={orderWorkspaces(workspace.organizations).map(
            (organization) => ({
              value: organization.id,
              label: workspaceLabel(organization),
              keywords: [organization.name, organization.slug],
              icon: (
                <WorkspaceFace
                  organization={organization}
                  viewer={workspace.viewer}
                  className="size-5 shrink-0"
                  squareRadius="rounded-[5px]"
                />
              ),
            }),
          )}
          value={workspace.value}
          onValueChange={(organizationId) => {
            workspace.onChange(organizationId);
            // The repositories offered are the chosen workspace's.
            setRepoId("");
          }}
        />
      )}
    </Labelled>
  );
  const titleField = (
    <Labelled label="Title">
      {(field) => (
        <Input
          id={field.id}
          aria-describedby={field.describedBy}
          value={title}
          maxLength={BOUNTY_LIMITS.title}
          required
          onChange={(event) => setTitle(event.target.value)}
        />
      )}
    </Labelled>
  );
  const repoField = (
    <Labelled
      label="Repository"
      hint="The code the bounty is about. Its spec is drafted beside an outline of it."
    >
      {(field) => (
        <Combobox
          id={field.id}
          aria-describedby={field.describedBy}
          label="Repository"
          searchPlaceholder="Search repositories…"
          emptyMessage={
            repos.loading ? "Loading repositories…" : "No repository matches."
          }
          options={repositoryOptions(repos, repoId)}
          actions={
            newRepository === undefined
              ? []
              : [
                  {
                    key: "new-repository",
                    label: "New repository",
                    icon: <Plus />,
                    href: newRepository.href,
                    onSelect: newRepository.onOpen,
                  },
                ]
          }
          value={repoId}
          onValueChange={setRepoId}
        />
      )}
    </Labelled>
  );
  const stackField = (
    <Labelled
      label="Tech stack"
      hint={
        chosenRepo !== undefined && chosenRepo.stack === null
          ? "The repository's stack is still being read; add what you know."
          : chosenRepo !== undefined
            ? "Detected in the repository, which stays. Add anything else the work needs."
            : "What the work is done in."
      }
    >
      {(field) => (
        <StackPicker
          id={field.id}
          describedBy={field.describedBy}
          inherited={inherited}
          inheritedFrom={chosenRepo?.fullName ?? "the repository"}
          value={added}
          onChange={(next) =>
            // The ones hidden behind the repository's are kept, so they
            // return if it changes.
            setStack([
              ...stack.filter(
                (name) =>
                  !added.includes(name) &&
                  inherited.some((repo) => sameStackName(repo, name)),
              ),
              ...next,
            ])
          }
        />
      )}
    </Labelled>
  );
  const descriptionField = (
    <Labelled
      label="Description"
      hint="What should be true when it is done. Markdown works."
    >
      {(field) => (
        <textarea
          id={field.id}
          aria-describedby={field.describedBy}
          className={cn(
            fieldClass,
            "font-mono",
            page ? "min-h-72 lg:min-h-[28rem]" : "min-h-48",
          )}
          value={description}
          maxLength={BOUNTY_LIMITS.description}
          onChange={(event) => setDescription(event.target.value)}
        />
      )}
    </Labelled>
  );
  const footer = (
    <>
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
    </>
  );

  return (
    <form
      className={
        page
          ? "grid gap-x-8 gap-y-6 lg:grid-cols-[minmax(0,1fr)_17rem]"
          : "flex flex-col gap-4"
      }
      data-testid="bounty-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (title.trim() === "") {
          setError("A bounty needs a title.");
          return;
        }
        setSaving(true);
        setError(null);
        void onSubmit({
          title: title.trim(),
          description,
          repoId: repoId === "" ? null : repoId,
          // Only what the bounty adds: the repository's own follow it.
          stack: added,
        }).then((failure) => {
          setSaving(false);
          setError(failure);
        });
      }}
    >
      {page ? (
        <>
          <div className="flex min-w-0 flex-col gap-4">
            {titleField}
            {descriptionField}
          </div>
          {/*
            Beside the description from `lg`, the full height of the form;
            under it on a narrower screen, two to a row while there is room.
          */}
          <div className="grid content-start gap-4 sm:grid-cols-2 lg:row-span-2 lg:grid-cols-1">
            {workspaceField}
            {repoField}
            {stackField}
          </div>
          <div className="flex flex-col gap-4">{footer}</div>
        </>
      ) : (
        <>
          {workspaceField}
          {titleField}
          {repoField}
          {stackField}
          {descriptionField}
          {footer}
        </>
      )}
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
