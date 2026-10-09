/**
 * A model or an agent at work: the brand's orb beside a line a light sweeps
 * across, and how long it has been at it. Kept apart from `LoadingLine`,
 * whose plain spinner is a page reading what it already has; this one is a
 * wait on something being made.
 */

import { useEffect, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Seconds since `since`, read again each second while mounted. */
export function useElapsed(since: string | number | null | undefined) {
  const start =
    since === null || since === undefined
      ? null
      : typeof since === "number"
        ? since
        : Date.parse(since);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (start === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [start]);
  return start === null || Number.isNaN(start)
    ? null
    : Math.max(0, Math.floor((now - start) / 1_000));
}

/** "0:42", "12:05": minutes and seconds. */
export function clock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function ThinkingOrb({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("thinking-orb", className)} />;
}

/**
 * What is being made, said in one line with the orb before it. With
 * `since`, how long it has taken so far sits at the line's end; with
 * `expected`, what it usually takes is said beside it.
 */
export function ThinkingLine({
  children,
  since,
  expected,
  className,
}: {
  children: ReactNode;
  since?: string | number | null | undefined;
  /** What it usually takes, as said after the clock: "usually ~8 min". */
  expected?: string | undefined;
  className?: string;
}) {
  const elapsed = useElapsed(since);
  return (
    <p
      role="status"
      className={cn("flex min-w-0 items-center gap-2 text-sm", className)}
    >
      <ThinkingOrb />
      <span className="thinking-text min-w-0">{children}</span>
      {elapsed !== null && (
        // Out of the live region: a clock that ticks would be read aloud
        // every second.
        <span
          aria-hidden="true"
          className="text-muted-foreground ml-auto shrink-0 pl-2 text-xs tabular-nums"
          data-testid="thinking-elapsed"
        >
          {clock(elapsed)}
          {expected !== undefined && ` · ${expected}`}
        </span>
      )}
    </p>
  );
}
