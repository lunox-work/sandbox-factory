/**
 * A bounty's text as the platform holds it: its description. What the
 * proposal peek's Spec tab shows for a bounty with no Jira issue to read
 * live, and what the bounty's own page shows.
 *
 * The description is rendered as Markdown with the same component the Jira
 * spec uses, which renders no raw HTML: a bounty is text a person typed,
 * and must not be able to put markup on the page.
 */

import { Markdown } from "./IssueSpec";

export function BountyText({
  description,
  inputTruncated = false,
  framed = true,
}: {
  description: string;
  inputTruncated?: boolean | undefined;
  /** In a box of its own; off where the page around it sets it apart. */
  framed?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4" data-testid="bounty-text">
      {description.trim() === "" ? (
        <p className="text-muted-foreground py-6 text-sm">
          This bounty has no description. A bounty with no spec is one a bounty
          cannot safely be priced against.
        </p>
      ) : (
        <div className={framed ? "rounded-md border p-4" : undefined}>
          <Markdown>{description}</Markdown>
        </div>
      )}
      {inputTruncated && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Jira&rsquo;s description was longer than a bounty keeps; the end of it
          is not shown, and the bounty cannot be priced until it is shortened.
        </p>
      )}
    </div>
  );
}
