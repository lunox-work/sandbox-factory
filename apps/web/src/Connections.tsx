import { pushLocation, subscribeLocation } from "./navigation/location";
/**
 * An organization's connections: the tools it reads work from, managed in
 * place on its settings page.
 *
 * A column of square tabs on the left — an overview, then one per tool — and
 * one large card on the right showing whichever is chosen. The squares carry
 * only the tool's mark, which is how each tool is recognised anyway, so the
 * card gets the width.
 *
 * Jira used to be managed on a page of its own, reached from a row in a card
 * here. That made the settings page a signpost to the thing it was meant to
 * set: the Jira tab is now that page, and `/o/:slug/jira` redirects to it.
 *
 * The chosen tab is in the query (`?connection=jira`), so a reload, a link, and
 * the return from Atlassian's consent screen all open on it. The overview is
 * the default and is never written, so a plain settings URL opens there.
 */

import type { GithubRepoDto } from "@sandbox-factory/shared";
import { ChevronRight, TriangleAlert } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { GithubConnections } from "./Github";
import { JiraConnections } from "./Jira";
import { JiraIcon, ProviderIcon, SlackIcon } from "./ProviderIcon";
import { connectionTabForSearch, type ConnectionTab } from "./routes";
import { useGithub } from "./useGithub";
import { useJira, type JiraBoard } from "./useJira";

/** A tool on the rail. `ready` is false for the ones not built yet. */
interface Tool {
  value: Exclude<ConnectionTab, "home">;
  label: string;
  icon: ReactNode;
  ready: boolean;
}

/*
  Each carries its own mark rather than a provider id: Slack is not a sign-in
  provider, so it has no `ProviderId` to look one up by. Jira's mark rather
  than Atlassian's, because what is named is the product whose boards are
  read; signing in is the other one.
*/
const TOOLS: Tool[] = [
  { value: "jira", label: "Jira", icon: <JiraIcon />, ready: true },
  {
    value: "github",
    label: "GitHub",
    icon: <ProviderIcon provider="github" />,
    ready: true,
  },
  { value: "slack", label: "Slack", icon: <SlackIcon />, ready: false },
];

/**
 * Reads the chosen tab from the query and writes it back.
 *
 * Pushed rather than replaced, matching the page's own tabs: each is a place,
 * and Back should return to the one before. Only on an organization's own
 * path, so rendering this outside the app (a test at `/`) cannot rewrite the
 * URL of whatever page it is on.
 */
