/**
 * The six kinds of work a backlog scan looks for, before there is a backlog
 * to scan.
 *
 * Each kind says why it is worth outsourcing, so the scan is not a promise
 * in the abstract.
 * Read from the category registry in `packages/core`, with its default
 * thresholds, so it is the same six a board will be scanned for and cannot
 * drift from them.
 *
 * A dialog behind an icon at the head of onboarding rather than a section of
 * it: it is reference — what the scan is about — not a step, and the steps
 * are what the page is for.
 */

import { CircleHelp } from "lucide-react";
import { resolveCategories } from "sandbox-factory";
import type { CSSProperties, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

import { CategoryIcon } from "../../CategoryIcon";
import { CategoryScene } from "./CategoryScene";

const TITLE = "What task do teams outsource?";

export function CategoryShowcase({
  description,
}: {
  /** What the six mean for this workspace: what a scan of it would do. */
  description: ReactNode;
}) {
  const categories = resolveCategories();
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={TITLE}
          title={TITLE}
          className="text-muted-foreground hover:text-foreground shrink-0 [&_svg]:size-5"
        >
          <CircleHelp strokeWidth={1.6} />
        </Button>
      </DialogTrigger>
      <DialogContent
        data-testid="category-showcase"
        // Lighter than the default: reference opened over the page, not a
        // decision that has to hold it back. The blur still lifts it off a
        // dark theme.
        overlayClassName="bg-black/25"
        className="flex max-h-[min(48rem,calc(100dvh-4rem))] flex-col gap-5 overflow-y-auto sm:max-w-3xl"
      >
        {/* Room on the right for the close button, which sits over it. */}
        <DialogHeader className="pr-8">
          <DialogTitle>{TITLE}</DialogTitle>
          <DialogDescription className="max-w-prose">
            {description}
          </DialogDescription>
        </DialogHeader>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {categories.map((category, i) => (
            <li
              key={category.id}
              data-category={category.id}
              // The order the cards rise in when the dialog opens.
              style={{ "--n": i } as CSSProperties}
              className="scene-card bg-card flex flex-col overflow-hidden rounded-xl border"
            >
              <CategoryScene category={category.id} />
              <span className="flex flex-1 flex-col items-center gap-2.5 p-4 text-center">
                <span className="flex items-center gap-2.5">
                  <span className="category-chip grid size-7 shrink-0 place-items-center rounded-md">
                    <CategoryIcon category={category.id} className="size-4" />
                  </span>
                  <span className="text-sm font-semibold tracking-tight">
                    {category.label}
                  </span>
                </span>
                <span className="text-muted-foreground text-[0.8125rem] leading-snug">
                  {category.why}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
