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

import type { BountySummaryDto } from "@sandbox-factory/shared";
import {
  BOUNTY_STATUSES,
  bountyStatus,
  type BountyStatus,
} from "sandbox-factory";

import { cn } from "@/lib/utils";

import { FilterSelect } from "./FilterSelect";

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

const ALL_STATUSES = "all";

/** Narrows the list to the bounties that far along. */
export function StatusFilter({
  selected,
  onSelect,
}: {
  selected: BountyStatus | null;
  onSelect: (status: BountyStatus | null) => void;
}) {
  return (
    <FilterSelect
      data-testid="status-filter"
      label="Status"
      searchPlaceholder="Search statuses…"
      value={selected ?? ALL_STATUSES}
      onValueChange={(next) =>
        onSelect(
          next === ALL_STATUSES
            ? null
            : (BOUNTY_STATUSES.find((status) => status === next) ?? null),
        )
      }
      options={[
        {
          value: ALL_STATUSES,
          label: "All statuses",
          icon: <AllMark />,
        },
        ...BOUNTY_STATUSES.map((status) => ({
          value: status,
          label: STATUS_META[status].label,
          // What each means is the row's tooltip; a menu of five reads at
          // a glance without it.
          keywords: [STATUS_META[status].meaning],
          icon: <StatusMark status={status} />,
        })),
      ]}
      icon={selected === null ? <AllMark /> : <StatusMark status={selected} />}
      text={selected === null ? "All statuses" : STATUS_META[selected].label}
      clearLabel="Show every status"
      onClear={selected === null ? undefined : () => onSelect(null)}
    />
  );
}

/** The mark for no status chosen: a plain ring. */
function AllMark() {
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden="true"
      focusable="false"
      className="text-muted-foreground size-3.5 shrink-0"
    >
      <circle
        cx="7"
        cy="7"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}