function useConnectionTab(): [ConnectionTab, (next: string) => void] {
  const [tab, setTab] = useState<ConnectionTab>(() =>
    connectionTabForSearch(window.location.search),
  );

  useEffect(() => {
    const sync = () => setTab(connectionTabForSearch(window.location.search));
    return subscribeLocation(sync);
  }, []);

  const select = useCallback((next: string) => {
    const chosen = next as ConnectionTab;
    setTab(chosen);
    if (!window.location.pathname.startsWith("/o/")) {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    if (chosen === "home") {
      params.delete("connection");
    } else {
      params.set("connection", chosen);
    }
    const query = params.toString();
    pushLocation(
      window.location.pathname +
        (query === "" ? "" : `?${query}`) +
        (window.location.hash ?? ""),
    );
  }, []);

  return [tab, select];
}

/**
 * Every tab opened so far, the chosen one included.
 *
 * Added to while rendering rather than in an effect, so a newly chosen
 * tab's panel is in the same paint as the indicator setting off for it.
 */
function useVisited(tab: ConnectionTab): ReadonlySet<ConnectionTab> {
  const [visited, setVisited] = useState<ReadonlySet<ConnectionTab>>(
    () => new Set([tab]),
  );
  if (visited.has(tab)) {
    return visited;
  }
  const next = new Set(visited).add(tab);
  setVisited(next);
  return next;
}

/**
 * A tab's panel: mounted the first time its tab is opened, then kept, and
 * hidden while another is chosen.
 *
 * Radix unmounts a panel when its tab is left, so every switch read the
 * panel's lists again from nothing. The card dropped to a loading line and
 * grew back as each read arrived, and with it the page's scrollbar went and
 * came back, all while the indicator was still gliding. Kept, a panel opens
 * on what it last showed.
 *
 * Not mounted before it is opened: the Jira panel re-syncs each site's boards
 * with Atlassian as it mounts (see `SiteBoardsCard` in Jira.tsx), which is
 * for somebody looking at them, not for everyone who opens settings.
 */
function Panel({
  value,
  tab,
  visited,
  children,
}: {
  value: ConnectionTab;
  tab: ConnectionTab;
  visited: ReadonlySet<ConnectionTab>;
  children: ReactNode;
}) {
  if (!visited.has(value)) {
    return null;
  }
  // `forceMount` keeps Radix from unmounting it, and leaves hiding it to us.
  return (
    <TabsContent value={value} forceMount hidden={value !== tab}>
      {children}
    </TabsContent>
  );
}

export function Connections({
  organizationId,
  organizationSlug,
  role,
  onOpenBoard,
  onOpenRepository,
}: {
  organizationId: string;
  organizationSlug: string;
  role: string;
  onOpenBoard: (board: JiraBoard) => void;
  /** Opens a registered repository's page; see `GithubConnections`. */
  onOpenRepository?: ((repo: GithubRepoDto) => void) | undefined;
}) {
  const [tab, select] = useConnectionTab();
  const visited = useVisited(tab);
  const indicatorIndex = Math.max(
    0,
    ["home", ...TOOLS.map((tool) => tool.value)].indexOf(tab),
  );

  return (
    <section
      aria-labelledby="connections-heading"
      className="flex flex-col gap-4"
    >
      <div>
        <h2 id="connections-heading" className="leading-none font-semibold">
          Connections
        </h2>
        <p className="text-muted-foreground mt-1.5 text-sm">
          Connect the tools you already work in, so their work can be read and
          priced here.
        </p>
      </div>

      {/*
        Vertical, so the arrow keys move up and down the column the way it is
        drawn. `items-stretch` on the row lets the card grow to at least the
        column's height, so a short panel does not leave the squares hanging
        below it.

        No gap between the column and the card: the chosen square is joined
        to it by the indicator (see `.connection-indicator` in `index.css`),
        and the others keep their distance by being narrower than the
        column. The column's width is fixed at the joined shape's, so the
        card never moves while the indicator slides between squares.

        Padded above and below by twice the card's corner radius, so the
        card always runs past the first and last squares with room for both
        the curve where a square joins it and the card's own corner. With
        the first square level with the card's top, the card had to square
        off that corner while Home was chosen, and so change shape.
      */}
      <Tabs
        value={tab}
        onValueChange={select}
        orientation="vertical"
        className="connection-tabs flex-row items-stretch gap-0"
      >
        <TabsList
          variant="plain"
          aria-label="Connections"
          className="relative z-10 h-auto w-[calc(2.75rem+13px)] flex-none flex-col items-start justify-start gap-2 self-start rounded-none bg-transparent p-0 py-8"
        >
          {/*
            The chosen square's folder tab, one piece for every square: it
            slides to the chosen one rather than each square reshaping in
            place. Moved by `transform` alone, which the browser can animate
            without laying anything out again. A square is 2.75rem and the
            gap between two is 0.5rem.
          */}
          <span
            aria-hidden="true"
            className="connection-indicator"
            style={{ transform: `translateY(${indicatorIndex * 3.25}rem)` }}
          />
          <SquareTab value="home" label="Home" icon={<LunoxMark />} />
          {TOOLS.map((tool) => (
            <SquareTab
              key={tool.value}
              value={tool.value}
              label={tool.label}
              icon={tool.icon}
            />
          ))}
        </TabsList>

        {/*
          Flat, with no shadow or halo: the chosen square joins it, and a
          soft edge on either would not meet the other's at the join. Pulled
          a pixel left so the indicator overlaps its border and covers it
          where they join. Static: nothing about it changes with the tab.
        */}
        <Card className="-ml-px min-w-0 flex-1 border-(--connection-edge) shadow-none">
          <CardContent>
            <Panel value="home" tab={tab} visited={visited}>
              <Overview
                organizationId={organizationId}
                shown={tab === "home"}
                onSelect={select}
              />
            </Panel>
            <Panel value="jira" tab={tab} visited={visited}>
              <JiraConnections
                organizationId={organizationId}
                organizationSlug={organizationSlug}
                role={role}
                onOpenBoard={onOpenBoard}
              />
            </Panel>
            <Panel value="github" tab={tab} visited={visited}>
              <GithubConnections
                organizationId={organizationId}
                organizationSlug={organizationSlug}
                role={role}
                onOpenRepository={onOpenRepository}
              />
            </Panel>
            {TOOLS.filter((tool) => !tool.ready).map((tool) => (
              <Panel
                key={tool.value}
                value={tool.value}
                tab={tab}
                visited={visited}
              >
                <ComingSoon tool={tool} />
              </Panel>
            ))}
          </CardContent>
        </Card>
      </Tabs>
    </section>
  );
}

/**
 * Lunox's own mark, on the square that opens the overview: that tab is about
 * what this app has connected, so it wears the app's mark beside the tools'.
 *
 * Both variants, with the theme picking one, rather than a `<picture>` on
 * `prefers-color-scheme` as the sign-in screen does: dark mode here also
 * follows a `.dark` class, which a media query cannot see, and the `dark:`
 * variant covers both. The dark file is the same mark with a brighter
 * gradient, which the primary one loses against a dark square.
 *
 * A size up from the tools' marks: it is wide and short, with room around
 * it in its own viewBox, so at the same box it read as the smallest of the
 * four.
 *
 * Decorative: the square's label already says "Home".
 *
 * Not draggable. The tools' marks are inline SVG, which the tab primitive
 * takes out of hit-testing; an `<img>` is not, and a click that moved a pixel
 * before release picked it up as a native image drag, trailing a ghost of the
 * mark under the cursor.
 */
function LunoxMark() {
  return (
    <>
      <img
        src="/brand/svg/logo-gradient.svg"
        alt=""
        width={24}
        height={24}
        draggable={false}
        className="size-6 dark:hidden"
      />
      <img
        src="/brand/svg/logo-gradient-dark.svg"
        alt=""
        width={24}
        height={24}
        draggable={false}
        className="hidden size-6 dark:block"
      />
    </>
  );
}

/**
 * One square on the rail: the mark alone.
 *
 * The name is the accessible label and the hover title rather than visible
 * text. A word under each mark would make the column wide enough to take the
 * card's room, and the marks are how these tools are told apart anyway.
 */
function SquareTab({
  value,
  label,
  icon,
}: {
  value: ConnectionTab;
  label: string;
  icon: ReactNode;
}) {
  return (
    <TabsTrigger
      value={value}
      aria-label={label}
      title={label}
      /*
        The chosen square joins the card rather than being tinted: the marks
        are full colour, and a faint grey behind one of them was too little
        to find at a glance which tool the card is showing. No darker edge
        or halo either; the shape says which one is open, and a halo's soft
        edges doubled up where the square meets the card.

        Full text colour at rest, in both themes. GitHub's mark and the Home
        icon are drawn in `currentColor`, so the muted colour the tab
        primitive uses (in dark mode only) greyed those two out beside the
        full-colour Jira and Slack marks. Which square is chosen is said by
        its shape, not by dimming the others.

        It joins the card like a folder's tab, drawn by the indicator that
        slides beneath the squares rather than by the square itself: the
        chosen one only gives up its own frame, border and fill, so the
        indicator's shape shows through with the mark on top. The frame
        fades as the indicator arrives and returns as it leaves, so the two
        hand over rather than swap. Positioned, so it paints above the
        indicator, which comes first in the list.
      */
      className="connection-tab bg-card text-foreground dark:text-foreground hover:bg-muted/60 data-[state=active]:text-foreground relative size-11 flex-none rounded-lg border-border p-0 shadow-none data-[state=active]:border-transparent data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:hover:bg-transparent dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-transparent [&_svg:not([class*='size-'])]:size-5"
    >
      {icon}
    </TabsTrigger>
  );
}

/**
 * The overview: how much each tool has connected, and the way into it.
 *
 * Reads each tool's connections itself rather than sharing the tab's read,
 * and reads them again each time it is shown after another tab. The panels
 * stay mounted (see `Panel`), so coming back after disconnecting a site on
 * the Jira tab would otherwise show the count from before the change.
 */
function Overview({
  organizationId,
  shown,
  onSelect,
}: {
  organizationId: string;
  /** Whether its tab is the chosen one. */
  shown: boolean;
  onSelect: (tab: ConnectionTab) => void;
}) {
  const jira = useJira(organizationId);
  const github = useGithub(organizationId);
  const { refresh: refreshJira } = jira;
  const { refresh: refreshGithub } = github;
  /*
    Only on coming back: the first showing is the mount, which has just read
    both.
  */
  const wasShown = useRef(shown);
  useEffect(() => {
    if (shown && !wasShown.current) {
      void refreshJira();
      void refreshGithub();
    }
    wasShown.current = shown;
  }, [shown, refreshJira, refreshGithub]);
  /*
    Blank until each has answered once, and not again: a re-read keeps the
    last answer on screen, so coming back does not blank the counts and
    fill them in again.
  */
  const jiraAnswered = useAnswered(jira.loading);
  const githubAnswered = useAnswered(github.loading);
  /*
    Healthy ones only, matching what the home screen counts: a connection
    that cannot be read is not one the organization can use. Each tool's
    noun is its own — Jira connects sites, GitHub connects accounts.
  */
  const tally = (
    read: {
      connections: { healthy: boolean }[];
      error: string | null;
    },
    answered: boolean,
    noun: string,
  ) => {
    const active = read.connections.filter((entry) => entry.healthy).length;
    return {
      loading: !answered,
      error: read.error,
      active,
      broken: read.connections.length - active,
      caption: `active ${noun}${active === 1 ? "" : "s"}`,
    };
  };
  /*
    A server without the GitHub App answers that it is not set up, which is
    neither a count nor a failure: the tile says so and the total leaves it
    out, so Jira's count is not reported as a failed load.
  */
  const counts: Partial<Record<Tool["value"], ReturnType<typeof tally>>> = {
    jira: tally(jira, jiraAnswered, "site"),
    ...(github.unconfigured
      ? {}
      : { github: tally(github, githubAnswered, "account") }),
  };
  const read = Object.values(counts);
  const loading = read.some((entry) => entry.loading);
  const failed = read.some((entry) => entry.error !== null);
  const active = read.reduce((sum, entry) => sum + entry.active, 0);

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h3 className="leading-none font-semibold">Overview</h3>
        {/*
          A non-breaking space while the answer is unknown: the line does not
          claim none and then correct itself, and still holds its height.
        */}
        <p className="text-muted-foreground mt-1.5 text-sm">
          {loading
            ? "\u00a0"
            : failed
              ? "Could not load this workspace\u2019s connections. "
              : // Counted over the tools that can be connected: one still
                // to come has nothing to be active in.
                `${active} active connection${active === 1 ? "" : "s"} across ${TOOLS.filter((tool) => tool.ready).length} tools.`}
          {!loading && failed && (
            <button
              type="button"
              className="text-primary rounded-sm font-medium hover:underline"
              onClick={() => {
                void refreshJira();
                void refreshGithub();
              }}
            >
              Try again
            </button>
          )}
        </p>
      </header>

      <ul className="grid gap-3 sm:grid-cols-3">
        {TOOLS.map((tool) => {
          const count = counts[tool.value];
          return (
            <li key={tool.value}>
              <SummaryTile
                tool={tool}
                count={
                  count === undefined || count.loading
                    ? undefined
                    : count.error !== null
                      ? null
                      : count.active
                }
                caption={
                  tool.value === "github" && github.unconfigured
                    ? "Not set up on this server"
                    : !tool.ready || count === undefined
                      ? "Coming soon"
                      : count.caption
                }
                warning={
                  count !== undefined && count.broken > 0
                    ? `${count.broken} need${count.broken === 1 ? "s" : ""} reconnecting`
                    : undefined
                }
                onOpen={() => onSelect(tool.value)}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Whether a read has answered at least once; later re-reads do not undo it. */
function useAnswered(loading: boolean): boolean {
  const [answered, setAnswered] = useState(!loading);
  if (!loading && !answered) {
    setAnswered(true);
  }
  return answered || !loading;
}

/**
 * One tool in the overview. The whole tile opens that tool's tab, the same as
 * its square on the rail — a count is only useful if it leads to the list it
 * counts.
 */
function SummaryTile({
  tool,
  count,
  caption,
  warning,
  onOpen,
}: {
  tool: Tool;
  /**
   * Undefined while loading, and for a tool that is not built; null when the
   * read failed, so the tile does not claim a zero it never counted.
   */
  count: number | null | undefined;
  caption: string;
  warning?: string | undefined;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group hover:bg-muted/50 focus-visible:ring-ring/50 flex h-full w-full flex-col gap-3 rounded-lg border p-3.5 text-left transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
    >
      <span className="flex w-full items-center gap-2">
        <span className="grid size-5 shrink-0 place-items-center">
          {tool.icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {tool.label}
        </span>
        <ChevronRight className="text-muted-foreground group-hover:text-foreground size-4 shrink-0 transition-colors" />
      </span>
      <span>
        <span
          className={`block text-2xl leading-none font-semibold tabular-nums ${
            tool.ready && count !== null ? "" : "text-muted-foreground/60"
          }`}
        >
          {!tool.ready || count === null ? "\u2014" : (count ?? "\u00a0")}
        </span>
        <span className="text-muted-foreground mt-1.5 block text-xs">
          {caption}
        </span>
        {warning !== undefined && (
          <span className="text-destructive mt-1 flex items-center gap-1 text-xs">
            <TriangleAlert className="size-3 shrink-0" />
            {warning}
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * A tool that is not built yet. It has a tab of its own rather than none, so
 * the rail names every tool the organization will be able to connect; this
 * says so plainly instead of drawing controls that do nothing.
 */
function ComingSoon({ tool }: { tool: Tool }) {
  return (
    <div className="flex flex-col gap-5">
      {/* No mark: the square this was opened from carries it. */}
      <header className="flex items-center gap-2">
        <h3 className="leading-none font-semibold">{tool.label}</h3>
        <Badge variant="secondary">Coming soon</Badge>
      </header>
      <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-sm">
        Connecting {tool.label} is not available yet. When it is, this
        workspace&rsquo;s {tool.label} connections will be managed here.
      </p>
    </div>
  );
}
