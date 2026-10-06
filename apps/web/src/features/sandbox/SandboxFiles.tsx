/**
 * A version's private sandbox, read-only: every file its build wrote to
 * storage, the project contributors get and the hidden tests they never see,
 * in an explorer beside the open file.
 *
 * A page of its own, opened in a new tab from the bounty, so it stands
 * outside the app's shell and takes the whole window as an editor would —
 * and looks like one: Visual Studio Code's workbench in its default dark
 * theme, with its file icons and its syntax colours.
 * Owners and admins only, as the API is: the hidden tests are among them.
 */

import { ApiError } from "@sandbox-factory/client";
import type { MembershipDto, SandboxFileDto } from "@sandbox-factory/shared";
import { useQuery } from "@tanstack/react-query";
import {
  BookOpen,
  Braces,
  ChevronRight,
  CircleCheck,
  CircleX,
  CopyMinus,
  ExternalLink,
  Files,
  FlaskConical,
  Globe,
  Loader2,
  Lock,
  RefreshCw,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  PSEUDONYMS_FILE,
  invertAliasRules,
  rankAtLeast,
} from "sandbox-factory";

import { ErrorBanner, LoadingLine } from "@/components/Message";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { clients, queryKeys, useUserId } from "../../data/query";
import { replaceLocation, useLocation } from "../../navigation/location";
import { workspaceLabel } from "../../OrganizationSwitcher";
import {
  bountyProposalPath,
  isPlainLeftClick,
  sandboxFilesPath,
  type SandboxFilesAddress,
} from "../../routes";
import {
  fileTree,
  firstFile,
  foldersOf,
  sizeLabel,
  type TreeNode,
} from "./file-tree";
import { fileIconName, folderIconName, languageOf } from "./file-types";
import { Colored, useHighlighted } from "./Colored";
import { fileContentQuery, type FileSource } from "./file-content";
import { GherkinDocument } from "./GherkinDocument";
import { formatJson } from "./json-format";
import { MarkdownDocument } from "./MarkdownDocument";
import { PseudonymDocument } from "./Pseudonyms";
import { DocsPanel, SearchPanel, TestsPanel } from "./SidePanels";
import {
  BountyCard,
  ScenariosDocument,
  ScenariosOutline,
} from "./BountyScenarios";

/** How often a build still running is asked about. */
export const FILES_POLL_MS = 3_000;

/** The folder that holds the hidden tests, marked as such in the tree. */
const PRIVATE_FOLDER = "private";
/** The folder of what contributors get: all the public sandbox shows. */
const PUBLIC_FOLDER = "project";

/**
 * Which sandbox the page shows: the private one, every file the build wrote
 * and `pseudonym.lunox`, or the public one contributors work in. Private
 * unless `?side=public` says otherwise.
 */
export type SandboxSide = "private" | "public";
const SIDE_PARAM = "side";

function isPublicPath(path: string): boolean {
  return path.startsWith(`${PUBLIC_FOLDER}/`);
}

export function SandboxFilesPage({
  address,
}: {
  address: SandboxFilesAddress;
}) {
  const userId = useUserId();
  // Read, not selected: opening this tab must not change the workspace the
  // app's other tabs open on.
  const memberships = useQuery({
    queryKey: queryKeys.me(userId, "memberships"),
    queryFn: ({ signal }) => clients.memberships.memberships(signal),
  });
  const organization = memberships.data?.find(
    ({ slug }) => slug.toLowerCase() === address.workspace.toLowerCase(),
  );

  let body: React.ReactNode;
  if (memberships.isPending) body = <LoadingLine />;
  else if (memberships.isError)
    body = <ErrorBanner>Could not load your workspaces.</ErrorBanner>;
  else if (organization === undefined)
    body = (
      <Notice title="Workspace unavailable">
        It may have been renamed, removed, or no longer shared with you.
      </Notice>
    );
  else if (!rankAtLeast(organization.role, "admin"))
    body = (
      <Notice title="Owners and admins only">
        A version's files include its hidden tests, so only owners and admins of{" "}
        {workspaceLabel(organization)} can read them.
      </Notice>
    );
  else
    return (
      <SandboxFiles
        organization={organization}
        versionId={address.versionId}
        workspace={address.workspace}
      />
    );
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
      {body}
    </main>
  );
}

function Notice({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-muted-foreground mt-1 text-sm">{children}</p>
    </div>
  );
}

/**
 * The bounty's scenarios, open in the editor as a document of their own:
 * `?doc=scenarios` in the address, and this as its tab's key, which no
 * file's path can be.
 */
const SCENARIOS = "\u0000scenarios";
const SCENARIOS_DOC = "scenarios";
const SCENARIOS_ICON = "file-type-cucumber";
/**
 * The version's pseudonyms, as a file of the private folder. A build writes
 * it; it is shown from the version's own alias rules, which it copies, and
 * listed for a version built before builds wrote it.
 */
const PSEUDONYMS = `${PRIVATE_FOLDER}/${PSEUDONYMS_FILE}`;

/** The explorer's width as it opens, and the bounds it is dragged within. */
const SIDEBAR_WIDTH = 260;
const SIDEBAR_MIN = 170;
const SIDEBAR_MAX = 640;

