/**
 * A Jira ticket as a spec: its fields, then its description, in one scroll.
 *
 * This is what a reviewer reads before pricing a bounty, and it is the same
 * whether the ticket is being previewed or already has a proposal against it.
 * It used to be two tabs inside the backlog peek; one scroll reads better,
 * because the fields are what qualify the description — a due date or a
 * parent changes what "add an export" means — and a tab hid them. They come
 * first for the same reason: the reader knows the frame before the text.
 */

import { ChevronDown, ChevronUp } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";

import type { JiraIssueDetail } from "./useJira";

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
export function Markdown({ children }: { children: string }) {
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

/**
 * A labelled row in a property list. Renders nothing when there is no value,
 * so a record with sparse fields reads as a short list rather than a column
 * of empty labels.
 */
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
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

function hours(seconds: number | null): string | null {
  if (seconds === null) {
    return null;
  }
  const value = seconds / 3600;
  return `${Number.isInteger(value) ? value : value.toFixed(1)}h`;
}

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
 * How far a date is from today, in words: "in 3 days", "2 weeks ago",
 * "today". Whole calendar days, so a due date of today is "today" all day
 * rather than "in 5 hours"; the unit grows with the distance so a date next
 * year is not "in 412 days". `null` for a value that is not a date.
 */
export function fromToday(
  value: string | null,
  now = new Date(),
): string | null {
  if (value === null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const startOf = (d: Date) =>
    Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((startOf(date) - startOf(now)) / 86_400_000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const magnitude = Math.abs(days);
  if (magnitude < 7) return format.format(days, "day");
  if (magnitude < 30) return format.format(Math.trunc(days / 7), "week");
  if (magnitude < 365) return format.format(Math.trunc(days / 30), "month");
  return format.format(Math.trunc(days / 365), "year");
}

/** A date with its distance from today beside it, the distance muted. */
function DatedField({
  label,
  value,
  overdue = false,
}: {
  label: string;
  value: string | null;
  overdue?: boolean;
}) {
  const date = asDate(value);
  const distance = fromToday(value);
  if (date === null) return null;
  return (
    <Field label={label}>
      <span className="flex flex-wrap items-baseline gap-x-1.5">
        <span>{date}</span>
        {distance !== null && (
          <span
            className={
              overdue
                ? "text-xs text-amber-700 dark:text-amber-400"
                : "text-muted-foreground text-xs"
            }
          >
            · {distance}
          </span>
        )}
      </span>
    </Field>
  );
}

/** Whether a due date has passed, by calendar day. */
function isOverdue(value: string | null): boolean {
  if (value === null) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const today = new Date();
  return (
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) <
    Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  );
}

/**
 * The fields, then the description.
 *
 * Folded, the fields are two: the status, and whichever of the due date,
 * the priority or the created date the ticket has, in that order — the one
 * thing most likely to change what the description means. Dates carry
 * their distance from today, since "Dec 19" says less than "in 3 months".
 *
 * No scroll box of its own: the panel around this is what scrolls, and a
 * window inside it gave the reader two scrollbars for one document.
 */
export function IssueSpec({ issue }: { issue: JiraIssueDetail }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex flex-col gap-4" data-testid="issue-detail">
      {/*
        Two rows by default: Jira's own state, and the one date or priority
        that most changes what the description means. The rest unfolds on
        request, so the spec is read against its frame without the frame
        taking the page.
      */}
      <div
        className="divide-y rounded-md border px-3"
        data-testid="issue-fields"
      >
        <Field label="Status">
          <Badge variant="secondary">{issue.status}</Badge>
        </Field>
        {expanded ? (
          <>
            <Field label="Type">{issue.issueType}</Field>
            <Field label="Assignee">{issue.assignee ?? "Unassigned"}</Field>
            <Field label="Reporter">{issue.reporter}</Field>
            <Field label="Creator">
              {issue.creator === issue.reporter ? null : issue.creator}
            </Field>
            <Field label="Priority">{issue.priority}</Field>
            <Field label="Resolution">{issue.resolution}</Field>
            <DatedField label="Resolved" value={issue.resolutionDate} />
            <DatedField label="Created" value={issue.created} />
            <DatedField label="Updated" value={issue.updated} />
            <DatedField
              label="Due"
              value={issue.dueDate}
              overdue={isOverdue(issue.dueDate)}
            />
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
          </>
        ) : asDate(issue.dueDate) !== null ? (
          <DatedField
            label="Due"
            value={issue.dueDate}
            overdue={isOverdue(issue.dueDate)}
          />
        ) : issue.priority !== null && issue.priority !== "" ? (
          <Field label="Priority">{issue.priority}</Field>
        ) : (
          <DatedField label="Created" value={issue.created} />
        )}
        <div className="flex justify-end py-1.5">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex cursor-pointer items-center gap-1 rounded-sm text-xs underline-offset-2 transition-colors hover:underline focus-visible:ring-[3px] focus-visible:outline-none"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? (
              <>
                <ChevronUp className="size-3.5" />
                Show less
              </>
            ) : (
              <>
                <ChevronDown className="size-3.5" />
                Show all
              </>
            )}
          </button>
        </div>
      </div>

      {issue.descriptionText === "" ? (
        <p className="py-6 text-sm text-muted-foreground">
          This ticket has no description. That is itself worth knowing — a
          ticket with no spec is one a bounty cannot safely be priced against.
        </p>
      ) : (
        <div className="rounded-md border p-4" data-testid="issue-spec">
          <Markdown>{issue.descriptionText}</Markdown>
        </div>
      )}
    </div>
  );
}

/**
 * The spec's shape while Jira is still answering.
 *
 * It mirrors `IssueSpec` block for block — the fields, then the bordered
 * description — so the real ticket lands into a layout the same shape and
 * nothing jumps when it arrives. The lines are deliberately uneven: a stack
 * of identical bars reads as a loading graphic; varied widths read as text
 * that has not arrived, which is what is actually true.
 *
 * `aria-hidden`, with the announcement left to the status line below it: a
 * screen reader should hear "Loading the ticket" once, not a tree of empty
 * boxes.
 */
export function IssueSpecSkeleton() {
  return (
    <div className="flex flex-col gap-4" data-testid="issue-skeleton">
      <div
        aria-hidden="true"
        className="flex flex-col gap-2.5 rounded-md border px-3 py-2.5"
      >
        <div className="skeleton h-3 w-1/2 rounded" />
        <div className="skeleton h-3 w-2/5 rounded" />
        <div className="skeleton h-3 w-16 rounded" />
      </div>
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
      <p role="status" className="sr-only">
        Loading the ticket…
      </p>
    </div>
  );
}
