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
 * The page lists bounties only, a card each, one to a row. A proposal is
 * made from a bounty and lives inside it: a bounty's page shows its proposal
 * in full in its Bounty step, and proposing a bounty follows its sizing run
 * and then shows the proposal in the same place. The panel over the list is
 * a read-only glance without it.
 *
 * A bounty opens in a panel over the list, `/bounties?peek=acme/bty_1`, or as
 * a page of its own, `/bounties/acme/bty_1`, which the panel opens and whose
 * trail leads back to the list. The workspace is named because a bounty is
 * read and changed through its own workspace's routes. A new bounty is
 * written on a page of its own, `/bounties/new`, and opens here once it is
 * saved.
 */

import {
  isWorkspaceSource,
  type BountyDto,
  type MembershipDto,
  type BountySandboxSummaryDto,
  type BountySummaryDto,
} from "@sandbox-factory/shared";
import {
  BOUNTY_LIMITS,
  isPublicationLive,
  overviewApproved,
  sameStackName,
} from "sandbox-factory";
import {
  Box,
  CircleCheck,
  CircleDashed,
  CircleDot,
  ExternalLink,
  FileText,
  Inbox,
  Link2,
  Loader2,
  Maximize2,
  Plus,
  Sparkles,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
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
import {
  ErrorBanner,
  LoadingLine,
  RetryableError,
  RetryButton,
} from "@/components/Message";
import { Page, PageHeader } from "@/components/Page";
import {
  PEEK_ACTION_CLASS,
  PEEK_ROW_ATTRIBUTE,
  PeekPanel,
} from "@/components/PeekPanel";
import { StackChips, StackPicker } from "@/components/StackPicker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import {
  orderWorkspaces,
  workspaceLabel,
  WorkspaceFace,
  type Viewer,
} from "./OrganizationSwitcher";
import { LunoxMark } from "@/components/LunoxMark";
import { BountyText } from "./BountyText";
import { CategoryIcon } from "./CategoryIcon";
import { dateTime } from "./lib/format";
import { money } from "./Proposals";
import { JiraIcon, ProviderIcon } from "./ProviderIcon";
import {
  BOUNTIES_PATH,
  bountiesUrl,
  bountyForPath,
  bountyForSearch,
  bountyPagePath,
  bountyProposalPath,
  isPlainLeftClick,
  listScopeForSearch,
  NEW_BOUNTY_PATH,
  NEW_ORG_PATH,
  pathForScreen,
  sandboxFilesPath,
  type BountyAddress,
  type BountyListScope,
} from "./routes";
import { clients, queryKeys, useUserId } from "./data/query";
import {
  InlineDescription,
  InlineTitle,
  StackField,
  workspaceStack,
  type SaveField,
} from "./features/bounties/BountyFields";
import {
  BountyLinks,
  type OpenSettings,
} from "./features/bounties/BountyLinks";
import {
  ContextLineage,
  sourcesAhead,
  StepContext,
  useBountyContext,
} from "./features/bounties/BountyContext";
import { BountyProposal } from "./features/bounties/BountyProposal";
import { BoardFilter } from "./features/bounties/BoardScope";
import {
  CategoryFilter,
  CategoryMark,
  CategoryNote,
} from "./features/bounties/Categories";
import {
  OverviewVersion,
  StepLineage,
  StepTriggers,
  STEPS,
  type Step,
} from "./features/bounties/BountySteps";
import { SandboxCard } from "./features/bounties/SandboxCard";
import { SandboxGeneration } from "./features/bounties/SandboxGeneration";
import {
  areaDescription,
  prefillFromSearch,
  type BountyPrefill,
} from "./features/onboarding/prefill";
import { useGithubRepos, type GithubRepos } from "./useGithub";
import {
  useAllBounties,
  useBounties,
  useBountyCategories,
  type AllBounties,
  type BountyDraft,
  type Bounties,
} from "./useBounties";

/** How a sandbox's status reads. */
const SANDBOX_STATUS_LABEL: Record<BountySandboxSummaryDto["status"], string> =
  { draft: "Draft", published: "Published", closed: "Closed" };

/** Its status, or Expired for a publication past its date. */
function sandboxLabel(sandbox: BountySandboxSummaryDto): string {
  return sandbox.status === "published" && !isPublicationLive(sandbox)
    ? "Expired"
    : SANDBOX_STATUS_LABEL[sandbox.status];
}

/**
 * The steps a bounty's own page splits it into, in the order each is built
 * on the one before: what it is, what it pays and why, and where the work
 * is done. `?tab=` names the one open, or the overview when it names none.
 */
function pageTabFrom(search: string): Step {
  const value = new URLSearchParams(search).get("tab");
  return STEPS.find((tab) => tab.value === value)?.value ?? "overview";
}

/** Opens a tab in the address, so Back returns to the one before. */
function selectPageTab(next: string) {
  updateSearch((params) => {
    if (next === "overview") params.delete("tab");
    else params.set("tab", next);
  });
}

/**
 * The history state a panel opened from the list is pushed with: the mark
 * that the entry under it is the list, so closing the panel can go back to
 * it rather than leave an entry behind that Back would reopen.
 */
const PEEK_ENTRY = { bountyPeek: true } as const;

