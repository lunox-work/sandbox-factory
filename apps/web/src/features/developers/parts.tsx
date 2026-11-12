/**
 * The small pieces the portal's lists share: a row's facts, and its scopes
 * as chips.
 */

import { cn } from "@/lib/utils";

/** One fact in a row's `dl`: "Last used Oct 5, 2026". */
export function Meta({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex gap-1">
      <dt>{term}</dt>
      <dd className="text-foreground/80">{value}</dd>
    </div>
  );
}

/** Scopes or tool names as mono chips; `describe` titles each. */
export function Chips({
  label,
  items,
  describe,
  className,
}: {
  label: string;
  items: readonly string[];
  describe?: ((item: string) => string | undefined) | undefined;
  className?: string;
}) {
  return (
    <ul aria-label={label} className={cn("flex flex-wrap gap-1", className)}>
      {items.map((item) => (
        <li
          key={item}
          title={describe?.(item)}
          className="bg-muted rounded-sm px-1.5 font-mono text-2xs leading-5"
        >
          {item}
        </li>
      ))}
    </ul>
  );
}
