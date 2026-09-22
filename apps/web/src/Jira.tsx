/**
 * Connected Jira sites, for one organization.
 *
 * The page a client lands on after consenting, which is why the outcome
 * banner is the first thing it renders: they have just been through
 * Atlassian's consent screen and need to know whether it worked, and if not,
 * what to do about it.
 *
 * What may be done depends on the caller's role, which comes from the API
 * rather than being inferred here. The server checks it again on every write;
 * hiding a control the API would refuse is courtesy, not security.
 */

import {
  ChevronRight,
  CircleCheck,
  CircleX,
  Columns3,
  ExternalLink,
  LayoutGrid,
  Link2,
  Loader2,
  RefreshCw,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PeekPanel } from "@/components/PeekPanel";
import { ErrorBanner, LoadingLine } from "@/components/Message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { JiraIcon } from "./ProviderIcon";
import { isPlainLeftClick, pathForScreen } from "./routes";
import { BoardBounties } from "./Bounties";

import {
  useJira,
  useJiraBoards,
  useJiraOutcome,
  type BacklogPreview,
  type JiraBoard,
  type JiraConnection,
  type JiraFetchError,
  type JiraIssueDetail,
  type JiraOutcome,
} from "./useJira";

/** Roles that may connect or disconnect, matching the API's own floor. */
function canManage(role: string): boolean {
  return role
    .split(",")
    .map((entry) => entry.trim())
    .some((entry) => entry === "owner" || entry === "admin");
}

/**
 * What each outcome means, in the words the person needs.
 *
 * `cancelled` and `no-sites` are deliberately not errors: the first is a
 * choice, and the second usually means the account has no Jira product rather
 * than anything being broken.
 */
function describeOutcome(
  outcome: JiraOutcome,
  missingScopes: string[],
): { tone: "ok" | "warn" | "error"; title: string; detail: string } {
  switch (outcome) {
    case "connected":
      return {
        tone: "ok",
        title: "Jira connected",
        detail:
          "We can read the boards on that site, and approvals will post back to its tickets.",
      };
    case "cancelled":
      return {
        tone: "warn",
        title: "Connection cancelled",
        detail: "Nothing was changed. You can try again whenever you like.",
      };
    case "no-sites":
      return {
        tone: "warn",
        title: "No Jira site was granted",
        detail:
          "The Atlassian account you used has no Jira site, or you granted only Confluence. Try again with an account that can see the board you want.",
      };
    case "partial-scopes":
      return {
        tone: "warn",
        title: "Connected, but some permissions are missing",
        detail: describeMissingScopes(missingScopes),
      };
    case "denied":
      return {
        tone: "error",
        title: "Atlassian refused the connection",
        detail:
          "The authorisation could not be completed. Try connecting again.",
      };
    case "state":
      return {
        tone: "error",
        title: "That connection link could not be verified",
        detail:
          "It may have expired, or been started in another browser. Start again from this page.",
      };
    case "forbidden":
      return {
        tone: "error",
        title: "You are no longer allowed to connect a site",
        detail:
          "Your role in this organization changed while you were on Atlassian. Nothing was connected. Ask an owner or admin to do it.",
      };
    case "error":
      return {
        tone: "error",
        title: "Something went wrong",
        detail: "The connection did not complete. Try again.",
      };
  }
}

/**
 * What a withheld scope costs, in the words of what stops working.
 *
 * The write scope is named apart from the read ones because its remedy is
 * different in kind: a site connected without it still works, read-only,
 * and approvals simply stay here — whereas a missing read scope makes boards
 * read as "not found", which nobody would guess was a permission.
 */
function describeMissingScopes(missingScopes: string[]): string {
  const reads = missingScopes.filter((scope) => scope !== "write:jira-work");
  const writeMissing = reads.length !== missingScopes.length;
  const parts: string[] = [];
  if (reads.length > 0) {
    parts.push(
      `Reading boards needs ${reads.join(" and ")}. These are granular scopes: on the Atlassian console they are under the "Granular scopes" tab rather than the classic list. Without them a board reads as "not found" rather than "not permitted".`,
    );
  }
  if (writeMissing) {
    parts.push(
      "Without write:jira-work approvals stay here rather than posting to the ticket. Connect the site again to grant it.",
    );
  }
  return parts.length === 0
    ? "Boards and sprints may not be readable."
    : parts.join(" ");
}

/**
 * The result of a just-finished OAuth round trip.
 *
 * Exported because the flow can return to either surface: `returnTo` carries
 * the path it started from, so a connection begun on the home screen reports
 * there, and one begun here reports here.
 */
export function OutcomeBanner({
  outcome,
  missingScopes,
  onDismiss,
}: {
  outcome: JiraOutcome;
  missingScopes: string[];
  onDismiss: () => void;
}) {
  const { tone, title, detail } = describeOutcome(outcome, missingScopes);
  /*
    Border and a faint wash of the same colour, matching `ErrorBanner`: the
    border alone was thin enough that the banner read as a stray input rather
    than as the page answering a round trip through Atlassian.
  */
  const skin =
    tone === "ok"
      ? "border-emerald-500/40 bg-emerald-500/7"
      : tone === "warn"
        ? "border-amber-500/40 bg-amber-500/7"
        : "border-destructive/40 bg-destructive/7";
  const Icon =
    tone === "ok" ? CircleCheck : tone === "warn" ? TriangleAlert : CircleX;
  const iconTone =
    tone === "ok"
      ? "text-emerald-600 dark:text-emerald-500"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-500"
        : "text-destructive";

  return (
    /*
      Title over detail, and the detail free to wrap.

      On one line with `truncate` it was clipped even for the shortest of
      these sentences. The worst case is `partial-scopes`, whose detail names
      the two scopes to grant and the tab they hide behind — instructions,
      cut off mid-word, for the one outcome a person has to act on.

      `alert` for a failure, which should interrupt, and `status` for the rest,
      which should wait until the reader is idle. It had neither, so a screen
      reader said nothing at all when the flow came back.
    */
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`flex items-start gap-2.5 rounded-lg border ${skin} px-3 py-2.5 text-sm`}
      data-testid="jira-outcome"
    >
      <Icon
        className={`mt-0.5 size-4 shrink-0 ${iconTone}`}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        <p
          className="text-muted-foreground mt-0.5"
          data-testid="jira-outcome-detail"
        >
          {detail}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="-my-2 -mr-2 size-10 shrink-0 [@media(pointer:coarse)]:size-11"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}

