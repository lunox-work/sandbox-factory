/**
 * The portal's code: a snippet to paste somewhere else, with a button that
 * copies it. One shape for every quickstart, server URL and secret, so the
 * copy control is always in the same place.
 */

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Copies `text`, and says so for a moment. The clipboard can be refused (an
 * insecure origin, a denied permission); then it says that instead, and the
 * text is still there to select by hand.
 */
export function CopyButton({
  text,
  label = "Copy",
  className,
}: {
  text: string;
  /** The accessible name, which says what is copied: "Copy token". */
  label?: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 1600);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={label}
      title={label}
      className={cn("text-muted-foreground hover:text-foreground", className)}
      onClick={() => void copy()}
    >
      {state === "copied" ? <Check /> : <Copy />}
      <span aria-live="polite" className="text-xs">
        {state === "copied"
          ? "Copied"
          : state === "failed"
            ? "Select to copy"
            : "Copy"}
      </span>
    </Button>
  );
}

/**
 * A snippet with its label (`Terminal`, `~/.cursor/mcp.json`) and a copy
 * button. Scrolls sideways inside itself rather than widening the page.
 */
export function CodeBlock({
  code,
  label,
  copyLabel,
  className,
}: {
  code: string;
  /** Where it goes, above the code. */
  label: string;
  /** The copy button's accessible name; defaults to "Copy" + the label. */
  copyLabel?: string;
  className?: string;
}) {
  return (
    <figure
      className={cn(
        "bg-muted/40 dark:bg-muted/30 min-w-0 overflow-hidden rounded-lg border",
        className,
      )}
    >
      <figcaption className="flex h-9 items-center justify-between gap-2 border-b pr-1 pl-3">
        <span className="text-muted-foreground truncate font-mono text-xs">
          {label}
        </span>
        <CopyButton text={code} label={copyLabel ?? `Copy ${label}`} />
      </figcaption>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-5">
        <code>{code}</code>
      </pre>
    </figure>
  );
}

/** A short value inline, mono, with its copy button beside it: a server URL. */
export function CopyValue({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "bg-muted/40 dark:bg-muted/30 flex min-w-0 items-center gap-2 rounded-md border py-1 pr-1 pl-2.5",
        className,
      )}
    >
      <code className="min-w-0 flex-1 font-mono text-xs break-all">
        {value}
      </code>
      <CopyButton text={value} label={label} />
    </div>
  );
}
