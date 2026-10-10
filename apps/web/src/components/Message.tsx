/**
 * The three ways a page speaks back: a banner when something failed, a line
 * under a form when something was saved, and a line while something is still
 * being read.
 *
 * All three markups existed already, repeated verbatim — the banner at the top
 * of four screens, the saved line under two forms, the loading line in nine
 * places and in three different shapes. Extracted rather than replaced with
 * shadcn's `Alert`, which carries a title, a description and an icon slot that
 * none of these callers fill: the styling here is what the app already looks
 * like.
 */

import { CircleAlert, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { Orb } from "./Orb";

/**
 * A failure at the top of a screen — the load that did not return, the save
 * the server refused.
 *
 * `role="alert"` because it appears in response to something the reader just
 * did, and a screen reader should say so without being asked. Rendered only
 * when there is something to say, so the role is never announced empty.
 */
export function ErrorBanner({
  children,
  className,
  action,
  ...rest
}: {
  children: React.ReactNode;
  className?: string;
  /**
   * What to do about it, at the banner's right: "Try again", mostly. Inside
   * the banner rather than under it, so the remedy reads as part of the
   * failure instead of as the page's next control. Outside the `alert`, or a
   * screen reader would read the button's label as part of the message.
   */
  action?: React.ReactNode;
  /**
   * The rest reaches the message, so a caller can keep the `data-testid` its
   * own tests already look it up by.
   */
} & Omit<React.ComponentProps<"p">, "className" | "children">) {
  return (
    <div
      className={cn(
        "border-destructive/20 bg-destructive/5 text-destructive dark:bg-destructive/10 mt-6 flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm",
        className,
      )}
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p role="alert" className="min-w-0 flex-1 text-pretty" {...rest}>
        {children}
      </p>
      {action !== undefined && (
        <div className="-my-1 flex shrink-0 items-center">{action}</div>
      )}
    </div>
  );
}

/**
 * The "Try again" every failed read offers, sized to sit inside a banner.
 */
export function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="text-foreground h-7"
      onClick={onRetry}
    >
      <RefreshCw />
      Try again
    </Button>
  );
}

/**
 * A read that failed, and the way to read it again. Errors stop tracking
 * until somebody asks deliberately, so the button is the only retry.
 */
export function RetryableError({
  children,
  onRetry,
  className,
}: {
  children: React.ReactNode;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <ErrorBanner
      className={cn("mt-0", className)}
      action={<RetryButton onRetry={onRetry} />}
    >
      {children}
    </ErrorBanner>
  );
}

/**
 * A read that has not answered yet.
 *
 * One shape everywhere, because the app had three: a bare "Loading…", a
 * spinner beside the word, and — on the members list — nothing at all, so an
 * organization looked briefly as though it had no members. A moving orb is
 * what distinguishes "still working" from "finished, and this is the answer".
 * Its plain, breathing one: the library's own ink and its calmest state,
 * because a read is the app waiting, not making anything. The brand's ramp
 * is kept for that, in `ThinkingLine`.
 *
 * `role="status"` rather than `alert`: a screen reader should mention it when
 * the reader is idle, not interrupt to say a list is still arriving. The
 * orb is `aria-hidden`, or it would be announced as an image beside the
 * word it illustrates.
 */
export function LoadingLine({
  children = "Loading…",
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      role="status"
      className={cn(
        "text-muted-foreground flex items-center gap-2 text-sm",
        className,
      )}
    >
      <Orb tone="plain" state="breathing" />
      {children}
    </p>
  );
}

/**
 * The outcome of a form the reader submitted, under the form itself.
 *
 * `role="status"` rather than `alert`: this is the quieter half of the pair,
 * announced politely once the reader is idle. "Saved." interrupting what
 * somebody is typing next would be worse than saying it a moment late.
 *
 * `failed` carries the colour rather than a second component, because the
 * message occupies the same line either way — a rename that was refused
 * replaces "Saved." in place.
 */
export function FormStatus({
  failed,
  children,
  className,
}: {
  failed: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      role="status"
      className={cn(
        "mt-2 text-sm",
        failed ? "text-destructive" : "text-muted-foreground",
        className,
      )}
    >
      {children}
    </p>
  );
}