/**
 * One connected site, as a way into it.
 *
 * The whole row is the target rather than a link on the name: there is one
 * destination per row and nothing else to press, so anything less than the
 * full row is a miss the layout invented. The chevron says so — the mark that
 * a row goes somewhere, which a row of plain text does not.
 *
 * The Jira mark rather than Atlassian's, because what is being named is the
 * product whose boards get read. Signing in is the other one.
 *
 * Exported because the home screen lists the same sites, grouped by owner,
 * and listed them as inert text — a row that named a site without being a way
 * into it. One row rather than two that drift apart.
 */
const destinationRowClass =
  "focus-visible:ring-ring/50 flex w-full items-center gap-3.5 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:outline-none";

export function ConnectionRow({
  connection,
  href,
  onOpen,
}: {
  connection: JiraConnection;
  href: string;
  onOpen: (connection: JiraConnection) => void;
}) {
  return (
    <li>
      <a
        href={href}
        className={destinationRowClass}
        onClick={(event) => {
          if (isPlainLeftClick(event)) {
            event.preventDefault();
            onOpen(connection);
          }
        }}
      >
        <span className="size-5 shrink-0">
          <JiraIcon />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate font-medium">{connection.siteName}</span>
            {!connection.healthy && (
              <Badge variant="destructive" className="gap-1">
                <TriangleAlert className="size-3" />
                Reconnect
              </Badge>
            )}
            {connection.healthy && !connection.writeGranted && (
              /*
                A site connected before every consent asked for the write
                scope, or whose admin withheld it. Approvals on its boards
                stay here. Connecting it again is the remedy, and this is
                the page that button is on.
              */
              <Badge variant="outline">Read-only</Badge>
            )}
          </span>
          <span className="block truncate text-sm text-muted-foreground">
            {connection.siteUrl}
          </span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </a>
    </li>
  );
}

/** A Jira read that failed, in the words the person can act on. */
function BoardsError({
  error,
  onReconnect,
  onRetry,
}: {
  error: JiraFetchError;
  onReconnect?: (() => void) | undefined;
  onRetry?: (() => void) | undefined;
}) {
  if (error.kind === "reconnect") {
    return (
      <div className="flex flex-col items-start gap-2">
        <ErrorBanner className="mt-0">
          That site&rsquo;s connection has expired or been revoked.
        </ErrorBanner>
        {onReconnect !== undefined && (
          <Button type="button" size="sm" onClick={onReconnect}>
            <RefreshCw />
            Reconnect
          </Button>
        )}
      </div>
    );
  }
  if (error.kind === "scope") {
    return (
      <ErrorBanner className="mt-0" data-testid="jira-scope-error">
        {error.message}
      </ErrorBanner>
    );
  }
  if (error.kind === "jira") {
    return (
      <ErrorBanner className="mt-0">
        Jira refused that request. If the site was connected without the board
        permissions, reconnect it and grant them.
      </ErrorBanner>
    );
  }
  return (
    <div className="flex flex-col items-start gap-2">
      <ErrorBanner className="mt-0">{error.message}</ErrorBanner>
      {onRetry !== undefined && (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw />
          Try again
        </Button>
      )}
    </div>
  );
}

/**
 * How old a ticket is, which is the whole basis of the selection.
 *
 * A ticket raised today is "Today" rather than "0d". The zero was the one
 * value in this column that read as a missing number instead of an age — the
 * rest of the scale counts upward from it, so nothing else in the list makes
 * "0d" legible as a quantity.
 */
function ageInDays(created: string | null): string {
  if (created === null) {
    return "";
  }
  const days = Math.floor(
    (Date.now() - new Date(created).getTime()) / 86_400_000,
  );
  if (!Number.isFinite(days) || days < 0) {
    return "";
  }
  if (days === 0) {
    return "Today";
  }
  return days < 365
    ? `${days}d`
    : `${Math.floor(days / 365)}y ${Math.floor((days % 365) / 30)}m`;
}

/**
 * A ticket's description, rendered.
 *
 * The text is Markdown already: `adfToText` flattens Atlassian Document
 * Format on the server, keeping headings, lists, task checkboxes, tables and
 * code fences. Rendering it as Markdown is what makes a spec readable — a
 * table of entities is the substance of a ticket like NOX-2, and as raw text
 * it is a wall of pipes.
 *
 * **Raw HTML stays off.** `react-markdown` disallows it by default and no
 * `rehype-raw` is configured here, which matters because this is a third
 * party's text: a ticket must not be able to put markup on this page.
 *
 * Every element is given a class, because the app has no typographic
 * defaults for bare `h2`/`ul`/`table` — Tailwind's preflight strips them, so
 * unstyled Markdown renders as undifferentiated text.
 */