function SandboxFiles({
  organization,
  versionId,
  workspace,
}: {
  organization: MembershipDto;
  versionId: string;
  /** As the address wrote it, so links keep its casing. */
  workspace: string;
}) {
  const userId = useUserId();
  const owner = organization.id;
  const version = useQuery({
    queryKey: queryKeys.resource(userId, owner, "sandbox-version", versionId),
    queryFn: ({ signal }) =>
      clients.sandbox.sandboxVersion(owner, versionId, signal),
  });
  const listing = useQuery({
    queryKey: queryKeys.resource(userId, owner, "sandbox-files", versionId),
    queryFn: ({ signal }) =>
      clients.sandbox.sandboxFiles(owner, versionId, signal),
    // A build still running has written nothing yet; its files arrive when
    // it commits.
    refetchInterval: (query) => {
      const status = query.state.data?.run?.status;
      return status === "queued" || status === "running"
        ? FILES_POLL_MS
        : false;
    },
  });
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const side: SandboxSide =
    params.get(SIDE_PARAM) === "public" ? "public" : "private";
  const allFiles = useMemo(() => listing.data?.files ?? [], [listing.data]);
  // The public sandbox is the project alone: no hidden tests, no manifests.
  const files = useMemo(
    () =>
      side === "public"
        ? allFiles.filter(({ path }) => isPublicPath(path))
        : allFiles,
    [allFiles, side],
  );
  const paths = useMemo(() => files.map(({ path }) => path), [files]);
  const doc = params.get("doc");
  const named = doc === SCENARIOS_DOC ? SCENARIOS : params.get("path");
  /*
    Closing the last tab leaves no file open: the address then names none,
    which otherwise opens the first, so this says it was closed. Opening a
    file names it again.
  */
  const [closedAll, setClosedAll] = useState(false);
  const selected =
    named ??
    (closedAll ? null : (firstFile(files.map(({ path }) => path)) ?? null));
  const open = files.find(({ path }) => path === selected) ?? null;
  const hrefOn = (on: SandboxSide) => (path: string | null) => {
    const page = sandboxFilesPath({ workspace, versionId });
    const url =
      path === null
        ? page
        : path === SCENARIOS
          ? `${page}?doc=${SCENARIOS_DOC}`
          : sandboxFilesPath({ workspace, versionId }, path);
    if (on === "private") return url;
    return `${url}${url.includes("?") ? "&" : "?"}${SIDE_PARAM}=public`;
  };
  const href = (path: string) => hrefOn(side)(path);
  /*
    The other sandbox, on the same file when it has one: the scenarios are
    in both, and the public sandbox's files in the private one too. One the
    public sandbox does not have gives way to its first.
  */
  const switchSide = () => {
    const next: SandboxSide = side === "private" ? "public" : "private";
    const keeps =
      selected !== null &&
      (next === "private" || selected === SCENARIOS || isPublicPath(selected));
    replaceLocation(hrefOn(next)(keeps ? selected : null));
  };
  const approved = version.data?.source?.approvedTask;
  // Undefined until the version is read; null for one approved without one.
  const draft = version.isPending ? undefined : (approved?.spec?.draft ?? null);
  const bountyHref =
    approved?.schemaVersion === 3
      ? bountyProposalPath({ workspace, id: approved.bountyId })
      : undefined;
  const [view, setView] = useState<View | null>("explorer");
  const [width, setWidth] = useState(SIDEBAR_WIDTH);
  /*
    A line to show, as the address's `#L12` names it: a search result's or
    a test's. Counted too, so the same line asked for twice is shown twice.
  */
  const { hash } = useLocation();
  const lineMatch = /^#L(\d+)$/.exec(hash);
  const line = lineMatch === null ? undefined : Number(lineMatch[1]);
  const [reveals, setReveals] = useState(0);
  const openAt = (path: string, at?: number) => {
    replaceLocation(at === undefined ? href(path) : `${href(path)}#L${at}`);
    setReveals((count) => count + 1);
  };
  /** The scenarios document, at one of its parts when one is named. */
  const scenariosHref = (anchor?: string) =>
    anchor === undefined ? href(SCENARIOS) : `${href(SCENARIOS)}#${anchor}`;
  const openScenarios = (anchor?: string) =>
    replaceLocation(scenariosHref(anchor));
  /*
    The private sandbox is the stored, public one read back through the
    inverse of its pseudonyms.
  */
  const aliasRules = version.data?.source?.aliasRules;
  const source: FileSource = useMemo(
    () => ({
      owner,
      versionId,
      runId: listing.data?.run?.id ?? null,
      renames:
        side === "private" && aliasRules !== undefined
          ? invertAliasRules(aliasRules)
          : [],
    }),
    [owner, versionId, listing.data, side, aliasRules],
  );

  const heading = version.data?.version.title ?? "Sandbox files";
  // The browser's tab keeps the version, to tell two of one sandbox apart.
  const versionLabel =
    version.data === undefined
      ? undefined
      : `Version ${version.data.version.version}`;
  useEffect(() => {
    const name =
      selected === SCENARIOS
        ? "Scenarios"
        : selected === PSEUDONYMS
          ? PSEUDONYMS
          : (open?.path ?? "Files");
    document.title = [name, heading, versionLabel, "Lunox"]
      .filter((part) => part !== undefined)
      .join(" · ");
  }, [heading, versionLabel, open, selected]);

  const notFound =
    (listing.error instanceof ApiError && listing.error.isNotFound) ||
    (version.error instanceof ApiError && version.error.isNotFound);

  const panel = {
    files,
    source,
    selected,
    href,
    onOpen: openAt,
    iconUrl: (name: string) => ICONS.get(name),
  };

  let content: React.ReactNode;
  if (notFound)
    content = (
      <Centered>
        This version does not exist in {workspaceLabel(organization)}.
      </Centered>
    );
  else if (listing.isError)
    content = (
      <Centered>
        <ErrorBanner className="mt-0">
          The version's files could not be listed.
        </ErrorBanner>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void listing.refetch()}
        >
          <RefreshCw />
          Try again
        </Button>
      </Centered>
    );
  else if (listing.isPending)
    content = (
      <Centered>
        <LoadingLine>Listing its files…</LoadingLine>
      </Centered>
    );
  else if (files.length === 0)
    content = (
      <Centered>
        {listing.data.run === null
          ? "This version has not been built yet, so it has no files."
          : listing.data.run.status === "failed"
            ? "Its build failed before it wrote any files."
            : listing.data.run.status === "succeeded"
              ? "Its build wrote no files."
              : "Its build is still running; its files appear when it finishes."}
      </Centered>
    );
  else
    content = (
      <>
        <SideBar
          title={VIEWS.find((each) => each.view === view)?.title ?? "Explorer"}
          hidden={view === null}
          width={width}
          onResize={setWidth}
        >
          <Pane shown={view === "explorer"}>
            <Explorer
              root={
                version.data === undefined
                  ? "Files"
                  : `Version ${version.data.version.version}`
              }
              files={files}
              selected={selected}
              href={href}
              pseudonyms={side === "private"}
            />
          </Pane>
          <Pane shown={view === "search"}>
            <SearchPanel active={view === "search"} {...panel} />
          </Pane>
          <Pane shown={view === "docs"}>
            <DocsPanel
              active={view === "docs"}
              {...panel}
              bounty={
                version.data === undefined ? undefined : (
                  <BountyCard
                    size={
                      approved?.pricing?.complexity ??
                      version.data.version.complexity
                    }
                    amountMinor={approved?.pricing?.amountMinor ?? null}
                    currency={approved?.pricing?.currency ?? null}
                    href={bountyHref}
                  />
                )
              }
              spec={
                draft === undefined || draft === null ? undefined : (
                  <ScenariosOutline
                    draft={draft}
                    href={scenariosHref}
                    current={
                      selected === SCENARIOS ? hash.slice(1) || undefined : null
                    }
                    onOpen={openScenarios}
                    iconUrl={panel.iconUrl}
                  />
                )
              }
            />
          </Pane>
          <Pane shown={view === "tests"}>
            <TestsPanel
              active={view === "tests"}
              {...panel}
              summary={version.data?.version.testSummary ?? []}
            />
          </Pane>
        </SideBar>
        <Editor
          files={files}
          documents={side === "private" ? [SCENARIOS, PSEUDONYMS] : [SCENARIOS]}
          selected={selected}
          href={href}
          onCloseAll={() => {
            setClosedAll(true);
            replaceLocation(hrefOn(side)(null));
          }}
          editor={
            selected === null ? (
              <Watermark />
            ) : selected === SCENARIOS ? (
              <section
                aria-label="Scenarios"
                className="flex min-h-0 min-w-0 flex-1 flex-col"
              >
                <ol
                  aria-label="Path"
                  className="flex h-[22px] shrink-0 items-center px-3 whitespace-nowrap text-(--wb-muted)"
                >
                  <li>Bounty</li>
                  <li className="flex items-center">
                    <ChevronRight
                      aria-hidden="true"
                      className="mx-0.5 size-4"
                    />
                    <TypeIcon name={SCENARIOS_ICON} />
                    <span className="ml-1 text-(--wb-foreground)">
                      Scenarios
                    </span>
                  </li>
                </ol>
                {draft === undefined ? (
                  <Centered>
                    <LoadingLine>Reading the scenarios…</LoadingLine>
                  </Centered>
                ) : draft === null ? (
                  <Centered>
                    This version was approved without a spec, so it has no
                    scenarios.
                  </Centered>
                ) : (
                  <ScenariosDocument
                    draft={draft}
                    bountyHref={bountyHref}
                    hash={hash}
                    href={scenariosHref}
                    onOpen={openScenarios}
                  />
                )}
              </section>
            ) : selected === PSEUDONYMS ? (
              <section
                aria-label={PSEUDONYMS}
                className="flex min-h-0 min-w-0 flex-1 flex-col"
              >
                <ol
                  aria-label="Path"
                  className="flex h-[22px] shrink-0 items-center px-3 whitespace-nowrap text-(--wb-muted)"
                >
                  <li>{PRIVATE_FOLDER}</li>
                  <li className="flex items-center">
                    <ChevronRight
                      aria-hidden="true"
                      className="mx-0.5 size-4"
                    />
                    <EntryIcon path={PSEUDONYMS} name="" />
                    <span className="ml-1 text-(--wb-foreground)">
                      {PSEUDONYMS.slice(PRIVATE_FOLDER.length + 1)}
                    </span>
                  </li>
                </ol>
                {side === "public" ? (
                  <Centered>
                    Pseudonyms are never shown to contributors, so the public
                    sandbox does not have it.
                  </Centered>
                ) : version.isPending ? (
                  <Centered>
                    <LoadingLine>Reading the pseudonyms…</LoadingLine>
                  </Centered>
                ) : version.data?.source === undefined ? (
                  <Centered>
                    This version's pseudonyms could not be read.
                  </Centered>
                ) : (
                  <PseudonymDocument
                    rules={version.data.source.aliasRules}
                    generated={version.data.source.origin === "starter"}
                  />
                )}
              </section>
            ) : open === null ? (
              <Centered>
                This version has no file at <code>{selected}</code>.
              </Centered>
            ) : (
              <Viewer
                source={source}
                file={open}
                paths={paths}
                href={href}
                line={line}
                reveals={reveals}
                onOpenAt={openAt}
              />
            )
          }
        />
      </>
    );

  return (
    <div className="workbench dark flex h-dvh flex-col overflow-hidden text-[13px]">
      <TitleBar
        heading={heading}
        workspace={workspaceLabel(organization)}
        bountyHref={bountyHref}
        side={side}
        onSwitchSide={switchSide}
      />
      <div className="flex min-h-0 flex-1">
        <ActivityBar view={view} onView={setView} />
        {content}
      </div>
      <StatusBar
        version={versionLabel}
        build={listing.data?.run?.status}
        file={open}
      />
    </div>
  );
}

