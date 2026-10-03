/**
 * A ticket's text as the platform holds it: its type, labels and
 * description. What the proposal peek's Spec tab shows for a ticket with no
 * Jira issue to read live, and what the ticket's own page shows.
 *
 * The description is rendered as Markdown with the same component the Jira
 * spec uses, which renders no raw HTML: a ticket is text a person typed,
 * and must not be able to put markup on the page.
 */

import { Badge } from "@/components/ui/badge";

import { Field, Markdown } from "./IssueSpec";

export function TicketText({
  issueType,
  priority,
  labels,
  description,
  inputTruncated = false,
}: {
  issueType: string;
  priority?: string | null | undefined;
  labels?: readonly string[] | undefined;
  description: string;
  inputTruncated?: boolean | undefined;
}) {
  return (
    <div className="flex flex-col gap-4" data-testid="ticket-text">
      <div className="rounded-md border px-3 py-1">
        <Field label="Type">{issueType}</Field>
        <Field label="Priority">{priority ?? null}</Field>
        <Field label="Labels">
          {labels === undefined || labels.length === 0 ? null : (
            <span className="flex flex-wrap gap-1">
              {labels.map((label) => (
                <Badge key={label} variant="outline">
                  {label}
                </Badge>
              ))}
            </span>
          )}
        </Field>
      </div>
      {description.trim() === "" ? (
        <p className="text-muted-foreground py-6 text-sm">
          This ticket has no description. A ticket with no spec is one a bounty
          cannot safely be priced against.
        </p>
      ) : (
        <div className="rounded-md border p-4">
          <Markdown>{description}</Markdown>
        </div>
      )}
      {inputTruncated && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Jira&rsquo;s description was longer than a ticket keeps; the end of it
          is not shown, and the ticket cannot be priced until it is shortened.
        </p>
      )}
    </div>
  );
}
