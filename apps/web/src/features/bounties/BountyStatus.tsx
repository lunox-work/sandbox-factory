/**
 * How far a bounty has got, said one way everywhere: its status is the last
 * of its three steps done (`bountyStatus`), and each status has one name,
 * one sentence and one mark. The list's Status column, its filter and a
 * bounty's details all read from here.
 *
 * The mark is a ring that fills a third for each step done: empty and
 * dashed for a new bounty, a third for one scoped, two for one priced, and
 * whole, in green, for one live.
 */

import type {
  BountyStatusCountsDto,
  BountySummaryDto,
} from "@sandbox-factory/shared";
import { ChevronRight } from "lucide-react";
import { Fragment, useLayoutEffect, useRef, useState } from "react";
import {
  BOUNTY_STATUSES,
  bountyStatus,
  type BountyStatus,
} from "sandbox-factory";

import { cn } from "@/lib/utils";

export const STATUS_META: Record<
  BountyStatus,
  { label: string; meaning: string; steps: number }
> = {
  new: { label: "New", meaning: "No step approved yet", steps: 0 },
  scoped: { label: "Scoped", meaning: "Its scope is approved", steps: 1 },
  priced: { label: "Priced", meaning: "Its price is approved", steps: 2 },
  live: {
    label: "Live",
    meaning: "Its sandbox is published to contributors",
    steps: 3,
  },
};

/** A bounty's status, from what its list row carries. */
export function statusOf(bounty: BountySummaryDto): BountyStatus {
  return bountyStatus(bounty);
}

/** The status's mark: a ring filled a third for each step done. */
export function StatusMark({
  status,
  className,
}: {
  status: BountyStatus;
  className?: string;
}) {
  const { steps } = STATUS_META[status];
  // The arc from twelve o'clock, a third of the way round for each step.
  const angle = (steps / 3) * 2 * Math.PI;
  const x = 7 + 4 * Math.sin(angle);
  const y = 7 - 4 * Math.cos(angle);
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden="true"
      focusable="false"
      className={cn(
        "size-3.5 shrink-0",
        status === "new" && "text-muted-foreground",
        status === "scoped" && "text-foreground/70",
        status === "priced" && "text-foreground",
        status === "live" && "text-emerald-600 dark:text-emerald-400",
        className,
      )}
    >
      <circle
        cx="7"
        cy="7"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray={steps === 0 ? "2 2" : undefined}
      />
      {steps === 3 ? (
        <circle cx="7" cy="7" r="4" fill="currentColor" />
      ) : (
        steps > 0 && (
          <path
            d={`M7 7 L7 3 A4 4 0 ${steps > 1.5 ? 1 : 0} 1 ${x.toFixed(3)} ${y.toFixed(3)} Z`}
            fill="currentColor"
          />
        )
      )}
    </svg>
  );
}

/**
 * A bounty's status as its row and its details say it: the mark and the
 * name, and, while a price waits on a decision past it, that it does.
 */
export function StatusLabel({
  status,
  pricePending = false,
}: {
  status: BountyStatus;
  /** A price is proposed and not yet approved. */
  pricePending?: boolean;
}) {
  const { label, meaning } = STATUS_META[status];
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5 text-xs"
      title={meaning}
      data-status={status}
    >
      <StatusMark status={status} />
      <span
        className={cn(
          "font-medium",
          status === "new" && "text-muted-foreground font-normal",
        )}
      >
        {label}
      </span>
      {pricePending && (
        <span className="text-muted-foreground truncate">· price pending</span>
      )}
    </span>
  );
}

/** Where the highlight sits under the pressed status, and whether it slides there. */
interface Highlight {
  left: number;
  width: number;
  shown: boolean;
  /** It moves from where it was; appearing, it fades in where it lands. */
  slides: boolean;
}

/**
 * Narrows the list to the bounties that far along: the four statuses side
 * by side, in their order, so the whole way a bounty goes reads at once.
 * One pressed narrows to it; pressed again, the list is every bounty. Each
 * says how many stand there, once the counts are read.
 *
 * The pressed one sits on a highlight that slides from one to the next,
 * so the eye follows the choice rather than finding it again.
 */
export function StatusFilter({
  counts,
  selected,
  onSelect,
}: {
  counts: BountyStatusCountsDto | undefined;
  selected: BountyStatus | null;
  onSelect: (status: BountyStatus | null) => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  // Measured before paint, and again whenever a count changes a width.
  useLayoutEffect(() => {
    const element = bar.current;
    if (element === null) return;
    const place = () => {
      const target =
        selected === null
          ? null
          : element.querySelector<HTMLElement>(
              `[data-status-option="${selected}"]`,
            );
      setHighlight((previous) =>
        target === null
          ? // Let go, it fades where it was.
            previous === null
            ? null
            : { ...previous, shown: false }
          : {
              // To the fraction of a pixel, from inside the bar's border,
              // where the highlight is placed from.
              left:
                target.getBoundingClientRect().left -
                element.getBoundingClientRect().left -
                element.clientLeft,
              width: target.getBoundingClientRect().width,
              shown: true,
              slides: previous?.shown === true,
            },
      );
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => observer.disconnect();
  }, [selected, counts]);

  return (
    <div
      ref={bar}
      role="group"
      aria-label="Status"
      data-testid="status-filter"
      className="bg-card relative inline-flex h-8 max-w-full min-w-0 items-stretch rounded-md border p-0.5 text-sm shadow-xs"
    >
      {highlight !== null && (
        <span
          aria-hidden="true"
          className="bg-muted ring-border/60 pointer-events-none absolute inset-y-0.5 left-0 rounded-[4px] ring-1 duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none"
          style={{
            width: highlight.width,
            transform: `translateX(${highlight.left}px)`,
            opacity: highlight.shown ? 1 : 0,
            transitionProperty: highlight.slides
              ? "transform, width, opacity"
              : "opacity",
          }}
        />
      )}
      {BOUNTY_STATUSES.map((status, index) => {
        const pressed = selected === status;
        const { label, meaning } = STATUS_META[status];
        const count = counts?.statuses[status];
        return (
          <Fragment key={status}>
            {index > 0 && (
              <ChevronRight
                aria-hidden="true"
                className="text-muted-foreground/60 relative size-3 shrink-0 self-center"
              />
            )}
            <button
              type="button"
              data-status-option={status}
              aria-pressed={pressed}
              title={pressed ? "Show every status" : meaning}
              onClick={() => onSelect(pressed ? null : status)}
              className={cn(
                "relative flex min-w-0 items-center gap-1.5 rounded-[4px] px-2 font-medium transition-colors duration-200 outline-none",
                "focus-visible:ring-ring/50 focus-visible:ring-[3px]",
                !pressed && "hover:bg-muted/50 hover:text-foreground",
                // While one is chosen, the rest step back.
                selected !== null && !pressed && "text-muted-foreground",
              )}
            >
              <StatusMark
                status={status}
                className={cn(
                  "transition-opacity duration-200",
                  selected !== null && !pressed && "opacity-60",
                )}
              />
              <span className="truncate">{label}</span>
              {count !== undefined && (
                <span
                  data-testid="status-count"
                  className="text-muted-foreground font-normal tabular-nums"
                >
                  {count}
                </span>
              )}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}
