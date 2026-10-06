/**
 * The pieces the repository page is built from: a block with a heading, a
 * row of figures, a run's status as a badge. Shared by the page and by each
 * builder's result view, so every block carries the same inset and every
 * figure reads the same way.
 *
 * One grid for the insets: a block is padded 16px, what sits inside it
 * (a tile, a card, a row) 12px, so text lands on the same columns block
 * after block rather than drifting a few pixels between them.
 */

import type { AnalysisStatus } from "sandbox-factory";
import { useId, type ComponentProps, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
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

/** A heading inside a block, for the parts of a result. */
export function SubHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
      {children}
    </h3>
  );
}

export interface Stat {
  label: string;
  value: number | string;
}

/**
 * A row of figures, each a tile: the label in the muted ink, the value in
 * the text ink. Numbers are formatted for the locale; a string is shown as
 * given.
 */
export function StatTiles({ stats }: { stats: readonly Stat[] }) {
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="bg-muted/40 flex flex-col gap-1 rounded-[6px] p-3"
        >
          <dt className="text-muted-foreground text-xs">{stat.label}</dt>
          <dd className="text-lg leading-none font-semibold tabular-nums">
            {typeof stat.value === "number"
              ? stat.value.toLocaleString()
              : stat.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A run's status, coloured: only a failure is loud. */
export function StatusBadge({
  status,
  className,
}: {
  status: AnalysisStatus;
  className?: string;
}) {
  return (
    <Badge
      variant={
        status === "failed"
          ? "destructive"
          : status === "succeeded"
            ? "default"
            : "secondary"
      }
      className={cn("rounded-[4px]", className)}
    >
      {statusLabels[status]}
    </Badge>
  );
}

/** A path, as a chip in monospace. */
export function PathChip({ children }: { children: ReactNode }) {
  return (
    <li className="bg-muted max-w-full truncate rounded-[4px] px-1.5 py-0.5 font-mono text-xs">
      {children}
    </li>
  );
}

/** A note that a summary was cut short, and where the whole is. */
export function TruncatedNote({ whole }: { whole: string }) {
  return (
    <p className="text-muted-foreground text-xs">
      This summary was truncated; the whole is in {whole}.
    </p>
  );
}
