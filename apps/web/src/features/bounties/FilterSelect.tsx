/**
 * One filter over the bounty list: what it is set to, in one box that opens
 * the app's `Combobox`. What it narrows by is its name, not shown: each
 * value says it ("All boards", "Paper cuts"). While it is
 * set to anything but its default, an × in the same box clears it, and
 * `end` may add one more control of the filter's own after it.
 *
 * The box is the only edge: the trigger and what follows it are flat inside
 * it, parted by hairlines, so nothing is boxed inside it.
 */

import { ChevronDown, X } from "lucide-react";
import type { ReactNode } from "react";

import { Combobox, type ComboboxOption } from "@/components/Combobox";
import { cn } from "@/lib/utils";

export function FilterSelect({
  label,
  options,
  value,
  onValueChange,
  icon,
  text,
  count,
  searchPlaceholder,
  onClear,
  clearLabel = "Clear",
  end,
  disabled = false,
  align = "start",
  className,
  "data-testid": testId,
}: {
  /** What it filters by: the trigger's and the list's name. */
  label: string;
  options: readonly ComboboxOption[];
  value: string;
  onValueChange: (value: string) => void;
  /** What it is set to, as the trigger shows it. */
  icon?: ReactNode;
  text: string;
  count?: number | undefined;
  searchPlaceholder: string;
  /** Back to the default; absent while it is the default. */
  onClear?: (() => void) | undefined;
  /** What the × does, said for those who cannot see it. */
  clearLabel?: string;
  /** One more part of the box, after the ×: a control of this filter's. */
  end?: ReactNode;
  disabled?: boolean;
  /** Which edge of the box the list lines up with: its end, at a row's end. */
  align?: "start" | "end";
  /** Where it sits in the row. */
  className?: string | undefined;
  "data-testid"?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "bg-card inline-flex h-8 max-w-full min-w-0 items-stretch rounded-md border text-sm shadow-xs transition-[color,box-shadow]",
        "has-[[data-state=open]]:border-ring has-[[data-state=open]]:ring-ring/50 has-[:focus-visible]:border-ring has-[:focus-visible]:ring-ring/50 has-[:focus-visible]:ring-[3px] has-[[data-state=open]]:ring-[3px]",
        disabled && "opacity-50",
        className,
      )}
    >
      <Combobox
        label={label}
        searchPlaceholder={searchPlaceholder}
        value={value}
        onValueChange={onValueChange}
        options={options}
        disabled={disabled}
        align={align}
        trigger={
          <button
            type="button"
            role="combobox"
            aria-label={label}
            className="hover:bg-muted/50 flex min-w-0 items-center gap-1.5 rounded-[inherit] pr-2 pl-2.5 outline-none disabled:cursor-not-allowed [&_svg]:shrink-0"
          >
            {icon}
            <span className="min-w-0 truncate font-medium">{text}</span>
            {count !== undefined && (
              <span className="text-muted-foreground tabular-nums">
                {count}
              </span>
            )}
            <ChevronDown
              aria-hidden="true"
              className="text-muted-foreground size-3.5"
            />
          </button>
        }
      />
      {onClear !== undefined && (
        <button
          type="button"
          aria-label={clearLabel}
          title={clearLabel}
          onClick={onClear}
          className="text-muted-foreground hover:text-foreground hover:bg-muted/50 grid w-7 shrink-0 place-items-center border-l outline-none last:rounded-r-[inherit]"
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      )}
      {end}
    </div>
  );
}
