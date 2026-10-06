/**
 * The pieces the repository page is built from: a block with a heading, a
 * list flush with its edges, a run's status as a dot and a word.
 *
 * One grid for the insets: a block is padded 16px and so is every row of
 * its list, so text lands on the same column block after block.
 */

import type { AnalysisStatus } from "sandbox-factory";
import { useId, type ComponentProps, type ReactNode } from "react";

import { cn } from "@/lib/utils";

import { statusLabels } from "./labels";

/** A block of the page: a bordered section headed by its name. */
export function Block({
  title,
  description,
  aside,
  children,
  className,
  ...rest
}: {
  title: ReactNode;
  /** Under the name, in the muted ink: what the block is for. */
  description?: ReactNode;
  /** Beside the name, on the right: a badge, an action. */
  aside?: ReactNode;
  children?: ReactNode;
  className?: string;
} & Omit<ComponentProps<"section">, "title">) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className={cn("flex flex-col gap-4 rounded-lg border p-4", className)}
      {...rest}
    >
      <div className="flex flex-col gap-1">
        <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <h2
            id={id}
            className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-semibold"
          >
            {title}
          </h2>
          {aside}
        </div>
        {description !== undefined && (
          <p className="text-muted-foreground text-sm">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

/**
 * A list flush with its block's edges, under its heading: rows divided by
 * the border and each padded as the block is, `px-4`, so text keeps the
 * block's column.
 */
export const FLUSH_LIST = "-mx-4 -mb-4 divide-y border-t";

/**
 * A block's own action, beside its heading or in its footer: quiet, filled
 * rather than outlined, and the same size wherever it sits, so two of them
 * read as a pair.
 */
export const BLOCK_ACTION =
  "text-muted-foreground hover:text-foreground h-7 gap-1.5 rounded-[6px] px-2.5 text-xs has-[>svg]:px-2.5 [&_svg]:size-3.5";

const DOTS: Record<AnalysisStatus, string> = {
  succeeded: "bg-emerald-500",
  failed: "bg-destructive",
  running: "bg-amber-500 animate-pulse motion-reduce:animate-none",
  queued: "bg-muted-foreground/60",
};

/**
 * A run's status as a dot and a word. Quiet but for a failure, whose word
 * is in the destructive ink; null is a builder never run.
 */
export function StatusDot({
  status,
  label,
}: {
  status: AnalysisStatus | null;
  /** In place of the status's own word: "Built" for a builder. */
  label?: string | undefined;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs whitespace-nowrap",
        status === "failed" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          status === null ? "border-muted-foreground/60 border" : DOTS[status],
        )}
      />
      {label ?? (status === null ? "" : statusLabels[status])}
    </span>
  );
}
