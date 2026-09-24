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

import { ChevronRight, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { JiraConnections } from "./Jira";
import { JiraIcon, ProviderIcon, SlackIcon } from "./ProviderIcon";
import { connectionTabForSearch, type ConnectionTab } from "./routes";
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
    ready: false,
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
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
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
    window.history.pushState(
      null,
      "",
      window.location.pathname + (query === "" ? "" : `?${query}`),
    );
  }, []);

  return [tab, select];
}

export function Connections({
  organizationId,
  organizationSlug,
  role,
  onOpenBoard,
}: {
  organizationId: string;
  organizationSlug: string;
  role: string;
  onOpenBoard: (board: JiraBoard) => void;
}) {
  const [tab, select] = useConnectionTab();
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
            <TabsContent value="home">
              <Overview organizationId={organizationId} onSelect={select} />
            </TabsContent>
            <TabsContent value="jira">
              <JiraConnections
                organizationId={organizationId}
                organizationSlug={organizationSlug}
                role={role}
                onOpenBoard={onOpenBoard}
              />
            </TabsContent>
            {TOOLS.filter((tool) => !tool.ready).map((tool) => (
              <TabsContent key={tool.value} value={tool.value}>
                <ComingSoon tool={tool} />
              </TabsContent>
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
 */
function LunoxMark() {
  return (
    <>
      <img
        src="/brand/svg/logo-gradient.svg"
        alt=""
        width={24}
        height={24}
        className="size-6 dark:hidden"
      />
      <img
        src="/brand/svg/logo-gradient-dark.svg"
        alt=""
        width={24}
        height={24}
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
 * Reads Jira's connections itself rather than sharing the Jira tab's read.
 * Only one tab is mounted at a time, so opening this after disconnecting a
 * site on the Jira tab reads the list again rather than showing a count from
 * before the change.
 */
function Overview({
  organizationId,
  onSelect,
}: {
  organizationId: string;
  onSelect: (tab: ConnectionTab) => void;
}) {
  const { connections, loading, error } = useJira(organizationId);
  // Healthy ones only, matching what the home screen counts: a connection
  // that cannot be read is not one the organization can use.
  const active = connections.filter((entry) => entry.healthy).length;
  const broken = connections.length - active;

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
            : error !== null
              ? "Could not load this workspace\u2019s connections."
              : `${active} active connection${active === 1 ? "" : "s"} across ${TOOLS.length} tools.`}
        </p>
      </header>

      <ul className="grid gap-3 sm:grid-cols-3">
        {TOOLS.map((tool) => (
          <li key={tool.value}>
            <SummaryTile
              tool={tool}
              count={
                tool.value !== "jira" || loading
                  ? undefined
                  : error !== null
                    ? null
                    : active
              }
              caption={
                !tool.ready
                  ? "Coming soon"
                  : `active site${active === 1 ? "" : "s"}`
              }
              warning={
                tool.value === "jira" && broken > 0
                  ? `${broken} need${broken === 1 ? "s" : ""} reconnecting`
                  : undefined
              }
              onOpen={() => onSelect(tool.value)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
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
