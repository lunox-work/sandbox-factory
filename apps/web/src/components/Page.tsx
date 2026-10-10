/**
 * The frame every routed screen sits in, and the header it opens with.
 *
 * One column for every page. Each page used to cap and centre its own `main`,
 * at one of two widths, so moving from the bounty list to settings moved the
 * left edge of everything — trail, heading, content — by 176px. Now the
 * column is the same everywhere and a narrow page only stops short on the
 * right, so the heading is where the eye left it.
 */

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The shared column: capped, centred and padded. The breadcrumb trail is
 * capped and padded with exactly this, which is what lines its first crumb up
 * with the heading under it.
 */
export const PAGE_COLUMN = "mx-auto w-full max-w-5xl px-4 sm:px-6";

/**
 * `wide` fills the column: lists, boards, the bounty page with its sidebar.
 * `narrow` caps the content at a reading width for forms and settings, still
 * starting at the column's left edge.
 */
export type PageWidth = "wide" | "narrow";

export function Page({
  width = "wide",
  className,
  children,
  ...rest
}: {
  width?: PageWidth;
  /** On the content, where a page's own layout (`flex flex-col gap-8`) goes. */
  className?: string;
  children: React.ReactNode;
} & Omit<React.ComponentProps<"main">, "className" | "children">) {
  return (
    <main data-page="" className={cn(PAGE_COLUMN, "py-10 sm:py-14")} {...rest}>
      <div
        className={cn("w-full", width === "narrow" && "max-w-3xl", className)}
      >
        {children}
      </div>
    </main>
  );
}

/**
 * A page's title, what the page is for, and the one or two things it lets
 * you do, which sit at the title's right so they stay in reach however long
 * the page grows.
 */
export function PageHeader({
  title,
  description,
  kicker,
  actions,
  className,
  titleClassName,
  descriptionTestId,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** A line above the title that frames it: home's date. */
  kicker?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  titleClassName?: string;
  /** For a caller whose tests look the description up by it. */
  descriptionTestId?: string;
}) {
  return (
    <header
      className={cn(
        "flex flex-wrap items-start justify-between gap-4",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        {kicker !== undefined && (
          <p className="text-muted-foreground mb-1 text-sm">{kicker}</p>
        )}
        <h1 className={cn("text-title text-balance", titleClassName)}>
          {title}
        </h1>
        {description !== undefined && (
          <p
            className="text-muted-foreground mt-1.5 max-w-prose text-sm text-pretty"
            data-testid={descriptionTestId}
          >
            {description}
          </p>
        )}
      </div>
      {actions !== undefined && (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </header>
  );
}

/**
 * A section of a page that is not a card: its heading, a line on what it
 * holds, and an action at its right.
 */
export function SectionHeader({
  title,
  description,
  actions,
  id,
  as: Heading = "h2",
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** For a `section` that is `aria-labelledby` its heading. */
  id?: string;
  as?: "h2" | "h3";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-end justify-between gap-3",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <Heading id={id} className="text-heading">
          {title}
        </Heading>
        {description !== undefined && (
          <p className="text-muted-foreground mt-1 text-sm text-pretty">
            {description}
          </p>
        )}
      </div>
      {actions !== undefined && (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
