/**
 * A month of days to pick one from, a month at a time. Days before `from`
 * cannot be picked, and the months before its own are not offered.
 *
 * Written here rather than taken from a date-picker package: one month and
 * a click is all a pick needs. Each day is a button named by its full date,
 * so it reads the same to a screen reader as it looks.
 */

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/** Midnight at the start of the day, local time. */
function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function Calendar({
  from,
  onSelect,
  className,
}: {
  /** The first day that may be picked. */
  from: Date;
  /** A day was picked: midnight at its start, local time. */
  onSelect: (day: Date) => void;
  className?: string;
}) {
  const first = startOfDay(from);
  const [month, setMonth] = useState(
    () => new Date(first.getFullYear(), first.getMonth(), 1),
  );
  const today = startOfDay(new Date()).getTime();
  const year = month.getFullYear();
  const index = month.getMonth();
  const days = new Date(year, index + 1, 0).getDate();
  // Blanks before the 1st, so it falls under its weekday.
  const lead = month.getDay();
  const atFirst = year === first.getFullYear() && index === first.getMonth();
  const step = (by: number) => setMonth(new Date(year, index + by, 1));

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center justify-between">
        <button
          type="button"
          aria-label="Previous month"
          disabled={atFirst}
          onClick={() => step(-1)}
          className="hover:bg-accent focus-visible:ring-ring/50 flex size-7 items-center justify-center rounded-md focus-visible:ring-[3px] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40"
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="text-sm font-medium" aria-live="polite">
          {month.toLocaleDateString(undefined, {
            month: "long",
            year: "numeric",
          })}
        </span>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => step(1)}
          className="hover:bg-accent focus-visible:ring-ring/50 flex size-7 items-center justify-center rounded-md focus-visible:ring-[3px] focus-visible:outline-none"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center">
        {WEEKDAYS.map((name) => (
          <span
            key={name}
            aria-hidden="true"
            className="text-muted-foreground flex h-7 items-center justify-center text-xs"
          >
            {name}
          </span>
        ))}
        {Array.from({ length: lead }, (_, blank) => (
          <span key={`blank-${blank}`} aria-hidden="true" />
        ))}
        {Array.from({ length: days }, (_, offset) => {
          const day = new Date(year, index, offset + 1);
          const time = day.getTime();
          return (
            <button
              key={time}
              type="button"
              disabled={time < first.getTime()}
              aria-label={day.toLocaleDateString(undefined, {
                weekday: "long",
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
              onClick={() => onSelect(day)}
              className={cn(
                "hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring/50 flex size-8 items-center justify-center rounded-md text-sm tabular-nums focus-visible:ring-[3px] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40",
                time === today && "border font-semibold",
              )}
            >
              {offset + 1}
            </button>
          );
        })}
      </div>
    </div>
  );
}