function Markdown({ children }: { children: string }) {
  return (
    <div className="text-sm leading-relaxed" data-testid="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children: c }) => (
            <h4 className="mt-4 mb-2 text-sm font-semibold first:mt-0">{c}</h4>
          ),
          h2: ({ children: c }) => (
            <h4 className="mt-4 mb-2 text-sm font-semibold first:mt-0">{c}</h4>
          ),
          h3: ({ children: c }) => (
            <h5 className="mt-3 mb-1 text-sm font-medium first:mt-0">{c}</h5>
          ),
          p: ({ children: c }) => <p className="my-2">{c}</p>,
          ul: ({ children: c }) => (
            <ul className="my-2 list-disc space-y-1 pl-5">{c}</ul>
          ),
          ol: ({ children: c }) => (
            <ol className="my-2 list-decimal space-y-1 pl-5">{c}</ol>
          ),
          // A task list renders its own checkbox, so the disc would be a
          // second marker for the same item.
          li: ({ children: c, ...rest }) =>
            "checked" in rest && rest.checked !== null ? (
              <li className="list-none">{c}</li>
            ) : (
              <li>{c}</li>
            ),
          input: ({ checked }) => (
            // Disabled, not read-only: the state belongs to Jira, and a box
            // that looks clickable here would be a lie.
            <input
              type="checkbox"
              checked={checked ?? false}
              disabled
              readOnly
              className="mr-2 align-middle"
            />
          ),
          code: ({ className, children: c }) =>
            className?.startsWith("language-") === true ? (
              <code className="block">{c}</code>
            ) : (
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                {c}
              </code>
            ),
          pre: ({ children: c }) => (
            <pre className="my-2 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
              {c}
            </pre>
          ),
          blockquote: ({ children: c }) => (
            <blockquote className="my-2 border-l-2 pl-3 text-muted-foreground">
              {c}
            </blockquote>
          ),
          hr: () => <hr className="my-3" />,
          a: ({ href, children: c }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2"
            >
              {c}
            </a>
          ),
          table: ({ children: c }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-xs">{c}</table>
            </div>
          ),
          th: ({ children: c }) => (
            <th className="border px-2 py-1 text-left font-medium">{c}</th>
          ),
          td: ({ children: c }) => <td className="border px-2 py-1">{c}</td>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

/** A labelled row in the detail view. Renders nothing when Jira sent no value. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  if (children === null || children === undefined || children === "") {
    return null;
  }
  return (
    <div className="flex flex-col gap-0.5 py-1.5 text-sm sm:flex-row sm:gap-3">
      <span className="shrink-0 text-muted-foreground sm:w-32">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

/** Jira's seconds as the hours a person reads. */
function hours(seconds: number | null): string | null {
  if (seconds === null) {
    return null;
  }
  const value = seconds / 3600;
  return `${Number.isInteger(value) ? value : value.toFixed(1)}h`;
}

/** An ISO timestamp as a plain date. Jira sends several shapes; all parse. */
function asDate(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

/**
 * One ticket in full.
 *
 * The description arrives as text already — `adfToText` flattens Atlassian
 * Document Format on the server, keeping headings, lists and checkboxes as
 * Markdown-ish lines. It is rendered pre-wrapped rather than parsed: the
 * structure survives, and a ticket cannot inject markup into this page.
 *
 * Fields Jira did not send render nothing at all, because a site can omit
 * almost any of them and a column of empty labels is worse than a short list.
 */
/**
 * The ticket's shape, while the ticket itself is still being read.
 *
 * The peek opens on the click rather than when the response lands, so the
 * click has an immediate answer — a panel that is on its way to holding
 * something — instead of a spinner on the row and a page that looks
 * unchanged for as long as Jira takes.
 *
 * It mirrors `IssueDetail` block for block: a heading, the badge row under
 * it, the two tabs, and a bordered body of text lines. That is what keeps the
 * swap quiet — the real ticket lands into a layout the same shape, so nothing
 * jumps when it arrives.
 *
 * The lines are deliberately uneven. A stack of identical bars reads as a
 * loading graphic; varied widths read as text that has not arrived, which is
 * what is actually true.
 *
 * `aria-hidden`, with the announcement left to the status line below it: a
 * screen reader should hear "Loading the ticket" once, not a tree of empty
 * boxes.
 */
function IssueDetailSkeleton() {
  return (
    <div className="flex flex-col gap-4" data-testid="issue-skeleton">
      <div aria-hidden="true">
        {/* The heading, at two lines: most summaries on this board wrap. */}
        <div className="skeleton h-5 w-4/5 rounded-md" />
        <div className="skeleton mt-1.5 h-5 w-1/3 rounded-md" />

        {/* Status and type, the row under the heading. */}
        <div className="mt-2.5 flex items-center gap-2">
          <div className="skeleton h-5 w-16 rounded-full" />
          <div className="skeleton h-3 w-12 rounded" />
        </div>
      </div>

      {/* The tab strip and the link out, which share a row and are the same
          size whatever the ticket turns out to say. */}
      <div
        aria-hidden="true"
        className="flex items-center justify-between gap-3"
      >
        <div className="skeleton h-9 w-[13rem] rounded-lg" />
        <div className="skeleton h-8 w-28 rounded-md" />
      </div>

      {/* The spec, in the bordered box the real one gets. The border is real
          rather than a skeleton: it is chrome that does not depend on the
          response, so drawing it straight away is one less thing that moves. */}
      <div
        aria-hidden="true"
        className="flex flex-col gap-2.5 rounded-md border p-4"
      >
        <div className="skeleton h-4 w-24 rounded" />
        <div className="skeleton h-3 w-full rounded" />
        <div className="skeleton h-3 w-11/12 rounded" />
        <div className="skeleton h-3 w-4/5 rounded" />
        <div className="skeleton mt-2 h-3 w-2/3 rounded" />
        <div className="skeleton h-3 w-full rounded" />
        <div className="skeleton h-3 w-3/4 rounded" />
      </div>

      {/* What the skeleton above is silently standing in for. */}
      <p role="status" className="sr-only">
        Loading the ticket…
      </p>
    </div>
  );
}

function IssueDetail({ issue }: { issue: JiraIssueDetail }) {
  return (
    <div className="flex flex-col gap-4" data-testid="issue-detail">
      <div>
        <h3 className="text-base font-semibold">{issue.summary}</h3>
        {/*
          Status and type on one line under the heading, anchored to opposite
          edges so they scan as separate facts: current workflow state on the
          left, issue type on the right.
          The link out used to sit here too, which put a control in a row that
          is otherwise a statement of fact.
        */}
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
          <Badge variant="secondary">{issue.status}</Badge>
          <span className="text-muted-foreground text-xs">
            {issue.issueType}
          </span>
        </div>
      </div>

      {/*
        The tab strip and the way out to Jira share a row: both are controls
        on this ticket, and the right edge is where this app puts the action a
        surface offers. `justify-between` rather than a margin, so the link
        stays pinned as the strip's own width changes.
      */}
      <Tabs defaultValue="spec">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="spec">Spec</TabsTrigger>
            <TabsTrigger value="fields">Fields</TabsTrigger>
          </TabsList>

          {issue.url !== null && (
            /*
              A button rather than a bare link, so it reads as the peer of the
              tabs beside it, and carrying Jira's own mark — the destination
              is Jira, and the mark says so faster than the words do. The
              arrow stays as well: the mark names where it goes, the arrow
              says it leaves this page.
            */
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 gap-1.5"
              asChild
            >
              <a href={issue.url} target="_blank" rel="noreferrer noopener">
                <span className="size-3.5 shrink-0">
                  <JiraIcon />
                </span>
                Open in Jira
                <ExternalLink className="size-3" />
              </a>
            </Button>
          )}
        </div>

        <TabsContent value="spec">
          {issue.descriptionText === "" ? (
            <p className="py-6 text-sm text-muted-foreground">
              This ticket has no description. That is itself worth knowing — a
              ticket with no spec is one a bounty cannot safely be priced
              against.
            </p>
          ) : (
            /*
              No scroll box of its own. The panel around this one is what
              scrolls now, and a 26rem window inside it gave the reader two
              scrollbars for one document — the outer one moving the ticket,
              the inner one moving the spec within it.
            */
            <div className="rounded-md border p-4" data-testid="issue-spec">
              <Markdown>{issue.descriptionText}</Markdown>
            </div>
          )}
        </TabsContent>

        <TabsContent value="fields">
          <div
            className="divide-y rounded-md border px-3"
            data-testid="issue-fields"
          >
            <Field label="Assignee">{issue.assignee ?? "Unassigned"}</Field>
            <Field label="Reporter">{issue.reporter}</Field>
            <Field label="Creator">
              {issue.creator === issue.reporter ? null : issue.creator}
            </Field>
            <Field label="Priority">{issue.priority}</Field>
            <Field label="Resolution">{issue.resolution}</Field>
            <Field label="Resolved">{asDate(issue.resolutionDate)}</Field>
            <Field label="Created">{asDate(issue.created)}</Field>
            <Field label="Updated">{asDate(issue.updated)}</Field>
            <Field label="Due">{asDate(issue.dueDate)}</Field>
            <Field label="Project">{issue.projectKey}</Field>
            <Field label="Parent">{issue.parentKey}</Field>
            <Field label="Components">
              {issue.components.length === 0
                ? null
                : issue.components.join(", ")}
            </Field>
            <Field label="Fix versions">
              {issue.fixVersions.length === 0
                ? null
                : issue.fixVersions.join(", ")}
            </Field>
            <Field label="Estimate">
              {hours(issue.originalEstimateSeconds)}
            </Field>
            <Field label="Remaining">
              {hours(issue.remainingEstimateSeconds)}
            </Field>
            <Field label="Environment">{issue.environment}</Field>
            <Field label="Votes">
              {issue.votes === null || issue.votes === 0 ? null : issue.votes}
            </Field>
            <Field label="Watchers">
              {issue.watchers === null || issue.watchers === 0
                ? null
                : issue.watchers}
            </Field>
            <Field label="Labels">
              {issue.labels.length === 0 ? null : (
                <span className="flex flex-wrap gap-1">
                  {issue.labels.map((label) => (
                    <Badge
                      key={label}
                      variant="outline"
                      className="font-normal"
                    >
                      {label}
                    </Badge>
                  ))}
                </span>
              )}
            </Field>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * The ticket list: what a run would price, oldest first.
 *
 * A column beside the detail rather than a view that gets replaced by it, so
 * reading one ticket does not cost the place in the list — which is the whole
 * point of the split. The selected row is marked, because in a list of
 * similar summaries the only way to know which one the panel is showing is to
 * see it.
 */
function PreviewList({
  preview,
  onOpenIssue,
  openingKey,
  selectedKey,
}: {
  preview: BacklogPreview;
  onOpenIssue: (issueKey: string) => void;
  openingKey: string | null;
  selectedKey: string | null;
}) {
  if (preview.issues.length === 0) {
    return (
      <p className="text-muted-foreground px-4 py-8 text-sm">
        No tickets matched this board&rsquo;s current selection rules.
      </p>
    );
  }

  return (
    <ul className="divide-y" data-testid="backlog-preview">
      {preview.issues.map((issue) => (
        <li key={issue.id}>
          {/* The whole row opens the ticket: a link-sized target is a
              needless miss, and there is nothing else to click. */}
          {/*
            Marked from the click, not from the response: the row the peek is
            about is the one that was pressed, whether or not Jira has
            answered yet. `openingKey` and `selectedKey` are the same ticket
            at two moments of the same open.
          */}
          <button
            type="button"
            aria-current={
              selectedKey === issue.key || openingKey === issue.key
                ? "true"
                : undefined
            }
            className={`hover:bg-muted/50 grid w-full grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 px-3 py-3 text-left transition-colors sm:flex sm:py-2.5 ${
              selectedKey === issue.key || openingKey === issue.key
                ? "bg-muted"
                : ""
            }`}
            onClick={() => {
              onOpenIssue(issue.key);
            }}
          >
            <span className="text-muted-foreground shrink-0 font-mono text-xs sm:w-20">
              {issue.key}
            </span>
            <span className="min-w-0 text-sm sm:flex-1 sm:truncate">
              {issue.summary}
            </span>
            <span className="text-muted-foreground col-start-1 row-start-2 shrink-0 text-xs sm:order-none sm:col-auto sm:row-auto">
              {ageInDays(issue.created)}
            </span>
            {/*
              The chevron stays put while the ticket loads. A spinner here was
              the only answer a click had before the peek opened on it; now
              the panel is the answer, and swapping the mark would be a second
              thing moving for the same event.
            */}
            <ChevronRight className="text-muted-foreground col-start-3 row-span-2 row-start-1 size-4 shrink-0 sm:order-none sm:col-auto sm:row-auto" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The rules behind a preview, so the list never looks like the whole backlog. */
function SelectionSummary({ preview }: { preview: BacklogPreview }) {
  const selection = preview.selection;
  const shown = preview.issues.length;
  const rules =
    selection === undefined
      ? []
      : [
          selection.excludeAssigned ? "Unassigned only" : null,
          selection.minAgeDays > 0 ? `${selection.minAgeDays}+ days old` : null,
          selection.maxAgeDays === undefined
            ? null
            : `Up to ${selection.maxAgeDays} days old`,
          selection.issueTypes.length > 0
            ? `Types: ${selection.issueTypes.join(", ")}`
            : null,
          selection.minSpecChars > 0
            ? `${selection.minSpecChars}+ spec characters`
            : null,
        ].filter((rule): rule is string => rule !== null);

  return (
    <div className="flex flex-col gap-1 border-b bg-muted/25 px-3 py-2.5 text-xs sm:flex-row sm:items-center sm:justify-between">
      <p className="font-medium">
        Showing {shown} oldest ticket{shown === 1 ? "" : "s"}
      </p>
      <div
        aria-label="Active filters"
        className="flex flex-wrap items-center gap-1.5"
      >
        <span className="text-muted-foreground font-medium">Filters</span>
        {selection === undefined ? (
          <span className="text-muted-foreground">Unavailable</span>
        ) : rules.length === 0 ? (
          <span className="text-muted-foreground">None</span>
        ) : (
          rules.map((rule) => (
            <Badge
              key={rule}
              variant="outline"
              className="bg-background/50 font-normal"
            >
              {rule}
            </Badge>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * The mark for a board, by the kind of board it is.
 *
 * Jira reports `scrum`, `kanban`, or nothing — `unknown` is ours, for a site
 * that did not say. Three columns for a Kanban board and a sprint's repeat
 * for a Scrum one, because that is the difference a person is scanning for:
 * a Kanban board has no backlog of its own, which is why the preview reads it
 * through a different endpoint.
 *
 * Compared lowercased: the type is Jira's string, and a site is free to send
 * `Kanban`.
 */
function BoardIcon({ boardType }: { boardType: string }) {
  const kind = boardType.toLowerCase();
  if (kind === "kanban") {
    return <Columns3 className="size-5" />;
  }
  if (kind === "scrum") {
    return <RefreshCw className="size-5" />;
  }
  // Not a guess at one of the two: a board whose type we do not know should
  // not be drawn as though we did.
  return <LayoutGrid className="size-5" />;
}

/**
 * One registered board, as a way into its tickets.
 *
 * The same row as a connected site one level up, for the same reason: there
 * is one destination and nothing else to press, so the whole row is the
 * target and the chevron says it leads somewhere. It replaced a "Preview"
 * button, which named the mechanism rather than the destination.
 */
function BoardRow({
  board,
  href,
  onOpen,
}: {
  board: JiraBoard;
  href: string;
  onOpen: (board: JiraBoard) => void;
}) {
  return (
    <li>
      <a
        href={href}
        className={destinationRowClass}
        onClick={(event) => {
          if (isPlainLeftClick(event)) {
            event.preventDefault();
            onOpen(board);
          }
        }}
      >
        <span className="text-muted-foreground shrink-0">
          <BoardIcon boardType={board.boardType} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{board.name}</span>
          <span className="text-muted-foreground block truncate text-sm">
            {board.boardType}
            {board.projectKey === null ? "" : ` · ${board.projectKey}`}
          </span>
        </span>
        <ChevronRight className="text-muted-foreground size-4 shrink-0" />
      </a>
    </li>
  );
}

/**
 * One site's boards, and the tickets behind them.
 *
 * Every board on a connected site is already registered — connecting is the
 * decision, and a board row is a pointer that reads nothing until somebody
 * previews it. So this card never offers to add one. What it does instead is
 * re-read the site when it opens, which is what picks up a board created in
 * Jira since the site was connected.
 *
 * Scoped to one connection: the page it sits on is about one site, and
 * showing every organization's boards here would undo that.
 */
function BoardsCard({
  organizationId,
  organizationSlug,
  connection,
  onOpenBoard,
}: {
  organizationId: string;
  organizationSlug: string;
  connection: JiraConnection;
  onOpenBoard: (board: JiraBoard) => void;
}) {
  const { boards, loading, error, sync } = useJiraBoards(organizationId);
  const [syncing, setSyncing] = useState(true);

  /*
    Re-read on open, rather than on a timer or a button.

    A client creates boards in Jira and nothing tells us, so the registered
    list goes stale. Refreshing it here spends one round trip exactly when
    somebody is looking at the list, which is the only moment the staleness
    matters. A dead connection is left alone: the sync would fail, and the
    reconnect notice is already on screen.
  */
  useEffect(() => {
    if (!connection.healthy) {
      setSyncing(false);
      return;
    }
    let live = true;
    void sync(connection.id).finally(() => {
      if (live) {
        setSyncing(false);
      }
    });
    return () => {
      live = false;
    };
  }, [connection.healthy, connection.id, sync]);

  // This site's boards. The hook holds the organization's, because that is
  // what the API answers with, and the page is about one site.
  const siteBoards = boards.filter(
    (board) => board.connectionId === connection.id,
  );
  const busy = loading || syncing;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Boards</CardTitle>
        <CardDescription>
          Every board on this site, read when it was connected and again just
          now. Open one to see the tickets a run would price — read live from
          Jira, and stored nowhere.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error !== null && <BoardsError error={error} />}

        {busy && siteBoards.length === 0 ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" />
            Reading this site&rsquo;s boards…
          </p>
        ) : siteBoards.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No boards on this site are visible to the connected account.
          </p>
        ) : (
          <ul className="divide-y">
            {siteBoards.map((board) => (
              <BoardRow
                key={board.id}
                board={board}
                href={pathForScreen(
                  "org-jira-board",
                  organizationSlug,
                  connection.id,
                  board.id,
                )}
                onOpen={onOpenBoard}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * One board: its tickets on the left, the one you picked on the right.
 *
 * A split rather than a dialog with two views. The dialog made reading a
 * ticket cost the list — going back was the only way to reach the next one,
 * and comparing two meant opening each in turn from memory. Here the list
 * stays put and the panel changes under it, which is what a person scanning
 * a backlog is actually doing.
 *
 * Below `md` the panel covers the list instead of sitting beside it, with a
 * control back. Two columns on a phone would each be too narrow to hold a
 * ticket summary, let alone a spec.
 */
export function JiraBoard({
  organizationId,
  connectionId,
  boardId,
  boardName,
  onBoardName,
  onSiteName,
  role,
}: {
  organizationId: string;
  /** The site this board is on, so the trail can name it. */
  connectionId: string;
  boardId: string;
  /** Known already when arriving from the site page; absent on a reload. */
  boardName?: string | undefined;
  /** Reports the board's name up for the trail; see `JiraSite`. */
  onBoardName: (name: string | undefined) => void;
  /**
   * And the site's, for the crumb above it.
   *
   * Reported from here rather than left to `JiraSite`, which is not mounted
   * on this page: arriving by URL, nothing else has ever read the connection
   * list, so the crumb would read "Site" until the person navigated up.
   */
  onSiteName: (name: string | undefined) => void;
  role?: string | undefined;
}) {
  const { boards, error, preview, issue } = useJiraBoards(organizationId);
  const { connections, connect } = useJira(organizationId);
  const { outcome, missingScopes, dismiss } = useJiraOutcome();
  const [backlog, setBacklog] = useState<BacklogPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<JiraIssueDetail | null>(null);
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const [issueError, setIssueError] = useState<string | null>(null);
  /**
   * The ticket the reader last asked for, read when a response resolves so a
   * superseded one can be dropped. A ref rather than state: the check happens
   * inside a closure that captured the old state, and this must be current.
   * Cleared on close, so a response arriving after that does not reopen it.
   */
  const wantedKey = useRef<string | null>(null);

  const board = boards.find((candidate) => candidate.id === boardId) ?? null;
  // The name passed in wins while the list is still arriving, so arriving
  // from the site page does not flash a heading that says nothing.
  const name = board?.name ?? boardName;

  useEffect(() => {
    onBoardName(name);
  }, [name, onBoardName]);

  const siteName = connections.find(
    (candidate) => candidate.id === connectionId,
  )?.siteName;
  useEffect(() => {
    onSiteName(siteName);
  }, [siteName, onSiteName]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    void preview(boardId).then((result) => {
      if (live) {
        setBacklog(result);
        setLoading(false);
      }
    });
    return () => {
      live = false;
    };
  }, [boardId, preview]);

  /*
    The peek opens on the click, not on the response.

    Waiting for Jira before opening anything left the click with no visible
    answer but a small spinner in the row — on a slow read the page looked
    unchanged, and the natural response is to click again. Opening
    immediately turns the wait into something with a shape: the panel is
    there, and what it will hold is sketched inside it.

    `openingKey` is what holds it open until the detail arrives, which is why
    it also drives the skeleton. A read that fails clears it and the panel
    closes again — the error belongs on the page, not inside a panel about
    one ticket.
  */
  const onOpenIssue = useCallback(
    (issueKey: string) => {
      const params = new URLSearchParams(window.location.search);
      if (params.get("issue") !== issueKey) {
        params.set("issue", issueKey);
        window.history.pushState(
          null,
          "",
          `${window.location.pathname}?${params.toString()}`,
        );
      }
      setOpeningKey(issueKey);
      setIssueError(null);
      // The previous ticket goes now rather than when the next one lands, or
      // the panel shows the last ticket while a different row is marked.
      setSelected(null);
      /*
        Which ticket the panel is for. Clicking a second row while the first
        is still in flight must not let the slower response land on top of
        the faster one, and neither `openingKey` nor `selected` can be read
        inside this closure to tell — both are stale by then. A ref is read at
        resolve time, so the check is against what the reader last asked for.
      */
      wantedKey.current = issueKey;
      void issue(boardId, issueKey).then((detail) => {
        if (wantedKey.current !== issueKey) {
          return;
        }
        if (detail !== null) {
          setOpeningKey(null);
          setSelected(detail);
        } else {
          setIssueError("Could not load this ticket from Jira.");
        }
      });
    },
    [boardId, issue],
  );

  const closeIssue = useCallback((updateUrl: boolean) => {
    setSelected(null);
    setOpeningKey(null);
    setIssueError(null);
    wantedKey.current = null;
    if (updateUrl) {
      const params = new URLSearchParams(window.location.search);
      if (params.has("issue")) {
        params.delete("issue");
        const query = params.toString();
        window.history.pushState(
          null,
          "",
          window.location.pathname + (query === "" ? "" : `?${query}`),
        );
      }
    }
  }, []);

  useEffect(() => {
    const issueKey = new URLSearchParams(window.location.search).get("issue");
    if (issueKey !== null && issueKey !== "") {
      onOpenIssue(issueKey);
    }
    const syncIssue = () => {
      const next = new URLSearchParams(window.location.search).get("issue");
      if (next === null || next === "") {
        closeIssue(false);
      } else {
        onOpenIssue(next);
      }
    };
    window.addEventListener("popstate", syncIssue);
    return () => window.removeEventListener("popstate", syncIssue);
  }, [closeIssue, onOpenIssue]);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10 sm:px-6 sm:py-14">
      <header>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground shrink-0">
            <BoardIcon boardType={board?.boardType ?? ""} />
          </span>
          <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight">
            {name ?? "Board"}
          </h1>
        </div>
        <p className="text-muted-foreground mt-1.5 text-sm">
          The tickets a run would price, oldest first. Read live from Jira —
          nothing here has been priced, and nothing was stored.
        </p>
      </header>

      {outcome !== null && (
        <OutcomeBanner
          outcome={outcome}
          missingScopes={missingScopes}
          onDismiss={dismiss}
        />
      )}

      {error !== null && (
        <BoardsError
          error={error}
          onReconnect={canManage(role ?? "") ? () => connect() : undefined}
          onRetry={() => void preview(boardId).then(setBacklog)}
        />
      )}

      <Tabs
        defaultValue={
          new URLSearchParams(window.location.search).get("tab") === "proposals"
            ? "proposals"
            : "backlog"
        }
        onValueChange={(tab) => {
          const params = new URLSearchParams(window.location.search);
          if (tab === "proposals") params.set("tab", tab);
          else params.delete("tab");
          const query = params.toString();
          window.history.pushState(
            null,
            "",
            window.location.pathname + (query === "" ? "" : `?${query}`),
          );
        }}
      >
        <TabsList>
          <TabsTrigger value="backlog">Backlog</TabsTrigger>
          <TabsTrigger value="proposals">Proposals</TabsTrigger>
        </TabsList>
        <TabsContent value="backlog">
          {loading ? (
            <LoadingLine>Reading the backlog from Jira…</LoadingLine>
          ) : backlog === null ? null : (
            /*
          The list at full width, with the ticket opening over it rather than
          beside it. See `PeekPanel` for why: half a column was not enough for
          a spec with a table in it, and the other half was thirty rows of
          truncated summaries nobody reads while reading a ticket.
        */
            <div className="overflow-hidden rounded-md border">
              <SelectionSummary preview={backlog} />
              <PreviewList
                preview={backlog}
                onOpenIssue={onOpenIssue}
                openingKey={openingKey}
                selectedKey={selected?.key ?? null}
              />
            </div>
          )}
        </TabsContent>
        <TabsContent value="proposals">
          <BoardBounties
            organizationId={organizationId}
            boardId={boardId}
            role={role ?? "member"}
            writeGranted={
              connections.find((candidate) => candidate.id === connectionId)
                ?.writeGranted ?? false
            }
          />
        </TabsContent>
      </Tabs>

      {/*
        Mounted whether or not a ticket is open, so Radix can animate it out
        on close: unmounting on `selected === null` would make it vanish.
        `selected` is held until the close finishes for the same reason — the
        panel would otherwise empty itself mid-flight.
      */}
      <PeekPanel
        // Open from the click, through the read, until it is closed: the
        // panel is what answers the click, and the ticket arrives into it.
        open={selected !== null || openingKey !== null}
        onOpenChange={(next: boolean) => {
          if (!next) {
            closeIssue(true);
          }
        }}
        title={selected?.key ?? openingKey ?? "Ticket"}
        description={
          selected?.summary ??
          "Read live from Jira. Nothing here has been priced."
        }
        data-testid="issue-panel"
      >
        {selected === null && issueError !== null ? (
          <div className="flex min-h-48 flex-col items-start justify-center gap-3">
            <ErrorBanner className="mt-0">{issueError}</ErrorBanner>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                if (openingKey !== null) {
                  onOpenIssue(openingKey);
                }
              }}
            >
              <RefreshCw />
              Try again
            </Button>
          </div>
        ) : selected === null ? (
          <IssueDetailSkeleton />
        ) : (
          <IssueDetail issue={selected} />
        )}
      </PeekPanel>
    </main>
  );
}

/**
 * The connected sites.
 *
 * Each row is a link into the site rather than a row with controls on it.
 * What there is to do with a site — read its boards, preview a backlog,
 * disconnect it — belongs to that one site, and a list that carried all of it
 * inline grew a column of buttons whose target was ambiguous the moment there
 * was more than one row.
 */
export function Jira({
  organizationId,
  organizationSlug,
  organizationName,
  role,
  onOpenSite,
}: {
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  role: string;
  onOpenSite: (connection: JiraConnection) => void;
}) {
  const { connections, loading, error, connect } = useJira(organizationId);
  const { outcome, missingScopes, dismiss } = useJiraOutcome();
  const manageable = canManage(role);

  return (
    /*
      `main`, and the same column and padding as every other page: `px-4 py-10
      sm:px-6 sm:py-14`. The breadcrumb above pulls its bottom margin back by
      `-mb-6 sm:-mb-8` so the trail and the page heading read as one header
      block — which only works if the page's own top padding is larger than
      the pull. This page used `p-6`, 24px against a 32px pull, so at `sm` the
      heading rode up into the trail and overlapped it.
    */
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-10 sm:px-6 sm:py-14">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Jira</h1>
        <p className="text-muted-foreground mt-1.5 text-sm">
          Sites {organizationName} can read boards from.
        </p>
      </header>

      {outcome !== null && (
        <OutcomeBanner
          outcome={outcome}
          missingScopes={missingScopes}
          onDismiss={dismiss}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Connected sites</CardTitle>
          <CardDescription>
            Connecting lets us read the boards, backlogs and ticket text on a
            site. Every board on it is registered at once — we never store
            ticket contents, which are read when a run needs them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <LoadingLine />
          ) : error !== null ? (
            <ErrorBanner className="mt-0">{error}</ErrorBanner>
          ) : connections.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No sites connected yet.
            </p>
          ) : (
            <ul className="divide-y">
              {connections.map((connection) => (
                <ConnectionRow
                  key={connection.id}
                  connection={connection}
                  href={pathForScreen(
                    "org-jira-site",
                    organizationSlug,
                    connection.id,
                  )}
                  onOpen={onOpenSite}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/*
        Outside the card, and to the right.

        The card is the list of what is connected; connecting another is an
        action on that list rather than a row in it, and inside the card it
        sat under the last site as though it were one more. Trailing the card
        on the right is where this app puts the action a page is for, which
        is also the corner the eye finishes a list in.
      */}
      {manageable ? (
        <div className="flex justify-end">
          <Button className="gap-2" onClick={() => connect()}>
            <Link2 className="size-4" />
            {connections.length === 0
              ? "Connect a Jira site"
              : "Connect another site"}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Only an owner or admin can connect a site.
        </p>
      )}
    </main>
  );
}

/**
 * One connected site: its boards, and the control that disconnects it.
 *
 * Disconnecting lives here rather than on the list for the same reason the
 * boards do. It is the most consequential thing there is to do with a site —
 * it takes the boards and the grant with it — and a row of bins beside a list
 * of similar names is how the wrong one gets pressed.
 *
 * The site is found in the organization's connection list rather than fetched
 * by id: the list is one request the app already makes, it is what the page
 * before this one was showing, and an endpoint for a single site would exist
 * only to save a lookup over a handful of rows. A URL naming a site that is
 * not in it — a stale bookmark, a site somebody else disconnected — is a
 * miss, which is the same answer the API would give.
 */
export function JiraSite({
  organizationId,
  organizationSlug,
  connectionId,
  role,
  onDisconnected,
  onOpenBoard,
  onSiteName,
}: {
  organizationId: string;
  organizationSlug: string;
  connectionId: string;
  role: string;
  onDisconnected: () => void;
  onOpenBoard: (board: JiraBoard) => void;
  /**
   * Reports the site's name up to the shell, which renders the trail above
   * this page and has no other way to learn it. Called with undefined while
   * the list is still arriving, so the crumb falls back rather than keeping
   * the previous site's name.
   */
  onSiteName: (name: string | undefined) => void;
}) {
  const { connections, loading, error, connect, disconnect, refresh } =
    useJira(organizationId);
  const { outcome, missingScopes, dismiss } = useJiraOutcome();
  const [disconnecting, setDisconnecting] = useState(false);
  const manageable = canManage(role);

  const connection =
    connections.find((candidate) => candidate.id === connectionId) ?? null;

  // In an effect rather than during render: this sets state in the parent,
  // and doing that while rendering a child is the React warning about
  // updating a component from inside another one.
  useEffect(() => {
    onSiteName(connection?.siteName);
  }, [connection?.siteName, onSiteName]);

  if (connection === null) {
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
        {loading ? (
          <LoadingLine />
        ) : error !== null ? (
          <div className="flex flex-col items-start gap-3">
            <ErrorBanner className="mt-0">{error}</ErrorBanner>
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
        ) : (
          <p className="text-muted-foreground text-sm">
            That site is not connected.
          </p>
        )}
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-10 sm:px-6 sm:py-14">
      <header>
        <div className="flex items-center gap-3">
          <span className="size-6 shrink-0">
            <JiraIcon />
          </span>
          <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight">
            {connection.siteName}
          </h1>
          {!connection.healthy && (
            <Badge variant="destructive" className="gap-1">
              <TriangleAlert className="size-3" />
              Connection expired
            </Badge>
          )}
        </div>
        <a
          href={connection.siteUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-muted-foreground mt-1.5 inline-flex items-center gap-1 text-sm hover:underline"
        >
          {connection.siteUrl}
          <ExternalLink className="size-3" />
        </a>
      </header>

      {outcome !== null && (
        <OutcomeBanner
          outcome={outcome}
          missingScopes={missingScopes}
          onDismiss={dismiss}
        />
      )}

      {!connection.healthy &&
        (manageable ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
            <p className="text-sm">
              Reconnect this site to read its boards again.
            </p>
            <Button type="button" size="sm" onClick={() => connect()}>
              <RefreshCw />
              Reconnect
            </Button>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            Ask an owner or admin to reconnect this site.
          </p>
        ))}

      <BoardsCard
        organizationId={organizationId}
        organizationSlug={organizationSlug}
        connection={connection}
        onOpenBoard={onOpenBoard}
        key={connection.id}
      />

      {manageable && (
        <Card>
          <CardHeader>
            <CardTitle>Disconnect this site</CardTitle>
            <CardDescription>
              Removes our access, boards, and local proposal history. Comments
              already posted to Jira remain there. Atlassian keeps its grant
              until you revoke it in your account settings.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/*
              Behind a question, because this is the most consequential thing
              there is to do with a site: it takes the boards and the grant
              with it, and the row it was reached from sits in a list of
              near-identical names.
            */}
            <ConfirmDialog
              trigger={
                <Button
                  variant="destructive"
                  className="gap-2"
                  disabled={disconnecting}
                >
                  {disconnecting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                  Disconnect {connection.siteName}
                </Button>
              }
              title={`Disconnect ${connection.siteName}?`}
              description="Removes our access, every registered board, and local proposal history. Comments already posted to Jira remain. Atlassian keeps its own grant until you revoke it in your account settings."
              confirmLabel="Disconnect"
              busy={disconnecting}
              onConfirm={async () => {
                setDisconnecting(true);
                try {
                  const result = await disconnect(connection.id);
                  if (!result.ok) {
                    return result.error;
                  }
                  onDisconnected();
                  return;
                } finally {
                  setDisconnecting(false);
                }
              }}
            />
          </CardContent>
        </Card>
      )}
    </main>
  );
}