/**
 * The window's top edge: the Lunox mark where the editor keeps its menus,
 * the way back home, and beside it which sandbox is shown; in the middle,
 * where it puts its command centre, what is open; at the right, whose it is.
 */
function TitleBar({
  heading,
  workspace,
  bountyHref,
  side,
  onSwitchSide,
}: {
  heading: string;
  workspace: string;
  /** The bounty's own page, opened beside the title; undefined until read. */
  bountyHref: string | undefined;
  side: SandboxSide;
  onSwitchSide: () => void;
}) {
  return (
    <header className="grid h-[35px] shrink-0 grid-cols-[1fr_minmax(0,38rem)_1fr] items-center gap-2 border-b border-(--wb-border) bg-(--wb-chrome) px-2">
      <div className="flex min-w-0 items-center justify-self-start">
        {/* Centred over the activity bar's icons, as the editor's own is. */}
        <span className="-ml-2 flex w-12 shrink-0 justify-center">
          <a
            href="/"
            aria-label="Lunox home"
            title="Home"
            className="flex rounded-sm text-(--wb-strong) focus-visible:outline-1 focus-visible:outline-(--wb-accent)"
          >
            <LunoxMark />
          </a>
        </span>
        <SidePill side={side} onSwitch={onSwitchSide} />
      </div>
      {/* The title centred in the box, the link held at its right edge,
          the same room kept clear either side so the centre is true. */}
      <div className="relative flex h-[24px] min-w-0 items-center justify-center rounded-md border border-(--wb-input-border) bg-(--wb-input) px-7 text-xs">
        <h1 className="min-w-0 truncate font-normal text-(--wb-foreground)">
          {heading}
        </h1>
        {bountyHref !== undefined && (
          <a
            href={bountyHref}
            target="_blank"
            rel="noreferrer"
            aria-label="Open the bounty"
            title="Open the bounty"
            className="absolute right-2 flex items-center rounded-sm text-(--wb-muted) hover:text-(--wb-strong) focus-visible:outline-1 focus-visible:outline-(--wb-accent)"
          >
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </a>
        )}
      </div>
      <span className="min-w-0 justify-self-end truncate text-xs text-(--wb-muted)">
        {workspace}
      </span>
    </header>
  );
}

