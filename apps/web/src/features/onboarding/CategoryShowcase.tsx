/**
 * The six kinds of work a backlog scan looks for, before there is a backlog
 * to scan.
 *
 * What a workspace with no Jira sees in place of the scan, so the scan is
 * not a promise in the abstract: each kind says why it is worth outsourcing,
 * what the rule checks, and the sort of ticket it turns up. Read from the
 * category registry in `packages/core`, with its default thresholds, so it
 * is the same six a board will be scanned for and cannot drift from them.
 *
 * `compact` is the same list as two short columns, for a page where the scan
 * is a secondary offer under something the workspace already has.
 */

import { resolveCategories } from "sandbox-factory";
import { useId, type ReactNode } from "react";

import { CategoryIcon } from "../../CategoryIcon";

export function CategoryShowcase({
  compact = false,
  title = "What teams outsource",
  description,
  action,
}: {
  compact?: boolean;
  title?: string;
  description?: ReactNode;
  /** The way to find these in a real backlog: connecting Jira, usually. */
  action?: ReactNode;
}) {
  const categories = resolveCategories();
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-4"
      data-testid="category-showcase"
    >
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 id={titleId} className="text-base font-semibold tracking-tight">
            {title}
          </h2>
          {description !== undefined && (
            <p className="text-muted-foreground mt-1 max-w-prose text-sm">
              {description}
            </p>
          )}
        </div>
        {action}
      </header>
      {compact ? (
        <ul className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {categories.map((category) => (
            <li key={category.id} className="flex min-w-0 gap-2.5">
              <CategoryIcon
                category={category.id}
                className="text-muted-foreground mt-0.5 size-4 shrink-0"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">
                  {category.label}
                </span>
                <span className="text-muted-foreground block text-xs">
                  {category.looksFor}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {categories.map((category) => (
            <li
              key={category.id}
              className="flex flex-col gap-3 rounded-lg border p-4"
            >
              <span className="flex items-center gap-2">
                <span className="bg-muted text-foreground grid size-7 shrink-0 place-items-center rounded-md">
                  <CategoryIcon category={category.id} className="size-4" />
                </span>
                <span className="text-sm font-medium">{category.label}</span>
              </span>
              <span className="text-muted-foreground text-sm leading-snug">
                {category.why}
              </span>
              <span className="mt-auto flex flex-col gap-1 border-t pt-3 text-xs">
                <span className="text-muted-foreground">
                  <span className="text-foreground/80 font-medium">
                    Looks for
                  </span>{" "}
                  {category.looksFor.charAt(0).toLowerCase() +
                    category.looksFor.slice(1)}
                </span>
                {/* A made-up title, so it is quoted and never a link. */}
                <span className="text-muted-foreground/80 italic">
                  e.g. &ldquo;{category.example}&rdquo;
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