function isPeekEntry(state: unknown): boolean {
  return (
    typeof state === "object" &&
    state !== null &&
    (state as Record<string, unknown>)["bountyPeek"] === true
  );
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
  /*
    The bounty open over the list, and what the list is narrowed to: a
    category and a board. In the query, so a reload or a link lands on them
    and Back steps out of the bounty.
  */
  const { search } = useLocation();
  const peek = bountyForSearch(search) ?? null;
  const scope = listScopeForSearch(search);
  const boardOwner =
    scope.board === undefined
      ? undefined
      : workspaceNamed(organizations, scope.board.workspace);
  const bounties = useAllBounties({
    category: scope.category,
    board: scope.board?.boardId,
    source: scope.source,
  });
  const counts = useBountyCategories(scope.board?.boardId, scope.source);
  /** The list narrowed otherwise; a bounty open over it stays open. */
  const narrow = (next: BountyListScope) =>
    replaceLocation(bountiesUrl(peek, next));
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
    walking through every card looked at. Closing it is that same Back when
    the panel was opened here, so the entry it was opened on is not left
    for Back to reopen; one opened from a link or a reload has no list
    entry under it to go back to, so its address is replaced with the list.
  */
  const open = (address: BountyAddress | null) => {
    if (address === null) {
      if (peek === null) return;
      if (isPeekEntry(window.history.state)) window.history.back();
      else replaceLocation(bountiesUrl(null, scope));
    } else if (peek !== null) {
      if (address.workspace === peek.workspace && address.id === peek.id) {
        return;
      }
      replaceLocation(bountiesUrl(address, scope));
    } else {
      pushLocation(bountiesUrl(address, scope), PEEK_ENTRY);
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
      <Page className="flex flex-col gap-6">
        <PageHeader
          title="Bounties"
          description="Work your workspaces want done, written here or found in Jira."
          actions={
            <NewBountyLink disabled={target === null} onCreate={onCreate} />
          }
        />

        {/*
          Controls on the list beside the panel, as a card is: using them
          narrows the list and leaves the open bounty open.
        */}
        <div
          {...{ [PEEK_ROW_ATTRIBUTE]: "" }}
          role="group"
          aria-label="Filter bounties"
          className="flex flex-wrap items-center gap-2"
        >
          <CategoryFilter
            counts={counts.data}
            selected={scope.category ?? null}
            onSelect={(category) =>
              narrow({ ...scope, category: category ?? undefined })
            }
          />
          <BoardFilter
            organizations={organizations}
            selected={scope.board}
            source={scope.source}
            // A board or Lunox: one place the bounties came from, not both.
            onSelect={({ board, source }) =>
              narrow({ ...scope, board, source })
            }
            organizationId={boardOwner?.id}
            onOpenBounty={(id) => {
              const workspace = scope.board?.workspace;
              if (workspace !== undefined) open({ workspace, id });
            }}
          />
          <div className="order-last basis-full empty:hidden">
            <CategoryNote
              counts={counts.data}
              selected={scope.category ?? null}
            />
          </div>
        </div>

        <BountyList
          bounties={bounties}
          organizations={organizations}
          organizationsLoading={organizationsLoading}
          viewer={viewer}
          peek={peek}
          narrowed={
            scope.category !== undefined ||
            scope.board !== undefined ||
            scope.source !== undefined
          }
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
      </Page>
    </div>
  );
}

/**
 * A proposal named with no bounty, from when proposals had a list of their
 * own; `canonicalUrl` keeps it in the query with its workspace. It is read
 * for the bounty it belongs to, whose page then opens on its proposal, in
 * the address's place: a panel does not show the proposal. Only once the
 * workspace is known: with none, there is nowhere to read it from, and the
 * address is dropped.
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
 * The way to the page a workspace is made on, for someone in none. A link,
 * so it can be opened in another tab; a plain click stays in the app.
 */
function NewWorkspaceLink() {
  return (
    <Button variant="outline" size="sm" asChild>
      <a
        href={NEW_ORG_PATH}
        onClick={(event) => {
          if (isPlainLeftClick(event)) {
            event.preventDefault();
            pushLocation(NEW_ORG_PATH);
          }
        }}
      >
        <Plus />
        New workspace
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
  onOpenSettings,
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
  /** Opens a tab of a workspace's settings: where its sources are connected. */
  onOpenSettings: (
    organization: MembershipDto,
    tab: Parameters<OpenSettings>[0],
  ) => void;
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
    <Page className="flex flex-col gap-6">
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
            onOpenSettings={(tab) => onOpenSettings(owner, tab)}
          />
        ))}
    </Page>
  );
}

/**
 * A bounty page's heading until the bounty is read, and while it cannot be.
 */
function PageHeading() {
  return <PageHeader title="Bounty" />;
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
  // Started from home's repository x-ray: about this repository, and
  // perhaps one module of it. Read once, as the page opens.
  const [prefill] = useState(() => prefillFromSearch(window.location.search));
  return (
    <Page className="flex flex-col gap-8">
      <PageHeader
        title="New bounty"
        description="Only the title is required. The more the description says, the better the proposal."
      />
      {organizationsLoading ? (
        <LoadingLine />
      ) : target === null ? (
        // A bounty is written to a workspace, so the way on is to make one.
        <div className="flex flex-col items-start gap-3">
          <p className="text-muted-foreground text-sm">
            You are not in a workspace yet. Create one to write bounties in.
          </p>
          <NewWorkspaceLink />
        </div>
      ) : (
        <NewBounty
          organizations={organizations}
          viewer={viewer}
          initial={target.id}
          prefill={prefill}
          onCancel={onCancel}
          onConnectRepository={onConnectRepository}
          onCreated={(bounty) => {
            replaceLocation(
              bountiesUrl(addressOf(bounty, organizations) ?? null),
            );
          }}
        />
      )}
    </Page>
  );
}

/**
 * A new bounty, in the workspace chosen for it. It names no repository: the
 * stack it inherits is that workspace's repositories', so it follows the
 * choice, and a workspace with none connects one in its settings.
 */
function NewBounty({
  organizations,
  viewer,
  initial,
  prefill,
  onCancel,
  onConnectRepository,
  onCreated,
}: {
  organizations: MembershipDto[];
  viewer: Viewer;
  /** The workspace chosen until another is. */
  initial: string;
  /** A module, and the repository it is in, the description starts about. */
  prefill?: BountyPrefill | null | undefined;
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
                "github",
              ),
              onOpen: () => onConnectRepository(chosen),
            }
      }
      initialDraft={
        prefill === null || prefill === undefined
          ? undefined
          : { description: areaDescription(prefill) }
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
  onOpenSettings,
}: {
  layout: "panel" | "page";
  organization: MembershipDto;
  viewer: Viewer;
  bountyId: string;
  /** Its card in the list, if it has one: names its proposal before the read. */
  listed?: BountySummaryDto | undefined;
  onLoaded: (bounty: BountyDto) => void;
  onDeleted: () => void;
  /** A page's way to its workspace's settings, from the links it offers. */
  onOpenSettings?: OpenSettings | undefined;
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
        <ErrorBanner
          className="mt-0"
          action={<RetryButton onRetry={opened.retry} />}
        >
          Could not load the bounty.
        </ErrorBanner>
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
            overviewVersion={bounty.stages.bounty?.overviewVersion ?? null}
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
      onOpenSettings={onOpenSettings}
    />
  );
}