/**
 * Which sandbox is shown, and the switch to the other: the private one, as
 * the workspace has it, or the public one, as contributors get it.
 */
function SidePill({
  side,
  onSwitch,
}: {
  side: SandboxSide;
  onSwitch: () => void;
}) {
  const Icon = side === "private" ? Lock : Globe;
  return (
    <button
      type="button"
      onClick={onSwitch}
      aria-label={side === "private" ? "Private sandbox" : "Public sandbox"}
      title={
        side === "private"
          ? "Every file the build wrote, hidden tests and pseudonyms included. Show the public sandbox."
          : "Only what contributors get. Show the private sandbox."
      }
      // Grey and nearly square, in the title box's colours: the label says
      // which sandbox, not the colour.
      className="flex h-[22px] min-w-0 items-center gap-1.5 rounded-[4px] border border-(--wb-input-border) bg-(--wb-input) px-2 text-xs whitespace-nowrap text-(--wb-foreground) transition-colors hover:bg-(--wb-hover) hover:text-(--wb-strong) focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-(--wb-accent)"
    >
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">
        {side === "private" ? "Private" : "Public"}
        <span className="max-sm:hidden"> sandbox</span>
      </span>
    </button>
  );
}

/**
 * The Lunox code mark in its own gradient, the dark variant: the workbench
 * is always dark. The one coloured thing in the title bar, so the page is
 * recognisably the product's and not only an editor's.
 *
 * Not draggable: an `<img>` is in hit-testing, and a click that moved a
 * pixel before release would pick it up as a native image drag.
 */
function LunoxMark() {
  return (
    <img
      src="/brand/svg/logo-gradient-dark.svg"
      alt=""
      width={16}
      height={16}
      draggable={false}
      className="size-4"
    />
  );
}

const VIEWS = [
  { view: "explorer", title: "Explorer", icon: Files },
  { view: "search", title: "Search", icon: Search },
  { view: "docs", title: "Docs", icon: BookOpen },
  { view: "tests", title: "Tests", icon: FlaskConical },
] as const;

type View = (typeof VIEWS)[number]["view"];

/**
 * The strip down the left edge, one button a view. The open view's button
 * closes the sidebar, as the editor's does.
 */
function ActivityBar({
  view,
  onView,
}: {
  view: View | null;
  onView: (view: View | null) => void;
}) {
  return (
    <div className="flex w-12 shrink-0 flex-col items-center border-r border-(--wb-border) bg-(--wb-chrome)">
      {VIEWS.map(({ view: each, title, icon: Icon }) => (
        <button
          key={each}
          type="button"
          aria-label={title}
          aria-pressed={view === each}
          title={title}
          onClick={() => onView(view === each ? null : each)}
          className={cn(
            "relative flex size-12 items-center justify-center text-(--wb-muted) hover:text-(--wb-strong) focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--wb-accent)",
            // The open view's marker in the product's ramp rather than the
            // editor's blue, as the status bar's chip is: the one place the
            // workbench says whose it is.
            view === each &&
              "text-(--wb-strong) before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-(image:--brand-gradient-vertical)",
          )}
        >
          <Icon aria-hidden="true" className="size-6" strokeWidth={1.25} />
        </button>
      ))}
    </div>
  );
}

/**
 * The bottom edge: that the sandbox is read-only and how its build went;
 * at the right, what the open file is and which version this is.
 */