function BountyList({
  bounties,
  organizations,
  organizationsLoading,
  viewer,
  peek,
  narrowed,
  onOpen,
  onCreate,
}: {
  bounties: AllBounties;
  organizations: MembershipDto[];
  organizationsLoading: boolean;
  /** Whoever is looking: the face their personal workspace wears. */
  viewer: Viewer;
  /** The bounty open in the panel, whose card is marked; null for none. */
  peek: BountyAddress | null;
  /** A category or a board narrows the list, so empty says less. */
  narrowed: boolean;
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
        <RetryableError onRetry={bounties.retry}>
          {bounties.error}
        </RetryableError>
      )}
      {bounties.bounties.length === 0 ? (
        // A list that failed to load is not known to be empty.
        bounties.error === null &&
        (narrowed ? (
          <div className="rounded-lg border border-dashed px-4 py-10 text-center">
            <p className="text-muted-foreground text-sm">
              No bounties here. Choose another category or source, or add one of
              the board&rsquo;s issues from its &#8942; menu.
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-10 text-center">
            <p className="text-muted-foreground text-sm">
              No bounties yet. Write one, or connect Jira and the tickets its
              boards&rsquo; scans put in a category arrive here.
            </p>
            <NewBountyLink variant="outline" onCreate={onCreate} />
          </div>
        ))
      ) : (
        <>
          {/*
            A table in a card: a head naming its columns, then a row each.
            On a phone the head goes and each row stacks.
          */}
          <div className="bg-card @container overflow-hidden rounded-xl border">
            <div
              aria-hidden
              className={cn(
                ROW_GRID,
                "bg-muted/40 text-muted-foreground hidden border-b px-4 py-2.5 text-xs font-medium @xl:grid",
              )}
            >
              <span>
                {bounties.bounties.length}
                {bounties.more && "+"}{" "}
                {bounties.bounties.length === 1 ? "bounty" : "bounties"}
              </span>
              <span className={cn("hidden", WORKSPACE_CELL)}>Workspace</span>
              <span>Status</span>
              <span className="text-right">Price</span>
            </div>
            <ul className="divide-y" data-testid="bounty-list">
              {bounties.bounties.map((bounty) => {
                const address = addressOf(bounty, organizations);
                return (
                  <BountyCard
                    key={bounty.id}
                    bounty={bounty}
                    workspace={organizations.find(
                      ({ id }) => id === bounty.organizationId,
                    )}
                    viewer={viewer}
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
          </div>
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

/** Where a bounty came from, said in a few words, as its page names it. */
function Source({ bounty }: { bounty: BountySummaryDto }) {
  if (bounty.jira === null) {
    return <span className="shrink-0">Created in Lunox</span>;
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <span className="size-3 shrink-0">
        <JiraIcon />
      </span>
      {bounty.jira.removedAt === null ? "From Jira" : "Gone from Jira"}
    </span>
  );
}

/**
 * The list's columns, shared by its head and every row, set by how wide the
 * list itself is rather than the screen: beside an open panel it is
 * narrower, and the workspace, which the panel names, gives its column up
 * to the titles. Narrower still, as on a phone, each row stacks.
 */
const ROW_GRID =
  "gap-x-6 @xl:items-center @xl:grid-cols-[minmax(0,1fr)_7.5rem_5.5rem] @4xl:grid-cols-[minmax(0,1fr)_9rem_7.5rem_5.5rem]";

/** The workspace column: under the title when stacked, and when wide. */
const WORKSPACE_CELL = "@xl:hidden @4xl:flex";

/**
 * Under a bounty's title, in a few quiet words: its Jira issue's key, or
 * that it was written here, and why its board's scan picked it.
 */
function Subtitle({ bounty }: { bounty: BountySummaryDto }) {
  const [category] = bounty.categories;
  return (
    <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
      {bounty.jira === null ? (
        <span className="shrink-0">Created in Lunox</span>
      ) : (
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 font-mono",
            bounty.jira.removedAt !== null && "line-through",
          )}
          title={
            bounty.jira.removedAt === null ? "From Jira" : "Gone from Jira"
          }
        >
          <span className="size-3 shrink-0">
            <JiraIcon />
          </span>
          {bounty.jira.key}
          <span className="sr-only">
            {bounty.jira.removedAt === null ? "From Jira" : "Gone from Jira"}
          </span>
        </span>
      )}
      {category !== undefined && (
        <>
          <span aria-hidden>·</span>
          <span className="truncate" aria-hidden>
            {category.reason}
          </span>
        </>
      )}
    </span>
  );
}

/**
 * Where a bounty's proposal stands, as a mark and a word: not sized yet, a
 * proposal waiting on a decision, or approved.
 */
function ProposalStatus({
  proposal,
}: {
  proposal: BountySummaryDto["proposal"];
}) {
  if (proposal === null)
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
        <CircleDashed className="size-3.5 shrink-0" aria-hidden />
        No proposal
      </span>
    );
  const approved = proposal.status === "approved";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium",
        !approved && "text-foreground/80",
      )}
    >
      {approved ? (
        <CircleCheck
          className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
          aria-hidden
        />
      ) : (
        <CircleDot className="size-3.5 shrink-0 text-amber-500" aria-hidden />
      )}
      {approved ? "Approved" : "Proposed"}
    </span>
  );
}