function StatusBar({
  version,
  build,
  file,
}: {
  /** `Version 2`, once the version is read. */
  version: string | undefined;
  build: string | undefined;
  file: SandboxFileDto | null;
}) {
  const item = "flex h-full items-center gap-1 px-2 whitespace-nowrap";
  return (
    <footer className="flex h-[22px] shrink-0 items-center justify-between overflow-hidden border-t border-(--wb-border) bg-(--wb-chrome) text-xs text-(--wb-foreground)">
      <div className="flex h-full min-w-0 items-center">
        {/* The product's gradient, its dark theme's: light enough at its
            ends that the label is drawn dark over it. */}
        <span
          className={cn(
            item,
            "bg-(image:--brand-gradient) font-medium text-(--wb-chrome)",
          )}
        >
          <Lock aria-hidden="true" className="size-3" />
          Read-only
        </span>
        {build !== undefined && (
          <span className={cn(item, "max-sm:hidden")}>
            {build === "succeeded" ? (
              <CircleCheck aria-hidden="true" className="size-3" />
            ) : build === "failed" ? (
              <CircleX aria-hidden="true" className="size-3" />
            ) : (
              <Loader2 aria-hidden="true" className="size-3 animate-spin" />
            )}
            Build {build}
          </span>
        )}
      </div>
      <div className="flex h-full shrink-0 items-center">
        {file !== null && (
          <>
            <span className={cn(item, "tabular-nums max-sm:hidden")}>
              {sizeLabel(file.sizeBytes)}
            </span>
            <span className={item}>{languageOf(file.path).label}</span>
          </>
        )}
        {version !== undefined && (
          <span className={cn(item, "tabular-nums")}>{version}</span>
        )}
      </div>
    </footer>
  );
}

/** The editor with nothing open: a faint mark, and a hint. */
function Watermark() {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-6 bg-(--wb-editor) p-6 text-center text-sm text-(--wb-muted)">
      <Files
        aria-hidden="true"
        className="size-24 opacity-15"
        strokeWidth={0.75}
      />
      <p>Open a file from the explorer to read it.</p>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-(--wb-editor) p-6 text-center text-sm text-(--wb-muted)">
      {children}
    </div>
  );
}

/**
 * vscode-icons' drawings, written by `scripts/file-icons.mjs`. Files, not
 * inlined: a tree shows a few dozen, and the same few over and over.
 */
const ICON_FILES = import.meta.glob<string>("../../assets/files/*.svg", {
  eager: true,
  query: "?no-inline",
  import: "default",
});
const ICONS: ReadonlyMap<string, string> = new Map(
  Object.entries(ICON_FILES).map(([path, url]) => [
    path.slice(path.lastIndexOf("/") + 1, -".svg".length),
    url,
  ]),
);

/** A file or folder's icon; decoration, as its name is always beside it. */
function TypeIcon({ name }: { name: string }) {
  return (
    <img
      src={ICONS.get(name) ?? ICONS.get("default-file")}
      alt=""
      aria-hidden="true"
      className="size-4 shrink-0"
    />
  );
}

/** A tree row's or tab's icon: a document's own, else its file type's. */
function EntryIcon({ path, name }: { path: string; name: string }) {
  // Lunox's own file, in its gradient mark: the dark theme's, as the
  // workbench always is.
  if (path === PSEUDONYMS)
    return (
      <img
        src="/brand/svg/logo-gradient-dark.svg"
        alt=""
        aria-hidden="true"
        className="size-4 shrink-0"
      />
    );
  return (
    <TypeIcon name={path === SCENARIOS ? SCENARIOS_ICON : fileIconName(name)} />
  );
}

/** Opens a file in place: replaced, not pushed, as the explorer does. */
function openIn(href: string) {
  return (event: React.MouseEvent) => {
    if (!isPlainLeftClick(event)) return;
    event.preventDefault();
    // Moving through files is not a trail of pages to go Back through.
    replaceLocation(href);
  };
}