/**
 * What it pays, once its proposal is approved; until then the price is not
 * settled, and the column holds a faint dash.
 */
function ProposalPrice({
  proposal,
}: {
  proposal: BountySummaryDto["proposal"];
}) {
  return proposal !== null && proposal.status === "approved" ? (
    <span className="text-sm font-semibold tabular-nums">
      {money(proposal.amountMinor, proposal.currency)}
    </span>
  ) : (
    <span aria-hidden className="text-muted-foreground/50 text-sm">
      —
    </span>
  );
}

/**
 * One bounty in the list, as a row of its table: why a scan picked it, as
 * its category's tile; its title over its Jira key and the reason; the
 * workspace it is in; where its proposal stands; and what it pays. On a
 * phone the title takes the width and the rest goes under it.
 *
 * A click anywhere on it opens the bounty in the panel beside the list, a
 * glance whose proposal is on the bounty's own page; it is a link to that
 * page, so it can be opened in another tab. While the panel is open, a
 * click on another row shows that one in it instead. A bounty is proposed
 * from its page, never from its row.
 */
function BountyCard({
  bounty,
  workspace,
  viewer,
  address,
  selected,
  onOpen,
}: {
  bounty: BountySummaryDto;
  /** The workspace it belongs to, once the workspaces are known. */
  workspace: MembershipDto | undefined;
  viewer: Viewer;
  /** Where it opens; undefined while its workspace is not known. */
  address: BountyAddress | undefined;
  /** It is the bounty open in the panel. */
  selected: boolean;
  onOpen: (address: BountyAddress) => void;
}) {
  const { proposal } = bounty;
  const heading = (
    <span
      className="line-clamp-2 text-sm font-medium @xl:line-clamp-1"
      // Clamped to a line or two; the whole title on hover.
      title={bounty.title}
    >
      {bounty.title}
    </span>
  );
  const headingClass = "flex min-w-0";
  const workspaceName =
    workspace === undefined ? null : workspaceLabel(workspace);
  return (
    // `relative` for the link's overlay, which makes the whole row its target.
    <li
      {...{ [PEEK_ROW_ATTRIBUTE]: "" }}
      className={cn(
        "hover:bg-muted/40 relative flex flex-col gap-3 px-4 py-3.5 transition-colors @xl:grid",
        ROW_GRID,
        selected &&
          "bg-muted/70 hover:bg-muted/70 shadow-[inset_2px_0_0_var(--foreground)]",
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        {bounty.categories.length > 0 ? (
          <CategoryMark categories={bounty.categories} />
        ) : (
          // The same dark tile, in no category's colour, so every title
          // starts on one edge.
          <span
            data-category="uncategorized"
            className="category-badge grid size-8 shrink-0 place-items-center rounded-lg"
          >
            <FileText className="size-4" aria-hidden />
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {address === undefined ? (
            <div className={headingClass}>{heading}</div>
          ) : (
            <a
              href={bountyPagePath(address)}
              aria-current={selected ? "true" : undefined}
              className={cn(
                headingClass,
                "focus-visible:after:ring-ring/50 outline-none after:absolute after:inset-0 focus-visible:after:ring-[3px] focus-visible:after:ring-inset",
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
          <Subtitle bounty={bounty} />
        </div>
      </div>
      {/* Under the title when the list is narrow, on the tile's edge;
          columns beside it when it is wide enough. */}
      <div className="flex items-center gap-4 pl-11 @xl:contents">
        <span
          className={cn(
            "flex min-w-0 items-center gap-2 text-xs",
            WORKSPACE_CELL,
          )}
        >
          {workspace !== undefined && (
            <WorkspaceFace
              organization={workspace}
              viewer={viewer}
              className="size-4 shrink-0"
              squareRadius="rounded-[4px]"
            />
          )}
          <span className="truncate" title={workspaceName ?? undefined}>
            {workspaceName}
          </span>
        </span>
        <span data-testid={proposal === null ? undefined : "proposal-brief"}>
          <ProposalStatus proposal={proposal} />
        </span>
        <span className="ml-auto @xl:ml-0 @xl:text-right">
          <ProposalPrice proposal={proposal} />
        </span>
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
  organizationId: string,
  bountyId: string,
  /**
   * Whether it has no proposal yet, and so may have a sizing to find, where
   * the proposal's place is shown: a sizing followed where nothing says so
   * would be polled for nothing.
   */
  unproposed: boolean,
  onOpenProposal: (proposalId: string) => void,
) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const start = async (following?: string) => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setPending(true);
    setError(null);
    const result = await bounties.propose(bountyId, current.signal, following);
    if (current.signal.aborted) return;
    setPending(false);
    if (result.ok) onOpenProposal(result.proposalId);
    else setError(result.error);
  };
  /*
    A sizing already in flight, as after a reload mid-run: followed as if
    Propose had just been pressed, so the page says it is at work rather
    than offering to start a second.
  */
  const userId = useUserId();
  const sizing = useQuery({
    queryKey: queryKeys.resource(
      userId,
      organizationId,
      "bounty-sizing",
      bountyId,
    ),
    enabled: unproposed,
    staleTime: 0,
    queryFn: ({ signal }) =>
      clients.bounties.bountySizing(organizationId, bountyId, signal),
  });
  const inFlight = unproposed ? (sizing.data?.id ?? null) : null;
  const adopted = useRef<string | null>(null);
  useEffect(() => {
    if (inFlight === null || adopted.current === inFlight || pending) return;
    adopted.current = inFlight;
    void start(inFlight);
    // `start` is remade each render; the run's id is what matters here.
  }, [inFlight, pending]);
  return { pending, error, start: () => start() };
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
  onOpenSettings,
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
  /** Where a page's links lead to connect a source; a panel offers none. */
  onOpenSettings?: OpenSettings | undefined;
}) {
  // A panel has no proposal's place, so a sizing in flight is not followed.
  const propose = usePropose(
    bounties,
    bounty.organizationId,
    bounty.id,
    layout === "page" && proposal === null,
    onProposed,
  );
  const [sandboxPending, setSandboxPending] = useState(false);
  const [sandboxError, setSandboxError] = useState<string | null>(null);
  // Which tab a page has open; a panel has none.
  const { search } = useLocation();
  const tab = pageTabFrom(search);
  /*
    The overview's versions, read on a page only, where its version is
    chosen; read again whenever it moves. The one being read, null for the
    latest: an earlier one is shown, not changed.
  */
  const userId = useUserId();
  const versions = useQuery({
    queryKey: queryKeys.resource(
      userId,
      bounty.organizationId,
      "bounty-versions",
      bounty.id,
      bounty.version,
    ),
    enabled: layout === "page",
    queryFn: ({ signal }) =>
      clients.bounties.bountyVersions(bounty.organizationId, bounty.id, signal),
  });
  const [viewing, setViewing] = useState<number | null>(null);
  /*
    Where each source's sync stands, read on a page only, where they are
    synced; a sync's answer holds the bounty as it then is.
  */
  const context = useBountyContext(bounty, layout === "page", onChange);
  const earlier =
    viewing === null || viewing === bounty.version
      ? null
      : (versions.data?.find(({ version }) => version === viewing) ?? null);
  // A panel is read; the bounty is changed on its page.
  const readOnly = layout === "panel";
  // Whether its sandbox is offered to be made, linked or generated here.
  const managesSandbox = canManage && !readOnly;

  // A bounty following its Jira issue takes its text from Jira.
  const followsJira = bounty.jira !== null && bounty.jira.removedAt === null;
  /*
    An approved overview is held as it is: its title, text, links and stack
    are shown, not changed, until an owner or admin unapproves it.
  */
  const approvedOverview = overviewApproved(bounty);
  const [deciding, setDeciding] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const decideOverview = (decision: "approve" | "unapprove") => {
    setDeciding(true);
    setDecisionError(null);
    void bounties
      .decide(bounty.id, decision, bounty.revision)
      .then((result) => {
        setDeciding(false);
        if (result.ok) onChange(result.bounty);
        else {
          setDecisionError(result.error);
          onReload();
        }
      });
  };
  // What each source is called on the steps' context lines.
  const contextNames = {
    jira: bounty.jira?.key ?? null,
    github: context.status?.github.linked?.ref ?? null,
  };
  const heldContext = bounty.stages.overview.context;
  const { sandbox } = bounty;
  /*
    The repository a sandbox is cut from is the one the bounty's sizing
    said its work touches, still among the workspace's: nobody picks it. A
    sandbox made before its sizing named one links it once it does.
  */
  const touched = (bounty.proposal?.repositories ?? []).map(({ repoId }) => {
    const repo = repos.repos.find(({ id }) => id === repoId) ?? null;
    return {
      repoId,
      repo,
      connected: repo !== null && isWorkspaceSource(repo),
    };
  });
  // Those still connected, as the API counts them when it links one.
  const connectedTouched = touched.flatMap(({ repo, connected }) =>
    connected && repo !== null ? [repo] : [],
  );
  const unlinked = sandbox !== null && sandbox.sourceRepoId === null;
  const [touchedRepo] = connectedTouched;
  const repoToLink =
    unlinked && connectedTouched.length === 1 && touchedRepo !== undefined
      ? touchedRepo
      : null;
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
    What the bounty pays and the size that sets it, from its proposal, in
    a page's summary and a panel's details. The bounty names a removed
    proposal until it is read again, so only one the caller still knows of
    is shown. Until the bounty is approved neither is settled.
  */
  const priced = proposal !== null ? bounty.proposal : null;
  const settled = priced?.status === "approved" ? priced : null;
  const price = (
    <div className="mb-1 border-b pb-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span
          className={cn(
            "text-2xl leading-none font-semibold tracking-tight",
            settled === null || settled.amountMinor === null
              ? "text-muted-foreground"
              : "tabular-nums",
          )}
        >
          {settled === null
            ? "—"
            : money(settled.amountMinor, settled.currency)}
        </span>
        <span className="flex items-center gap-1.5 text-sm">
          <span className="text-muted-foreground">Size</span>
          <Badge variant="outline" className="font-mono">
            {settled?.complexity ?? "—"}
          </Badge>
        </span>
      </div>
    </div>
  );

  // Where the sandbox stands: its status and whether it can be worked in.
  // A live publication's pill opens its sandbox, in a tab of its own.
  const publishedVersion =
    sandbox !== null && isPublicationLive(sandbox)
      ? sandbox.currentVersionId
      : null;
  const sandboxStatus = sandbox !== null && (
    <div className="flex flex-wrap items-center gap-2">
      {publishedVersion !== null ? (
        <Badge asChild>
          <a
            href={sandboxFilesPath({
              workspace: organization.slug,
              versionId: publishedVersion,
            })}
            target="_blank"
            rel="noopener"
            title="Open the published sandbox"
            className="focus-visible:ring-ring/50 transition-opacity hover:opacity-90 focus-visible:ring-[3px] focus-visible:outline-none"
          >
            <LunoxMark />
            {sandboxLabel(sandbox)}
          </a>
        </Badge>
      ) : (
        <Badge variant="secondary">{sandboxLabel(sandbox)}</Badge>
      )}
      <span className="text-muted-foreground text-sm">
        {sandbox.currentVersionId === null ? (
          "No version published yet."
        ) : sandbox.expiresAt === null ? (
          "Contributors can work in its published version."
        ) : isPublicationLive(sandbox) ? (
          <>
            Contributors can work in its published version until{" "}
            <time dateTime={sandbox.expiresAt}>
              {dateTime(sandbox.expiresAt)}
            </time>
            .
          </>
        ) : (
          <>
            Its publication expired{" "}
            <time dateTime={sandbox.expiresAt}>
              {dateTime(sandbox.expiresAt)}
            </time>
            .
          </>
        )}
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

  // A page's sandbox is its cards alone, not a card around them; a panel
  // lays its version out in a section of its own.
  const sandboxPart = (
    <Part title="Sandbox" titleHidden framed={false}>
      {sandbox !== null ? (
        <div className="flex flex-col gap-3">
          {/*
            With no repository, its versions are generated from the bounty;
            once its sizing says the work touches one, that one can still be
            linked to slice them from it instead.
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
            onChanged={() => {
              // The lists hold the bounty as last read too.
              void bounties.refresh();
              onReload();
            }}
          >
            {unlinked && managesSandbox && repoToLink !== null && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                <p className="text-muted-foreground text-sm">
                  Its sizing says the work touches {repoToLink.fullName}. Link
                  it to slice versions from its code instead.
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
                      .linkSandboxSource(sandbox.id)
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
                  Link {repoToLink.fullName}
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
                ? " Create one to slice the task contributors work in."
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
                // Cut from the repository the bounty's sizing said its work
                // touches; with none, its versions are generated.
                void bounties.createSandbox(bounty.id).then((failure) => {
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
    The repositories its work touches, as its sizing said: nobody picks
    them. Until it is sized, any of the workspace's may be.
  */
  const touchedValue =
    bounty.proposal === null ? (
      <span className="text-muted-foreground">
        Any of the workspace's, until it is sized
      </span>
    ) : touched.length === 0 ? (
      <span className="text-muted-foreground">
        Its sizing says the work touches none
      </span>
    ) : repos.loading ? (
      <span className="text-muted-foreground">Reading…</span>
    ) : (
      <span className="flex min-w-0 flex-col gap-1">
        {touched.map(({ repoId, repo, connected }) => (
          <span
            key={repoId}
            className="inline-flex min-w-0 items-center gap-1.5"
          >
            <span className="size-3.5 shrink-0">
              <ProviderIcon provider="github" />
            </span>
            <span
              className={cn(
                "min-w-0 truncate",
                !connected && "text-muted-foreground",
              )}
            >
              {repo?.fullName ?? "A removed repository"}
              {repo !== null && !connected && " (no longer connected)"}
            </span>
          </span>
        ))}
      </span>
    );

  // A page links its sources under its text, so only the stack is beside it.
  const contextPart = (
    <Part title="Context">
      <StackField
        bounty={bounty}
        repos={repos}
        readOnly={readOnly || approvedOverview}
        onSave={save}
      />
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
        pendingLabel="Deleting…"
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
      locked={followsJira || readOnly || approvedOverview}
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
              locked={followsJira || approvedOverview}
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
            {/* The steps, in order, each with the version it is at. */}
            <TabsList
              variant="line"
              aria-label="Steps"
              className="gap-3 overflow-x-auto sm:gap-4"
            >
              <StepTriggers
                stages={bounty.stages}
                ahead={sourcesAhead(context.status)}
                approved={{
                  overview: approvedOverview,
                  bounty: bounty.proposal?.status === "approved",
                  // A sandbox version is approved as it is published.
                  sandbox:
                    sandbox !== null &&
                    sandbox.build !== null &&
                    sandbox.build.versionId === publishedVersion,
                }}
              />
            </TabsList>
            <TabsContent value="overview" className="flex flex-col gap-8">
              <div className="flex flex-col gap-3">
                {/*
                  Which version, and the decision on it, level with each
                  other as a proposal's are. Only the latest is decided.
                */}
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <OverviewVersion
                    versions={versions.data ?? []}
                    current={bounty.version}
                    viewing={earlier?.version ?? bounty.version}
                    approvedAt={
                      earlier === null && approvedOverview
                        ? (bounty.approval?.approvedAt ?? null)
                        : null
                    }
                    onView={(version) =>
                      setViewing(version === bounty.version ? null : version)
                    }
                  />
                  {canManage && earlier === null && (
                    <Button
                      variant={approvedOverview ? "outline" : "default"}
                      disabled={deciding}
                      aria-busy={deciding}
                      onClick={() =>
                        decideOverview(
                          approvedOverview ? "unapprove" : "approve",
                        )
                      }
                    >
                      {deciding && <Loader2 className="animate-spin" />}
                      {approvedOverview
                        ? deciding
                          ? "Unapproving…"
                          : "Unapprove"
                        : deciding
                          ? "Approving…"
                          : "Approve"}
                    </Button>
                  )}
                </div>
                {decisionError !== null && (
                  <p role="alert" className="text-destructive text-xs">
                    {decisionError}
                  </p>
                )}
                {/* The context the overview holds, as its links synced it. */}
                <StepContext
                  label="Holds"
                  versions={heldContext}
                  names={contextNames}
                />
                {earlier === null ? (
                  description
                ) : (
                  // An earlier version is read as it was, title and all.
                  <section
                    aria-label={`Version ${earlier.version}`}
                    className="flex flex-col gap-2"
                    data-testid="overview-earlier"
                  >
                    <h3 className="text-sm font-medium">{earlier.title}</h3>
                    <BountyText description={earlier.description} />
                  </section>
                )}
              </div>
              <BountyLinks
                organization={organization}
                bounty={bounty}
                bounties={bounties}
                repos={repos}
                onChange={onChange}
                onOpenSettings={onOpenSettings ?? (() => undefined)}
                context={context}
                locked={approvedOverview}
              />
            </TabsContent>
            <TabsContent value="bounty" className="flex flex-col gap-4">
              {/*
                Named as its tab is, the Bounty step, as the sandbox's
                lineage and the way to generate it name it too: the
                proposal is what the step holds, not what it is called.
              */}
              <StepLineage
                step="bounty"
                stages={bounty.stages}
                remedy={
                  bounty.proposal?.status === "approved"
                    ? "Unapprove the bounty, then re-analyze it to size it from the latest overview."
                    : "Re-analyze the bounty to size it from the latest overview."
                }
                onOpen={selectPageTab}
              />
              {bounty.stages.bounty !== null && (
                <>
                  <ContextLineage
                    step="bounty"
                    versions={bounty.stages.bounty.context}
                    held={heldContext}
                    remedy={
                      bounty.proposal?.status === "approved"
                        ? "Unapprove the bounty, then re-analyze it to size it with the latest context."
                        : "Re-analyze the bounty to size it with the latest context."
                    }
                  />
                  <StepContext
                    label="Sized with"
                    versions={bounty.stages.bounty.context}
                    held={heldContext}
                    names={contextNames}
                  />
                </>
              )}
              {proposalPart}
            </TabsContent>
            <TabsContent value="sandbox" className="flex flex-col gap-4">
              <StepLineage
                step="sandbox"
                stages={bounty.stages}
                remedy={
                  unlinked
                    ? "Generate a new version to build from the latest bounty."
                    : "A new version sliced from its repository would build from the latest bounty; slicing is not available from this page yet."
                }
                onOpen={selectPageTab}
              />
              {bounty.stages.sandbox !== null && (
                <>
                  <ContextLineage
                    step="sandbox"
                    versions={bounty.stages.sandbox.context}
                    held={heldContext}
                    remedy={
                      unlinked
                        ? "Generate a new version to build with the latest context."
                        : "A new version would freeze the latest context; slicing is not available from this page yet."
                    }
                  />
                  <StepContext
                    label={unlinked ? "Generated with" : "Taken with"}
                    versions={bounty.stages.sandbox.context}
                    held={heldContext}
                    names={contextNames}
                  />
                </>
              )}
              {sandboxPart}
            </TabsContent>
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
    A panel is a glance, read and not changed, in one column: its title
    over what it is at a glance, a property a row, as an issue tracker's
    side panel reads; then its text, and its sandbox's version when it has
    one. No card holds another: the sections are set apart by rules, so
    the eye runs down one edge. Its proposal, and every change, are on its
    page, which the panel's header opens.
  */
  const { inherited, inheritedFrom } = workspaceStack(
    repos,
    bounty.proposal?.repositories,
  );
  return (
    <div className="flex flex-col gap-6" data-testid="bounty-detail">
      <div className="flex flex-col gap-4">
        <InlineTitle
          as="h2"
          size="panel"
          value={bounty.title}
          locked
          onSave={save}
        />
        <PanelSection title="Details" titleHidden ruled={false}>
          <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-0.5 text-sm">
            {/* What it pays, settled only once its proposal is approved. */}
            <Property label="Price">
              {settled === null ? (
                <span className="text-muted-foreground">
                  {priced === null ? "Not sized yet" : "Awaiting approval"}
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      "font-semibold",
                      settled.amountMinor === null
                        ? "text-muted-foreground"
                        : "tabular-nums",
                    )}
                  >
                    {money(settled.amountMinor, settled.currency)}
                  </span>
                  <Badge
                    variant="outline"
                    className="font-mono"
                    title="Size"
                    aria-label={`Size ${settled.complexity}`}
                  >
                    {settled.complexity}
                  </Badge>
                </span>
              )}
            </Property>
            {bounty.categories.length > 0 && (
              // Why a backlog scan offered it, each reason after its name.
              <Property label="Why">
                <span className="flex min-w-0 flex-col gap-1">
                  {bounty.categories.map((category) => (
                    <span key={category.id} data-category={category.id}>
                      <span className="category-label">
                        <CategoryIcon
                          category={category.id}
                          className="size-3.5 shrink-0"
                        />
                        {category.label}
                      </span>
                      <span className="text-muted-foreground">
                        {" "}
                        · {category.reason}
                      </span>
                    </span>
                  ))}
                </span>
              </Property>
            )}
            <Property label="Sandbox">
              {sandboxStatus === false ? (
                <span className="text-muted-foreground">None yet</span>
              ) : (
                sandboxStatus
              )}
            </Property>
            {sandbox !== null && (
              <Property label="Submissions">
                <span className="text-muted-foreground">None accepted yet</span>
              </Property>
            )}
            {/* Each source named plainly, and what is not there quietly. */}
            <Property label="Jira">
              {bounty.jira === null ? (
                <span className="text-muted-foreground">None</span>
              ) : (
                <span className="flex min-w-0 flex-wrap items-center gap-x-2">
                  {bounty.jira.url === null ? (
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <span className="size-3.5 shrink-0">
                        <JiraIcon />
                      </span>
                      {bounty.jira.key}
                    </span>
                  ) : (
                    <a
                      href={bounty.jira.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      title={
                        followsJira
                          ? "Follows its Jira issue. Open in Jira"
                          : "Open in Jira"
                      }
                      className="focus-visible:ring-ring/50 inline-flex items-center gap-1.5 rounded-sm font-medium underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:outline-none"
                    >
                      <span className="size-3.5 shrink-0">
                        <JiraIcon />
                      </span>
                      {bounty.jira.key}
                      <ExternalLink className="text-muted-foreground size-3" />
                    </a>
                  )}
                  {!followsJira && (
                    <span className="text-muted-foreground">
                      Gone from Jira; keeps its last text
                    </span>
                  )}
                </span>
              )}
            </Property>
            <Property label="Repositories">{touchedValue}</Property>
            <Property label="Tech stack">
              {inherited.length === 0 && bounty.stack.length === 0 ? (
                <span className="text-muted-foreground">None</span>
              ) : (
                <StackChips
                  inherited={inherited}
                  inheritedFrom={inheritedFrom}
                  own={bounty.stack}
                />
              )}
            </Property>
            <Property label="Workspace">
              <span className="flex min-w-0 items-center gap-2 font-medium">
                <WorkspaceFace
                  organization={organization}
                  viewer={viewer}
                  className="size-4 shrink-0"
                  squareRadius="rounded-[4px]"
                />
                <span className="truncate">{workspaceLabel(organization)}</span>
              </span>
            </Property>
          </dl>
        </PanelSection>
      </div>
      <PanelSection title="Description">
        <BountyText
          description={bounty.description}
          inputTruncated={bounty.inputTruncated}
          framed={false}
        />
      </PanelSection>
      {sandbox !== null && (
        <PanelSection title="Sandbox">
          <SandboxGeneration
            organizationId={bounty.organizationId}
            workspace={organization.slug}
            sandbox={sandbox}
            canManage={canManage}
            canGenerate={unlinked}
            readOnly
            flat
            onChanged={() => {
              void bounties.refresh();
              onReload();
            }}
          />
        </PanelSection>
      )}
    </div>
  );
}

/**
 * A section of a bounty's panel: a heading over its content, set off from
 * the one before by a rule across the panel's full width, as its header is.
 */
function PanelSection({
  title,
  titleHidden = false,
  ruled = true,
  children,
}: {
  title: string;
  titleHidden?: boolean;
  ruled?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className={cn(
        "flex flex-col gap-3",
        ruled && "-mx-5 border-t px-5 pt-5 sm:-mx-6 sm:px-6",
      )}
    >
      <h3
        id={id}
        className={cn("text-sm font-semibold", titleHidden && "sr-only")}
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * One row of a panel's details: its name in a column of its own, its value
 * beside it. A value that runs to more lines keeps its name on its first.
 */
function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground flex h-8 items-center">{label}</dt>
      <dd className="flex min-h-8 min-w-0 items-center py-1">{children}</dd>
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
      <h3 id={id} className={cn("eyebrow", titleHidden && "sr-only")}>
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
 * A new bounty's fields, on the page it is written on: the title and
 * description in a wide column with the rest of the fields beside them,
 * below them on a narrow screen. A bounty that exists is changed a field at
 * a time where it is shown, not here.
 *
 * What is typed lives only here until it is saved, so leaving the page by
 * Cancel or by connecting a repository asks first once there is any.
 */
function BountyForm({
  repos,
  workspace,
  newRepository,
  initialDraft,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  repos: GithubRepos;
  /** The workspace the bounty goes to, which the form offers to change. */
  workspace: {
    organizations: MembershipDto[];
    viewer: Viewer;
    value: string;
    onChange: (organizationId: string) => void;
  };
  /**
   * Where a repository is connected, offered under the stack while the
   * workspace has none: the workspace's GitHub settings.
   */
  newRepository?: { href: string; onOpen: () => void } | undefined;
  /** What the form starts with, when it was opened about something. */
  initialDraft?: { description: string } | undefined;
  submitLabel: string;
  /** Resolves to null when saved, or to what to say. */
  onSubmit: (draft: BountyDraft) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState(
    initialDraft?.description ?? "",
  );
  /*
    Everything the person has added, kept across a change of workspace: a
    name the workspace's repositories also have shows as theirs while that
    workspace is chosen, and comes back as the person's if another is.
  */
  const [stack, setStack] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /*
    A bounty names no repository: its work may touch any the workspace has
    connected, so it inherits what was detected in every one of them.
  */
  const detected = workspaceStack(repos);
  const { inherited } = detected;
  const connected = repos.repos.some(isWorkspaceSource);
  const added = stack.filter(
    (name) => !inherited.some((repo) => sameStackName(repo, name)),
  );

  /*
    Where the person was about to go when they had something unsaved: held
    while they are asked whether to leave it, and taken if they say so.
  */
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  // Measured against what the form opened with: a description it was
  // started with is not the person's unsaved work.
  const unsaved =
    title.trim() !== "" ||
    description.trim() !== (initialDraft?.description ?? "").trim();
  const leave = (go: () => void) => {
    if (unsaved) setLeaving(() => go);
    else go();
  };

  const workspaceField = (
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
          onValueChange={workspace.onChange}
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
  const stackField = (
    <Labelled
      label="Tech stack"
      hint={
        detected.reading
          ? "The workspace's repositories are still being read; add what you know."
          : inherited.length > 0
            ? "Detected in the workspace's repositories, any of which the work may touch. Add anything else it needs."
            : "What the work is done in."
      }
    >
      {(field) => (
        <div className="flex flex-col items-start gap-2">
          <StackPicker
            id={field.id}
            describedBy={field.describedBy}
            inherited={inherited}
            inheritedFrom={detected.inheritedFrom}
            value={added}
            onChange={(next) =>
              // The ones hidden behind the repositories' are kept, so they
              // return if the workspace changes.
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
          {!connected && !repos.loading && newRepository !== undefined && (
            <a
              href={newRepository.href}
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
              onClick={(event) => {
                if (!isPlainLeftClick(event)) return;
                event.preventDefault();
                leave(newRepository.onOpen);
              }}
            >
              <Plus className="size-3" />
              Connect a repository
            </a>
          )}
        </div>
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
          className={cn(fieldClass, "font-mono min-h-72 lg:min-h-[28rem]")}
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
        <Button type="button" variant="ghost" onClick={() => leave(onCancel)}>
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
      className="grid gap-x-8 gap-y-6 lg:grid-cols-[minmax(0,1fr)_17rem]"
      data-testid="bounty-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (title.trim() === "") {
          setError("A bounty needs a title.");
          return;
        }
        // Its sandbox is written in it, so there must be something: the
        // repositories', still being read or detected, or the person's.
        if (added.length === 0 && inherited.length === 0 && !detected.reading) {
          setError("A bounty needs a tech stack.");
          return;
        }
        setSaving(true);
        setError(null);
        void onSubmit({
          title: title.trim(),
          description,
          // Only what the bounty adds: the repositories' own follow them.
          stack: added,
        }).then((failure) => {
          setSaving(false);
          setError(failure);
        });
      }}
    >
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
        {stackField}
      </div>
      <div className="flex flex-col gap-4">{footer}</div>
      <ConfirmDialog
        open={leaving !== null}
        onOpenChange={(open) => {
          if (!open) setLeaving(null);
        }}
        title="Discard this bounty?"
        description="It has not been created yet, so what you have written here is lost if you leave."
        confirmLabel="Discard"
        pendingLabel="Leaving…"
        onConfirm={() => {
          leaving?.();
        }}
      />
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