function Explorer({
  root,
  files,
  selected,
  href,
  pseudonyms,
}: {
  root: string;
  files: readonly SandboxFileDto[];
  selected: string | null;
  href: (path: string) => string;
  /** Whether the private folder lists `pseudonym.lunox` among its files. */
  pseudonyms: boolean;
}) {
  const tree = useMemo(
    () => (pseudonyms ? withPseudonyms(fileTree(files)) : fileTree(files)),
    [files, pseudonyms],
  );
  /*
    Folders open from the start: the top level, and those around the open
    file. Opening another file opens the folders around it too, as the
    editor reveals a file; nothing closes until someone closes it.
  */
  const [folders, setFolders] = useState<{
    revealed: string | null;
    expanded: ReadonlySet<string>;
  }>(() => ({
    revealed: selected,
    expanded: new Set([
      // The private folder too, though the public sandbox opens without it.
      PRIVATE_FOLDER,
      ...tree.flatMap((node) => (node.kind === "folder" ? [node.path] : [])),
      ...(selected === null ? [] : foldersOf(selected)),
    ]),
  }));
  let { expanded } = folders;
  if (folders.revealed !== selected) {
    expanded = new Set([
      ...expanded,
      ...(selected === null ? [] : foldersOf(selected)),
    ]);
    setFolders({ revealed: selected, expanded });
  }
  const setExpanded = (next: ReadonlySet<string>) =>
    setFolders({ revealed: selected, expanded: next });
  const toggle = (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setExpanded(next);
  };
  const [sectionOpen, setSectionOpen] = useState(true);

  const row =
    "relative flex h-[22px] w-full items-center gap-1.5 pr-3 text-left whitespace-nowrap hover:bg-(--wb-hover) focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--wb-accent)";
  // Indent per level. No guide lines down the levels: the indent alone says
  // what is in what, and a tree this shallow needs no more.
  const indent = (depth: number) => depth * 8 + 12;

  const render = (nodes: readonly TreeNode[], depth: number) => (
    <ul role={depth === 0 ? undefined : "group"}>
      {nodes.map((node) => {
        if (node.kind === "folder") {
          const isOpen = expanded.has(node.path);
          const hidden = depth === 0 && node.name === PRIVATE_FOLDER;
          return (
            <li key={node.path}>
              <button
                type="button"
                className={row}
                style={{ paddingLeft: `${indent(depth)}px` }}
                aria-expanded={isOpen}
                onClick={() => toggle(node.path)}
                title={
                  hidden
                    ? "Hidden tests and pseudonyms: never shown to contributors."
                    : undefined
                }
              >
                <ChevronRight
                  aria-hidden="true"
                  className={cn(
                    "size-4 shrink-0 text-(--wb-foreground)",
                    isOpen && "rotate-90",
                  )}
                />
                <TypeIcon name={folderIconName(node.name, isOpen)} />
                <span className="truncate">{node.name}</span>
                {hidden && (
                  <Lock
                    aria-label="hidden from contributors"
                    className="ml-auto size-3.5 shrink-0 text-(--wb-muted)"
                  />
                )}
              </button>
              {isOpen && render(node.children, depth + 1)}
            </li>
          );
        }
        const current = node.path === selected;
        return (
          <li key={node.path}>
            <a
              href={href(node.path)}
              aria-current={current ? "page" : undefined}
              className={cn(
                row,
                current &&
                  "bg-(--wb-selected) text-(--wb-strong) hover:bg-(--wb-selected)",
              )}
              // The chevron's width and gap, so a file lines up with a
              // folder's name.
              style={{ paddingLeft: `${indent(depth) + 22}px` }}
              onClick={openIn(href(node.path))}
            >
              <EntryIcon path={node.path} name={node.name} />
              <span className="truncate">{node.name}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );

  return (
    <>
      <div className="group/section flex h-[22px] shrink-0 items-center pr-3">
        <button
          type="button"
          aria-expanded={sectionOpen}
          onClick={() => setSectionOpen((value) => !value)}
          className="flex h-full min-w-0 flex-1 items-center pl-1 text-[11px] font-bold tracking-wide uppercase focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--wb-accent)"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn("size-4 shrink-0", sectionOpen && "rotate-90")}
          />
          <span className="truncate">{root}</span>
        </button>
        <button
          type="button"
          aria-label="Collapse folders"
          title="Collapse Folders in Explorer"
          onClick={() => {
            setExpanded(new Set());
            setSectionOpen(true);
          }}
          className="flex size-5 shrink-0 items-center justify-center rounded-sm text-(--wb-foreground) opacity-0 group-hover/section:opacity-100 hover:bg-(--wb-hover) focus-visible:opacity-100 coarse:opacity-100"
        >
          <CopyMinus aria-hidden="true" className="size-4" strokeWidth={1.5} />
        </button>
      </div>
      {sectionOpen && (
        <nav aria-label="Files" className="min-h-0 flex-1 overflow-auto pb-4">
          {render(tree, 0)}
        </nav>
      )}
    </>
  );
}

/**
 * The tree with `pseudonym.lunox` in its private folder, after the files
 * there, for a version built before builds wrote it; the folder is added,
 * first as folders are, for a version without one.
 */
function withPseudonyms(tree: TreeNode[]): TreeNode[] {
  const listed = (nodes: readonly TreeNode[]): boolean =>
    nodes.some((node) =>
      node.kind === "folder" ? listed(node.children) : node.path === PSEUDONYMS,
    );
  if (listed(tree)) return tree;
  const leaf: TreeNode = {
    kind: "file",
    name: PSEUDONYMS.slice(PRIVATE_FOLDER.length + 1),
    path: PSEUDONYMS,
    sizeBytes: 0,
  };
  const folder = tree.find(
    (node) => node.kind === "folder" && node.name === PRIVATE_FOLDER,
  );
  if (folder?.kind === "folder")
    return tree.map((node) =>
      node === folder
        ? { ...folder, children: [...folder.children, leaf] }
        : node,
    );
  return [
    {
      kind: "folder",
      name: PRIVATE_FOLDER,
      path: PRIVATE_FOLDER,
      children: [leaf],
    },
    ...tree,
  ];
}

/**
 * The sidebar: whichever view the activity bar has open, under its title,
 * dragged wider or narrower at its edge. Hidden rather than gone when no
 * view is open, so each view keeps what it had.
 */
function SideBar({
  title,
  hidden,
  width,
  onResize,
  children,
}: {
  title: string;
  hidden: boolean;
  width: number;
  onResize: (width: number) => void;
  children: React.ReactNode;
}) {
  const startResize = (event: React.PointerEvent) => {
    event.preventDefault();
    const fromX = event.clientX;
    const move = (moved: PointerEvent) =>
      onResize(
        Math.min(
          SIDEBAR_MAX,
          Math.max(SIDEBAR_MIN, width + moved.clientX - fromX),
        ),
      );
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };
  return (
    <aside
      aria-label={title}
      hidden={hidden}
      className={cn(
        "relative max-w-[75vw] shrink-0 flex-col border-r border-(--wb-border) bg-(--wb-chrome)",
        !hidden && "flex",
      )}
      style={{ width }}
    >
      <h2 className="flex h-[35px] shrink-0 items-center px-5 text-[11px] font-normal tracking-wide uppercase">
        {title}
      </h2>
      {children}
      <div
        aria-hidden="true"
        className="absolute inset-y-0 -right-[3px] z-20 w-[5px] cursor-col-resize transition-colors delay-150 hover:bg-(--wb-accent) max-sm:hidden"
        onPointerDown={startResize}
        onDoubleClick={() => onResize(SIDEBAR_WIDTH)}
      />
    </aside>
  );
}

/** One of the sidebar's views; hidden, not unmounted, when another shows. */
function Pane({
  shown,
  children,
}: {
  shown: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      hidden={!shown}
      className={shown ? "flex min-h-0 flex-1 flex-col" : undefined}
    >
      {children}
    </div>
  );
}

/**
 * The editor group: a tab for each file opened since the page loaded, the
 * open one's path as breadcrumbs, and the file itself.
 */
function Editor({
  files,
  documents,
  selected,
  href,
  onCloseAll,
  editor,
}: {
  files: readonly SandboxFileDto[];
  /** What opens in a tab besides the listed files: the scenarios, the pseudonyms. */
  documents: readonly string[];
  selected: string | null;
  href: (path: string) => string;
  /** The open file's tab, the last one, was closed. */
  onCloseAll: () => void;
  editor: React.ReactNode;
}) {
  const [opened, setOpened] = useState<readonly string[]>([]);
  useEffect(() => {
    if (selected === null) return;
    setOpened((paths) =>
      paths.includes(selected) ? paths : [...paths, selected],
    );
  }, [selected]);
  // The open file has a tab from its first render, not one effect later.
  const tabs = (
    selected === null || opened.includes(selected)
      ? opened
      : [...opened, selected]
  ).filter(
    (path) =>
      documents.includes(path) || files.some((file) => file.path === path),
  );

  const close = (path: string) => {
    const index = tabs.indexOf(path);
    const rest = tabs.filter((tab) => tab !== path);
    setOpened(rest);
    if (path !== selected) return;
    const next = rest[Math.min(index, rest.length - 1)];
    if (next === undefined) onCloseAll();
    else replaceLocation(href(next));
  };

  const nameOf = (path: string) =>
    path === SCENARIOS ? "Scenarios" : path.slice(path.lastIndexOf("/") + 1);
  return (
    <div className="flex min-w-0 flex-1 flex-col bg-(--wb-editor)">
      {tabs.length > 0 && (
        <nav
          aria-label="Open editors"
          className="flex h-[35px] shrink-0 overflow-x-auto overflow-y-hidden bg-(--wb-chrome) [scrollbar-width:none]"
        >
          {tabs.map((path) => {
            const name = nameOf(path);
            const active = path === selected;
            // Two tabs of the same name tell themselves apart by folder.
            const twin = tabs.some(
              (other) => other !== path && nameOf(other) === name,
            );
            return (
              <div
                key={path}
                className={cn(
                  "group/tab relative flex h-full shrink-0 items-center border-r border-b border-(--wb-border) text-(--wb-muted)",
                  active &&
                    "border-b-transparent bg-(--wb-editor) text-(--wb-strong) before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-(image:--brand-gradient)",
                )}
              >
                <a
                  href={href(path)}
                  aria-current={active ? "page" : undefined}
                  title={path === SCENARIOS ? "The bounty's scenarios" : path}
                  className="flex h-full items-center gap-1.5 pl-3 focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--wb-accent)"
                  onClick={openIn(href(path))}
                >
                  <EntryIcon path={path} name={name} />
                  <span>{name}</span>
                  {twin && (
                    <span className="text-xs text-(--wb-muted)">
                      {path.slice(0, path.lastIndexOf("/")) || "/"}
                    </span>
                  )}
                </a>
                <button
                  type="button"
                  aria-label={`Close ${name}`}
                  title="Close"
                  onClick={() => close(path)}
                  className={cn(
                    "mx-1 flex size-5 items-center justify-center rounded-sm opacity-0 group-hover/tab:opacity-100 hover:bg-white/10 focus-visible:opacity-100 coarse:opacity-100",
                    active && "opacity-100",
                  )}
                >
                  <X aria-hidden="true" className="size-4" />
                </button>
              </div>
            );
          })}
          <div className="min-w-4 flex-1 border-b border-(--wb-border)" />
        </nav>
      )}
      {editor}
    </div>
  );
}

function Viewer({
  source,
  file,
  paths,
  href,
  line,
  reveals,
  onOpenAt,
}: {
  /** Whose file, which run wrote it, and the names it is read back in. */
  source: FileSource;
  file: SandboxFileDto;
  /** Every file in the version, which a document's links may name. */
  paths: readonly string[];
  href: (path: string) => string;
  /** A line of this file to show, as written. */
  line: number | undefined;
  /** Changes each time a line is asked for, though it be the same one. */
  reveals: number;
  onOpenAt: (path: string, line?: number) => void;
}) {
  const userId = useUserId();
  const content = useQuery(fileContentQuery(userId, source, file.path));
  const language = languageOf(file.path).id;
  const text = content.data?.text ?? null;
  /*
    JSON is shown formatted, as it is easier to read laid out than as
    written, which for a build's output is often one long line. Undefined
    when that would change nothing, or the text is not JSON.
  */
  const formatted = useMemo(() => {
    if (language !== "json" || text === null) return undefined;
    const laidOut = formatJson(text);
    return laidOut === undefined || laidOut === text.trimEnd()
      ? undefined
      : laidOut;
  }, [language, text]);
  /*
    How the file reads best, when that is not as written: JSON formatted,
    Markdown rendered as a document. Shown first, with a toggle back to the
    text as written.
  */
  const rendering: Rendering | undefined =
    text === null
      ? undefined
      : language === "gherkin"
        ? {
            label: "Preview",
            icon: BookOpen,
            title: "Laid out as scenarios.",
            view: (
              <GherkinDocument
                text={text}
                onReveal={(at) => onOpenAt(file.path, at)}
              />
            ),
          }
        : language === "markdown"
          ? {
              label: "Preview",
              icon: BookOpen,
              title: "Rendered as a document.",
              view: (
                <MarkdownDocument
                  text={text}
                  path={file.path}
                  paths={paths}
                  href={href}
                  onOpen={(path) => openIn(href(path))}
                />
              ),
            }
          : formatted !== undefined
            ? {
                label: "Format JSON",
                icon: Braces,
                title: "Formatted for reading.",
                view: (
                  <Source
                    key={`${file.path}:formatted`}
                    text={formatted}
                    language={language}
                  />
                ),
              }
            : undefined;
  // The file someone asked to see as written; any other is rendered.
  const [asWrittenFor, setAsWrittenFor] = useState<string | null>(null);
  // A line is a line of the file as written.
  const showRendered =
    rendering !== undefined && asWrittenFor !== file.path && line === undefined;

  let body: React.ReactNode;
  if (content.isPending)
    body = (
      <Centered>
        <LoadingLine>Reading {file.path}…</LoadingLine>
      </Centered>
    );
  else if (content.isError)
    body = (
      <Centered>
        <ErrorBanner className="mt-0">This file could not be read.</ErrorBanner>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void content.refetch()}
        >
          <RefreshCw />
          Try again
        </Button>
      </Centered>
    );
  else if (content.data.text === null)
    body = (
      <Centered>
        {content.data.omitted === "too_large"
          ? `This file is ${sizeLabel(file.sizeBytes)}, too large to show here.`
          : "This file is not text, so it is not shown here."}
      </Centered>
    );
  else if (showRendered) body = rendering.view;
  else
    body = (
      <Source
        key={file.path}
        text={content.data.text}
        language={language}
        line={line}
        reveals={reveals}
      />
    );

  const parts = file.path.split("/");
  return (
    <section
      aria-label={file.path}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="flex h-[22px] shrink-0 items-center pr-2">
        <ol
          aria-label="Path"
          className="flex h-full min-w-0 flex-1 items-center overflow-x-auto px-3 whitespace-nowrap text-(--wb-muted) [scrollbar-width:none]"
        >
          {parts.map((part, index) => {
            const last = index === parts.length - 1;
            return (
              <li key={index} className="flex items-center">
                {index > 0 && (
                  <ChevronRight aria-hidden="true" className="mx-0.5 size-4" />
                )}
                {last && <TypeIcon name={fileIconName(part)} />}
                <span className={cn(last && "ml-1 text-(--wb-foreground)")}>
                  {part}
                </span>
              </li>
            );
          })}
        </ol>
        {rendering !== undefined && (
          <button
            type="button"
            aria-pressed={showRendered}
            title={
              showRendered
                ? `${rendering.title} Show the file as written.`
                : "Shown as written."
            }
            onClick={() => {
              if (showRendered) {
                setAsWrittenFor(file.path);
                return;
              }
              setAsWrittenFor(null);
              // Rendered, the file has no lines to point at.
              if (line !== undefined) onOpenAt(file.path);
            }}
            className={cn(
              "flex h-[18px] shrink-0 items-center gap-1 rounded-sm px-1.5 text-xs text-(--wb-muted) hover:bg-(--wb-hover) hover:text-(--wb-foreground) focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--wb-accent)",
              showRendered && "bg-(--wb-selected) text-(--wb-foreground)",
            )}
          >
            <rendering.icon aria-hidden="true" className="size-3.5" />
            {rendering.label}
          </button>
        )}
      </div>
      {body}
    </section>
  );
}

/** A file shown as it reads best, and the toggle that shows it. */
interface Rendering {
  label: string;
  icon: LucideIcon;
  title: string;
  view: React.ReactNode;
}

/** The source view's line height, in pixels: `leading-[19px]`. */
const LINE_HEIGHT = 19;

/** Text with its line numbers, scrolled together; long lines scroll, not wrap. */
function Source({
  text,
  language,
  line,
  reveals = 0,
}: {
  text: string;
  language: string;
  /** A line to scroll to and mark. */
  line?: number;
  reveals?: number;
}) {
  const lines = text.endsWith("\n") ? text.slice(0, -1) : text;
  const count = lines === "" ? 1 : lines.split("\n").length;
  const numbers = Array.from({ length: count }, (_, index) => index + 1).join(
    "\n",
  );
  const tokens = useHighlighted(lines, language);
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (line === undefined || element === null) return;
    // A third of the way down, where the eye lands, as the editor puts it.
    element.scrollTop = Math.max(
      0,
      (line - 1) * LINE_HEIGHT - element.clientHeight / 3,
    );
  }, [line, reveals]);
  return (
    <div
      ref={scroller}
      className="relative flex min-h-0 flex-1 overflow-auto font-(family-name:--wb-font-code) text-[13px] leading-[19px] text-(--wb-code)"
    >
      {line !== undefined && line <= count && (
        <div
          aria-hidden="true"
          data-testid="revealed-line"
          className="pointer-events-none absolute inset-x-0 border-y border-white/[0.08] bg-white/[0.05]"
          style={{ top: (line - 1) * LINE_HEIGHT, height: LINE_HEIGHT }}
        />
      )}
      <pre
        aria-hidden="true"
        className="sticky left-0 z-10 shrink-0 bg-(--wb-editor) pr-[26px] pl-4 text-right text-(--wb-gutter) select-none"
        style={{ minWidth: `${String(count).length + 4}ch` }}
      >
        {numbers}
      </pre>
      <pre className="flex-1 pr-8 pb-[50vh]" data-testid="file-source">
        <code>
          <Colored text={lines} tokens={tokens} />
        </code>
      </pre>
    </div>
  );
}
